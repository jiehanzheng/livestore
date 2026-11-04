import { Cause, Context, Effect, Exit, Option, Semaphore } from 'effect'

import {
  attachSourceLifecycle,
  invalidateSourceLifecycle,
  makeSourceLifecycle,
  sourceLifecycle,
  type SourceLifecycle,
} from './lifecycle.ts'

export type SourceValue = null | string | number | bigint | Uint8Array
export type SourceBindings = ReadonlyArray<SourceValue> | Readonly<Record<string, SourceValue>>
export type SourceRow = Readonly<Record<string, SourceValue>>

/**
 * An adapter owns one connection; each promise settles only after its native operation has stopped.
 * SQL comes from trusted SOURCE helpers: this role is an ownership boundary, not a SQL sandbox.
 */
export interface AsyncSourceDriver {
  execute(sql: string, bindings?: SourceBindings): Promise<void>
  select<Row extends object = SourceRow>(sql: string, bindings?: SourceBindings): Promise<ReadonlyArray<Row>>
  export(): Promise<Uint8Array>
  import(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}

export class SourceDbError extends Error {
  readonly _tag = 'SourceDbError'
  readonly operation: string
  override readonly cause: unknown
  constructor({ operation, cause }: { operation: string; cause: unknown }) {
    super(`SOURCE ${operation} failed`)
    this.operation = operation
    this.cause = cause
  }
}

export interface SourceReader {
  select<Row extends object = SourceRow>(
    sql: string,
    bindings?: SourceBindings,
  ): Effect.Effect<ReadonlyArray<Row>, SourceDbError>
}
export interface SourceHandle extends SourceReader {
  readonly [sourceLifecycle]: SourceLifecycle
}
export interface SourceOperations extends SourceReader {
  readonly export: Effect.Effect<Uint8Array, SourceDbError>
}
interface WritableSourceOperations extends SourceReader {
  execute(sql: string, bindings?: SourceBindings): Effect.Effect<void, SourceDbError>
}
const transactionBrand: unique symbol = Symbol('SourceTransaction')
const databaseBrand: unique symbol = Symbol('SourceDb')
export interface SourceTransaction extends WritableSourceOperations, SourceHandle {
  readonly [transactionBrand]: true
}
export interface SourceDb extends SourceOperations, SourceHandle {
  readonly [databaseBrand]: true
  import(bytes: Uint8Array): Effect.Effect<void, SourceDbError>
  transaction<A, E, R>(
    use: (transaction: SourceTransaction) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SourceDbError, R>
  readonly close: Effect.Effect<void, SourceDbError>
}

/** Internal physical-owner constructor; callbacks must expire the capability before releasing their owner frame. */
export const makeSourceTransaction = (source: SourceHandle, operations: WritableSourceOperations): SourceTransaction =>
  attachSourceLifecycle({ ...operations, [transactionBrand]: true as const }, source[sourceLifecycle])

export const normalizeSourceDbError = (operation: string, cause: unknown): SourceDbError =>
  cause instanceof SourceDbError ? cause : new SourceDbError({ operation, cause })

/** Persisted SOURCE invariants are fail-closed even when a caller catches their typed error. */
export const fenceSource = (source: SourceHandle, operation: string, cause: unknown): SourceDbError => {
  source[sourceLifecycle].phase = 'failed'
  invalidateSourceLifecycle(source[sourceLifecycle])
  return normalizeSourceDbError(operation, cause)
}

const copyValue = (value: SourceValue): SourceValue => {
  if (value instanceof Uint8Array) return value.slice()
  if (value === null || ['string', 'number', 'bigint'].includes(typeof value) === true) return value
  throw new Error('Driver returned a non-SQLite value')
}
export const copyBindings = (bindings: SourceBindings | undefined): SourceBindings | undefined =>
  bindings === undefined
    ? undefined
    : Array.isArray(bindings) === true
      ? bindings.map(copyValue)
      : Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, copyValue(value)]))
export const copyRows = <Row extends object>(rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  rows.map(
    (row) =>
      Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, copyValue(value)]))) as Row,
  )

type CallbackFrame = { readonly owner: object; readonly parent: CallbackFrame | undefined; active: boolean }
class ActiveSourceCallback extends Context.Service<ActiveSourceCallback, CallbackFrame>()('SourceDb/ActiveCallback') {}

