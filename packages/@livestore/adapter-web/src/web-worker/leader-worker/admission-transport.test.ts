import { expect, it } from 'vitest'

import { LegacyStorageFormatError, ProjectionMismatchError } from '@livestore/common'
import { Effect, Layer, RpcClient, RpcGroup, RpcServer, Stream } from '@livestore/utils/effect'
import { BrowserWorker, BrowserWorkerRunner } from '@livestore/utils/effect/browser'

import { dieOnRpcClientErrorStream } from '../common/rpc-worker.ts'
import { LeaderWorkerInnerBootStatusStream, LeaderWorkerInnerOpenSession } from '../common/worker-schema.ts'

it('transports a projection refusal over MessagePort while the owner keeps serving compatible clients', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const channel = new MessageChannel()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          channel.port1.close()
          channel.port2.close()
        }),
      )
      const group = RpcGroup.make(LeaderWorkerInnerOpenSession, LeaderWorkerInnerBootStatusStream)
      const actual = { stateSchemaHash: 'schema-hash', projectionRevision: 'owner-v1' }
      const expected = { ...actual, projectionRevision: 'joining-client-v2' }
      let compatibleRequests = 0
      let ownerEnded = false
      const handlers = group.toLayer({
        BootStatusStream: () =>
          Stream.fail(
            new LegacyStorageFormatError({
              expectedFormatVersion: 7,
              actualFormatVersion: 6,
              storageBase: 'retained-source',
              reason: 'Retained legacy source cannot be opened',
            }),
          ),
        OpenSession: (request) => {
          if (request.expectedProjection.projectionRevision !== actual.projectionRevision) {
            return Stream.fail(new ProjectionMismatchError({ expected: request.expectedProjection, actual }))
          }
          compatibleRequests++
          return Stream.empty
        },
      })
      yield* RpcServer.make(group).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ownerEnded = true
          }),
        ),
        Effect.provide(
          Layer.merge(
            handlers,
            RpcServer.layerProtocolWorkerRunner.pipe(
              Layer.provide(BrowserWorkerRunner.layerMessagePort(channel.port2)),
            ),
          ),
        ),
        Effect.forkScoped,
      )
      const clientContext = yield* Layer.build(
        RpcClient.layerProtocolWorker({ size: 1 }).pipe(Layer.provide(BrowserWorker.layer(() => channel.port1))),
      )
      const client = yield* RpcClient.make(group).pipe(Effect.provide(clientContext))
      const refused = yield* client
        .OpenSession({ expectedProjection: expected, candidate: undefined })
        .pipe(dieOnRpcClientErrorStream, Stream.runDrain, Effect.result)
      expect(refused).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ProjectionMismatchError', expected, actual } })
      const legacy = yield* client.BootStatusStream({}).pipe(dieOnRpcClientErrorStream, Stream.runDrain, Effect.result)
      expect(legacy).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'LegacyStorageFormatError',
          expectedFormatVersion: 7,
          actualFormatVersion: 6,
          storageBase: 'retained-source',
          reason: 'Retained legacy source cannot be opened',
        },
      })
      yield* client
        .OpenSession({ expectedProjection: actual, candidate: undefined })
        .pipe(dieOnRpcClientErrorStream, Stream.runDrain)
      expect(compatibleRequests).toBe(1)
      expect(ownerEnded).toBe(false)
    }).pipe(Effect.scoped),
  ))
