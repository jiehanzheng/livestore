import { expect, it } from 'vitest'

import { StaleRebaseGenerationError } from '@livestore/common'
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  RpcClient,
  RpcGroup,
  RpcServer,
  Stream,
} from '@livestore/utils/effect'
import { BrowserWorker } from '@livestore/utils/effect/browser'

import { isRpcClientError } from '../common/rpc-worker.ts'
import {
  LeaderWorkerInnerOpenSession,
  LeaderWorkerInnerPushToLeader,
  SharedWorkerOpenWriteSession,
  SharedWorkerPushAdmittedWrite,
} from '../common/worker-schema.ts'
import { LeaderWriteUnconfirmed } from '../common/write-admission-errors.ts'
import { makeMessagePortRpcServerProtocol } from '../leader-worker/message-port-rpc-protocol.ts'
import { makeLeaderGenerations } from './leader-generations.ts'

const legacy = RpcGroup.make(LeaderWorkerInnerOpenSession, LeaderWorkerInnerPushToLeader)
const admitted = RpcGroup.make(SharedWorkerOpenWriteSession, SharedWorkerPushAdmittedWrite)

const makeTransport = Effect.gen(function* () {
  const { port1, port2 } = new MessageChannel()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      port1.close()
      port2.close()
    }),
  )
  const client = yield* Layer.build(
    RpcClient.layerProtocolWorker({ size: 1 }).pipe(Layer.provide(BrowserWorker.layer(() => port1))),
  )
  return { client, server: makeMessagePortRpcServerProtocol(port2), port: port1 }
})

const open = {
  expectedProjection: { stateSchemaHash: 'hash', projectionRevision: 'revision' },
  candidate: undefined,
}
const push = { batch: [] }
const writeSessionId = 'nonce'
const expectUnknownTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
  expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(`Unknown request tag: ${tag}`)
}

it('refuses capability-bound frames at the legacy coordinator before handler dispatch', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeTransport
        let requests = 0
        yield* RpcServer.make(legacy).pipe(
          Effect.provide(
            Layer.merge(
              legacy.toLayer({
                OpenSession: () =>
                  Stream.fromEffect(
                    Effect.sync(() => {
                      requests++
                    }),
                  ).pipe(Stream.drain),
                PushToLeader: () =>
                  Effect.sync(() => {
                    requests++
                  }),
              }),
              transport.server,
            ),
          ),
          Effect.forkScoped,
        )
        const client = yield* RpcClient.make(admitted).pipe(Effect.provide(transport.client))

        expectUnknownTag(
          yield* client.OpenWriteSession({ ...open, writeSessionId }).pipe(Stream.runDrain, Effect.exit),
          'OpenWriteSession',
        )
        expectUnknownTag(
          yield* client.PushAdmittedWrite({ ...push, writeSessionId }).pipe(Effect.exit),
          'PushAdmittedWrite',
        )
        expect(requests).toBe(0)
      }),
    ),
  ))

it('refuses legacy frames at the capability-bound coordinator before handler dispatch', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeTransport
        let requests = 0
        yield* RpcServer.make(admitted).pipe(
          Effect.provide(
            Layer.merge(
              admitted.toLayer({
                OpenWriteSession: () =>
                  Stream.fromEffect(
                    Effect.sync(() => {
                      requests++
                    }),
                  ).pipe(Stream.drain),
                PushAdmittedWrite: () =>
                  Effect.sync(() => {
                    requests++
                  }),
              }),
              transport.server,
            ),
          ),
          Effect.forkScoped,
        )
        const client = yield* RpcClient.make(legacy).pipe(Effect.provide(transport.client))

        expectUnknownTag(yield* client.OpenSession(open).pipe(Stream.runDrain, Effect.exit), 'OpenSession')
        expectUnknownTag(yield* client.PushToLeader(push).pipe(Effect.exit), 'PushToLeader')
        expect(requests).toBe(0)
      }),
    ),
  ))

it('classifies a dedicated-hop RpcClientError before any retirement signal as unconfirmed', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeTransport
        const dedicated = RpcGroup.make(LeaderWorkerInnerPushToLeader)
        const entered = yield* Deferred.make<void>()
        const rejected = new StaleRebaseGenerationError({
          currentRebaseGeneration: 2,
          providedRebaseGeneration: 1,
          sessionId: 'stale-rebase',
        })
        let pushCount = 0
        yield* RpcServer.make(dedicated).pipe(
          Effect.provide(
            Layer.merge(
              dedicated.toLayer({
                PushToLeader: () =>
                  Effect.suspend(() =>
                    ++pushCount === 1
                      ? Effect.fail(rejected)
                      : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                  ),
              }),
              transport.server,
            ),
          ),
          Effect.forkScoped,
        )
        const client = yield* RpcClient.make(dedicated).pipe(Effect.provide(transport.client))
        const generations = yield* makeLeaderGenerations<typeof client>()
        const { generation } = yield* generations.reserve('owner', Effect.void)
        yield* generations.publish(generation, client)
        const admitted = yield* Deferred.make<void>()
        yield* generations
          .openSession(
            () => Stream.concat(Stream.succeed('admitted'), Stream.never),
            () => true,
            writeSessionId,
          )
          .pipe(
            Stream.tap(() => Deferred.succeed(admitted, undefined)),
            Stream.runDrain,
            Effect.forkScoped,
          )
        yield* Deferred.await(admitted)

        const rejection = yield* generations
          .runAdmittedWrite(writeSessionId, (owner) => owner.PushToLeader(push))
          .pipe(Effect.exit)
        expect(rejection).toEqual(Exit.fail(rejected))

        let observedRpcClientError = false
        const request = yield* generations
          .runAdmittedWrite(writeSessionId, (owner) =>
            owner.PushToLeader(push).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  observedRpcClientError = isRpcClientError(error)
                }),
              ),
            ),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        transport.port.dispatchEvent(new Event('error'))

        expect(yield* Fiber.await(request)).toEqual(Exit.fail(new LeaderWriteUnconfirmed({})))
        expect(observedRpcClientError).toBe(true)
        expect(yield* Deferred.isDone(generation.retired)).toBe(false)
      }),
    ),
  ))