/** Native calls are joined before interruption propagates; logical cancellation is never native disposal. */
export const makeSourceDb = (driver: AsyncSourceDriver): Effect.Effect<SourceDb> =>
  Effect.gen(function* () {
    const ownerGate = yield* Semaphore.make(1)
    const lifecycle = makeSourceLifecycle()
    let poisoned = false
    const callbackOwner = {}
    const unavailable = (operation: string) =>
      new SourceDbError({ operation, cause: 'SOURCE owner unavailable or transaction expired' })
    const native = <A>(operation: string, action: () => Promise<A>): Effect.Effect<A, SourceDbError> =>
      Effect.uninterruptible(
        Effect.tryPromise({
          try: action,
          catch: (cause) => {
            poisoned = true
            lifecycle.phase = 'failed'
            invalidateSourceLifecycle(lifecycle)
            return new SourceDbError({ operation, cause })
          },
        }),
      )
    const operations = (
      run: <A>(operation: string, action: () => Promise<A>) => Effect.Effect<A, SourceDbError>,
    ): WritableSourceOperations & Pick<SourceDb, 'import' | 'export'> => ({
      execute: (sql, bindings) => run('execute', () => driver.execute(sql, copyBindings(bindings))),
      select: <Row extends object = SourceRow>(sql: string, bindings?: SourceBindings) =>
        run('select', async () => copyRows(await driver.select<Row>(sql, copyBindings(bindings)))),
      export: run('export', async () => (await driver.export()).slice()),
      import: (bytes) => {
        const ownedBytes = bytes.slice()
        return run('import', () => {
          invalidateSourceLifecycle(lifecycle)
          return driver.import(ownedBytes.slice())
        })
      },
    })
    const outsideCallback = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        let frame = Option.getOrUndefined(yield* Effect.serviceOption(ActiveSourceCallback))
        while (frame !== undefined) {
          if (frame.owner === callbackOwner && frame.active === true) {
            lifecycle.phase = 'failed'
            invalidateSourceLifecycle(lifecycle)
            return yield* Effect.fail(unavailable(operation))
          }
          frame = frame.parent
        }
        return yield* effect
      })
    const admit = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        // An import can be queued ahead of this operation without having invalidated its epoch yet.
        const epoch = lifecycle.epoch
        return ownerGate.withPermits(1)(
          Effect.suspend(
            (): Effect.Effect<A, E | SourceDbError, R> =>
              lifecycle.phase !== 'open' || poisoned === true || lifecycle.epoch !== epoch
                ? Effect.fail(unavailable(operation))
                : effect,
          ),
        )
      })
    const outside = operations((operation, action) =>
      outsideCallback(operation, admit(operation, native(operation, action))),
    )
    const close = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.suspend(() => {
          invalidateSourceLifecycle(lifecycle)
          lifecycle.phase = 'closing'
          return ownerGate.withPermits(1)(
            native('close', () => driver.close()).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  lifecycle.phase = 'closed'
                }),
              ),
            ),
          )
        }),
      ),
    )
    const transaction: SourceDb['transaction'] = (use) =>
      outsideCallback(
        'transaction',
        admit(
          'transaction',
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (lifecycle.phase !== 'open' || poisoned === true) return yield* Effect.fail(unavailable('transaction'))
              const transactionGate = yield* Semaphore.make(1)
              let active = true
              const transactionOps = operations((operation, action) =>
                transactionGate.withPermits(1)(
                  Effect.suspend(() =>
                    active === false || poisoned === true || lifecycle.phase === 'failed'
                      ? Effect.fail(unavailable(operation))
                      : native(operation, action),
                  ),
                ),
              )
              const capability: SourceTransaction = {
                select: transactionOps.select,
                execute: transactionOps.execute,
                [transactionBrand]: true,
                [sourceLifecycle]: lifecycle,
              }
              yield* native('begin', () => driver.execute('BEGIN IMMEDIATE'))
              const frame: CallbackFrame = {
                owner: callbackOwner,
                active: true,
                parent: Option.getOrUndefined(yield* Effect.serviceOption(ActiveSourceCallback)),
              }
              // Descendants inherit this live frame; unrelated fibers still wait at the physical owner's gate.
              const body = yield* Effect.exit(
                restore(Effect.suspend(() => use(capability)).pipe(Effect.provideService(ActiveSourceCallback, frame))),
              )
              frame.active = false
              // Expire before draining detached operations: queued or later calls must never enter the next transaction.
              active = false
              return yield* transactionGate.withPermits(1)(
                Effect.gen(function* () {
                  if (Exit.isFailure(body) === true || poisoned === true || lifecycle.phase === 'failed') {
                    const rollback = yield* Effect.exit(native('rollback', () => driver.execute('ROLLBACK')))
                    if (Exit.isFailure(body) === true) {
                      return yield* Effect.failCause(
                        Exit.isFailure(rollback) === true ? Cause.combine(body.cause, rollback.cause) : body.cause,
                      )
                    }
                    if (Exit.isFailure(rollback) === true) return yield* Effect.failCause(rollback.cause)
                    return yield* Effect.fail(unavailable('transaction'))
                  }
                  // A rejected COMMIT can already be durable. Poison rather than rollback/retry an unknown outcome.
                  yield* native('commit', () => driver.execute('COMMIT'))
                  return body.value
                }),
              )
            }),
          ),
        ),
      )
    return {
      select: outside.select,
      export: outside.export,
      import: outside.import,
      [databaseBrand]: true as const,
      [sourceLifecycle]: lifecycle,
      transaction,
      close: Effect.uninterruptible(outsideCallback('close', close)),
    }
  })
