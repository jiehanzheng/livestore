import { Context, Effect, Exit, Option } from '@livestore/utils/effect'

import { SqliteError } from '../errors.ts'
import type { PersistenceInfo, SqliteDb, SqliteTransactionHost } from '../sqlite-types.ts'
import type { PreparedBindValues } from '../util.ts'
import { attachSourceLifecycle, makeSourceLifecycle } from './lifecycle.ts'
import type { SourceOwner } from './owner.ts'
import {
  copyBindings,
  copyRows,
  fenceSource,
  makeSourceTransaction,
  SourceDbError,
  type SourceBindings,
  type SourceHandle,
  type SourceRow,
} from './role.ts'

type HostedFrame = {
  readonly owner: object
  readonly fiberId: number
  readonly parent: HostedFrame | undefined
  active: boolean
}
class ActiveHostedSourceCallback extends Context.Service<ActiveHostedSourceCallback, HostedFrame>()(
  'SourceDb/HostedCallback',
) {}

/** The host owns native SOURCE and STATE together; another gate here would invert nested host ownership. */
export const makeHostedSource = (
  db: Pick<SqliteDb, 'execute' | 'select' | 'close' | 'debug'>,
  options: { host: SqliteTransactionHost; storageName: string; persistenceInfo?: PersistenceInfo },
): Effect.Effect<SourceOwner> =>
  Effect.gen(function* () {
    const lifecycle = makeSourceLifecycle('durable-object')
    const callbackOwner = {}
    const unavailable = (operation: string) =>
      new SourceDbError({ operation, cause: 'Native SOURCE unavailable or transaction capability expired' })
    const native = <A>(operation: string, action: () => A): Effect.Effect<A, SourceDbError> =>
      Effect.try({ try: action, catch: (cause) => fenceSource(handle, operation, cause) })
    const hosted = <A, E, R>(
      operation: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SourceDbError, R> =>
      options.host.runTransaction(effect).pipe(
        Effect.mapError((cause) => (cause instanceof SqliteError ? fenceSource(handle, operation, cause) : cause)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            // The native host fences after callback/commit failures, including application errors and defects.
            if (Exit.isFailure(exit) === true) fenceSource(handle, operation, exit.cause)
          }),
        ),
      )
    const outsideDescendant = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>, rejectOwningFiber = false) =>
      Effect.gen(function* () {
        const fiberId = yield* Effect.fiberId
        let frame = Option.getOrUndefined(yield* Effect.serviceOption(ActiveHostedSourceCallback))
        while (frame !== undefined) {
          if (
            frame.owner === callbackOwner &&
            frame.active === true &&
            (rejectOwningFiber === true || frame.fiberId !== fiberId)
          )
            return yield* Effect.fail(
              fenceSource(handle, operation, 'SOURCE callback descendant cannot enter its outer owner'),
            )
          frame = frame.parent
        }
        return yield* effect
      })
    const read = <Row extends object = SourceRow>(sql: string, bindings?: SourceBindings) =>
      native('select', () => copyRows(db.select<Row>(sql, copyBindings(bindings) as PreparedBindValues | undefined)))
    const handle: SourceHandle = attachSourceLifecycle(
      {
        select: <Row extends object = SourceRow>(sql: string, bindings?: SourceBindings) =>
          outsideDescendant(
            'select',
            hosted(
              'select',
              Effect.suspend(() =>
                lifecycle.phase === 'open' ? read<Row>(sql, bindings) : Effect.fail(unavailable('select')),
              ),
            ),
          ),
      },
      lifecycle,
    )
    const close = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.gen(function* () {
          lifecycle.epoch++
          lifecycle.phase = 'closing'
          return yield* hosted(
            'close',
            native('close', () => db.close()),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                lifecycle.phase = 'closed'
              }),
            ),
          )
        }),
      ),
    )
    return {
      handle,
      persistence: { kind: 'native-shared-host', host: options.host },
      fresh: undefined,
      image: undefined,
      storageName: options.storageName,
      persistenceInfo: options.persistenceInfo,
      debug: db.debug,
      // Check the caller before the cached physical close moves execution to its memoization fiber.
      close: Effect.uninterruptible(
        outsideDescendant(
          'close',
          Effect.gen(function* () {
            if ((yield* options.host.inTransaction) === true)
              return yield* hosted(
                'close',
                Effect.fail(fenceSource(handle, 'close', 'Cannot close inside its own native transaction')),
              )
            return yield* close
          }),
          true,
        ),
      ),
      write: (use) =>
        outsideDescendant(
          'write',
          hosted(
            'write',
            Effect.gen(function* () {
              if (lifecycle.phase !== 'open') return yield* Effect.fail(unavailable('write'))
              const ownerFiberId = yield* Effect.fiberId
              let active = true
              const frame: HostedFrame = {
                owner: callbackOwner,
                fiberId: ownerFiberId,
                active: true,
                parent: Option.getOrUndefined(yield* Effect.serviceOption(ActiveHostedSourceCallback)),
              }
              const owned = <A>(operation: string, action: () => A) =>
                Effect.gen(function* () {
                  const fiberId = yield* Effect.fiberId
                  if (active === false || fiberId !== ownerFiberId || lifecycle.phase === 'failed')
                    return yield* Effect.fail(unavailable(operation))
                  return yield* native(operation, action)
                })
              const transaction = makeSourceTransaction(handle, {
                execute: (sql, bindings) =>
                  owned('execute', () => db.execute(sql, copyBindings(bindings) as PreparedBindValues | undefined)),
                select: <Row extends object = SourceRow>(sql: string, bindings?: SourceBindings) =>
                  owned('select', () =>
                    copyRows(db.select<Row>(sql, copyBindings(bindings) as PreparedBindValues | undefined)),
                  ),
              })
              return yield* Effect.suspend(() => use(transaction)).pipe(
                Effect.provideService(ActiveHostedSourceCallback, frame),
                Effect.filterOrFail(
                  () => lifecycle.phase !== 'failed',
                  () => unavailable('write'),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    active = false
                    frame.active = false
                  }),
                ),
              )
            }),
          ),
        ),
    } satisfies SourceOwner
  })
