import { Schema } from '@livestore/utils/effect'

export class SnippetBuildError extends Schema.TaggedError<SnippetBuildError, { readonly brand: unique symbol }>()(
  'SnippetBuildError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
    entry: Schema.optional(Schema.String),
    importer: Schema.optional(Schema.String),
  },
) {}
