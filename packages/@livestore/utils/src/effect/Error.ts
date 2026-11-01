import { Schema } from 'effect'

export class UnknownError extends Schema.TaggedError<UnknownError, { readonly brand: unique symbol }>(
  '~@livestore/utils/UnknownError',
)('UnknownError', {
  cause: Schema.Any,
  payload: Schema.optional(Schema.Any),
}) {}
