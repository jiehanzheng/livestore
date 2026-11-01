import { Cause, Effect, Queue, Stream, Option, Schema, type Scope } from '@livestore/utils/effect'

import type { MakeSqliteDb, SqliteDb } from './adapter-types.ts'
import type { ClientSessionLeaderThreadProxy } from './adapter-types.ts'
import type { MigrationsReport } from './defs.ts'
import type { SqliteError } from './errors.ts'
import { AdmittedOwnerEndedError, UnknownError, AdapterError } from './errors.ts'
import * as StateSnapshot from './StateSnapshot.ts'

type Options = {
  candidate: { sqliteDb: SqliteDb; snapshotByteLength: number } | undefined
  expectedProjection: StateSnapshot.ProjectionIdentity
  makeSqliteDb: (input: { _tag: 'in-memory' }) => ReturnType<MakeSqliteDb>
  open: (request: StateSnapshot.AdmissionRequest) => Stream.Stream<StateSnapshot.OpenSessionFrame, AdapterError>
}

/** Waits for atomic owner admission and imports its projection before exposing the session. */
export const openSnapshotSession: (options: Options) => Effect.Effect<
  {
    sqliteDb: SqliteDb
    snapshotByteLength: number
    migrationsReport: MigrationsReport
    pull: Stream.Stream<typeof ClientSessionLeaderThreadProxy.PullItem.Type>
  },
  SqliteError | AdapterError,
  Scope.Scope
> = Effect.fn('adapter-web:openSnapshotSession')(function* ({
  candidate,
  expectedProjection,
  makeSqliteDb,
  open,
}: Options) {
  // Backpressure here and a bounded leader queue prevent an abandoned/importing tab from retaining unlimited history.
  const frames = yield* open({
    expectedProjection,
    candidate: candidate === undefined ? undefined : StateSnapshot.readProvenance(candidate.sqliteDb),
  }).pipe(Stream.toQueue({ capacity: 1 }))
  const admission = yield* Queue.take(frames).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause)
      if (Option.isSome(error) === true && Schema.is(AdapterError)(error.value) === true) {
        return Effect.fail(error.value)
      }
      return Cause.hasInterruptsOnly(cause) === true
        ? Effect.interrupt
        : Effect.die(new Error('Leader lost before snapshot admission', { cause }))
    }),
  )
  if (admission._tag === 'Pull') return yield* Effect.die('Expected snapshot admission before session events')
  const sqliteDb =
    candidate?.sqliteDb ??
    (yield* Effect.acquireRelease(makeSqliteDb({ _tag: 'in-memory' }), (db) => Effect.sync(() => db.close())))
  let snapshotByteLength: number
  if (admission._tag === 'StaleSnapshot') {
    snapshotByteLength = admission.snapshot.byteLength
    yield* Effect.try({
      try: () => sqliteDb.import(admission.snapshot),
      catch: (cause) => UnknownError.make({ cause }),
    })
  } else {
    if (candidate === undefined) return yield* Effect.die('Leader accepted a missing snapshot')
    snapshotByteLength = candidate.snapshotByteLength
  }
  const pull = Stream.fromQueue(frames).pipe(
    Stream.orDie,
    Stream.map((frame) => {
      if (frame._tag !== 'Pull') throw new Error('Duplicate snapshot admission')
      return frame.item
    }),
    // ClientSessionSyncProcessor repeats normally completed pulls. Ownership loss must close, never reattach stale bytes.
    Stream.concat(Stream.die(new AdmittedOwnerEndedError({}))),
  )
  return { sqliteDb, pull, migrationsReport: admission.migrationsReport, snapshotByteLength }
})
