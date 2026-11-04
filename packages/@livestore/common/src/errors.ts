import { Cause, Effect, Layer, Option, Schema, Stream, Struct } from '@livestore/utils/effect'

import { ProjectionIdentity } from './ProjectionIdentity.ts'
import * as LiveStoreEvent from './schema/LiveStoreEvent/mod.ts'
import { SourceDbError } from './source-db/role.ts'

export class UnknownError extends Schema.TaggedError<UnknownError, { readonly brand: unique symbol }>(
  '~@livestore/common/UnknownError',
)('UnknownError', {
  cause: Schema.Defect(),
  note: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Any),
}) {
  static mapToUnknownError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => (Schema.is(UnknownError)(cause) === true ? cause : new UnknownError({ cause }))),
      Effect.catchDefect((cause) => new UnknownError({ cause })),
    )

  static mapToUnknownErrorLayer = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(
      Layer.catchCause((cause) => {
        const error = Cause.findErrorOption(cause)
        return Option.isSome(error) === true && Schema.is(UnknownError)(error.value) === true
          ? Layer.effectContext<A, UnknownError, never>(Effect.fail(error.value))
          : Layer.effectContext<A, UnknownError, never>(Effect.fail(new UnknownError({ cause: cause })))
      }),
    )

  static mapToUnknownErrorStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    stream.pipe(
      Stream.mapError((cause) => (Schema.is(UnknownError)(cause) === true ? cause : new UnknownError({ cause }))),
    )
}

const materializerHashMismatchNote = 'Please make sure your event materializer is a pure function without side effects.'

export class MaterializerHashMismatchError extends Schema.TaggedError<
  MaterializerHashMismatchError,
  { readonly brand: unique symbol }
>('~@livestore/common/MaterializerHashMismatchError')('MaterializerHashMismatchError', {
  eventName: Schema.String,
  note: Schema.String.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(materializerHashMismatchNote)),
    Schema.withConstructorDefault(Effect.succeed(materializerHashMismatchNote)),
  ),
}) {}

export class IntentionalShutdownCause extends Schema.TaggedError<
  IntentionalShutdownCause,
  { readonly brand: unique symbol }
>('~@livestore/common/IntentionalShutdownCause')('IntentionalShutdownCause', {
  reason: Schema.Literals(['devtools-reset', 'devtools-import', 'adapter-reset', 'manual', 'backend-id-mismatch']),
}) {}

/** The admitted owner ended; callers must reopen rather than reuse its snapshot. */
export class AdmittedOwnerEndedError extends Schema.TaggedError<
  AdmittedOwnerEndedError,
  { readonly brand: unique symbol }
>('~@livestore/common/AdmittedOwnerEndedError')('AdmittedOwnerEndedError', {}) {
  override get message(): string {
    return 'Admitted leader ended; reopen the Store'
  }
}

export class StoreInterrupted extends Schema.TaggedError<StoreInterrupted, { readonly brand: unique symbol }>(
  '~@livestore/common/StoreInterrupted',
)('StoreInterrupted', {
  reason: Schema.String,
}) {}

export class SqliteError extends Schema.TaggedError<SqliteError, { readonly brand: unique symbol }>(
  '~@livestore/common/SqliteError',
)('SqliteError', {
  query: Schema.optional(
    Schema.Struct({
      sql: Schema.String,
      bindValues: Schema.Union([Schema.Record(Schema.String, Schema.Any), Schema.Array(Schema.Any)]),
    }),
  ),
  /** The SQLite result code */
  // code: Schema.optional(Schema.Number),
  // Added string support for Expo SQLite (we should refactor this to have a unified error type)
  code: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
  /** The original SQLite3 error */
  cause: Schema.Defect(),
  note: Schema.optional(Schema.String),
}) {}

export class UnknownEventError extends Schema.TaggedError<UnknownEventError, { readonly brand: unique symbol }>(
  '~@livestore/common/UnknownEventError',
)('UnknownEventError', {
  event: LiveStoreEvent.Client.Encoded.mapFields(Struct.pick(['name', 'args', 'seqNum', 'clientId', 'sessionId'])),
  reason: Schema.Literals(['event-definition-missing', 'materializer-missing']),
  operation: Schema.String,
  note: Schema.optional(Schema.String),
}) {}

export class MaterializeError extends Schema.TaggedError<MaterializeError, { readonly brand: unique symbol }>(
  '~@livestore/common/MaterializeError',
)('MaterializeError', {
  cause: Schema.Union([MaterializerHashMismatchError, SqliteError, UnknownEventError]),
  note: Schema.optional(Schema.String),
}) {}

/** Expected refusal: retained source must never become an empty new-format database. */
export class LegacyStorageFormatError extends Schema.TaggedError<
  LegacyStorageFormatError,
  { readonly brand: unique symbol }
>('~@livestore/common/LegacyStorageFormatError')('LegacyStorageFormatError', {
  expectedFormatVersion: Schema.Finite,
  actualFormatVersion: Schema.optional(Schema.Finite),
  storageBase: Schema.optional(Schema.String),
  reason: Schema.String,
}) {}

/** A joining client may refuse this owner without ending its healthy, differently versioned projection. */
export class ProjectionMismatchError extends Schema.TaggedError<
  ProjectionMismatchError,
  { readonly brand: unique symbol }
>('~@livestore/common/ProjectionMismatchError')('ProjectionMismatchError', {
  expected: ProjectionIdentity,
  actual: ProjectionIdentity,
}) {}

export class LiveDatabaseImportRefusedError extends Schema.TaggedError<
  LiveDatabaseImportRefusedError,
  { readonly brand: unique symbol }
>('~@livestore/common/LiveDatabaseImportRefusedError')('LiveDatabaseImportRefusedError', {
  reason: Schema.String,
}) {}

/** Expected boot/admission refusals remain typed across adapter boundaries. */
export const AdapterError = Schema.Union([
  UnknownError,
  LegacyStorageFormatError,
  ProjectionMismatchError,
  LiveDatabaseImportRefusedError,
])
export type AdapterError = typeof AdapterError.Type

export const toAdapterError = (cause: unknown): AdapterError => {
  const refusal = cause instanceof SourceDbError ? cause.cause : cause
  if (
    Schema.is(UnknownError)(refusal) === true ||
    Schema.is(LegacyStorageFormatError)(refusal) === true ||
    Schema.is(ProjectionMismatchError)(refusal) === true ||
    Schema.is(LiveDatabaseImportRefusedError)(refusal) === true
  )
    return refusal
  return UnknownError.make({ cause })
}

export const mapToAdapterError = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AdapterError, R> =>
  effect.pipe(
    Effect.mapError(toAdapterError),
    Effect.catchDefect((cause) => Effect.fail(toAdapterError(cause))),
  )
