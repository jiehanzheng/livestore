import { Context, Effect, Layer, Schema } from 'effect'

import { events } from './schema.ts'

export class InvalidTodo extends Schema.TaggedError<InvalidTodo, { readonly brand: unique symbol }>()('InvalidTodo', {
  message: Schema.String,
}) {}

export class TodoText extends Context.Service<
  TodoText,
  {
    normalize: (text: string) => Effect.Effect<string, InvalidTodo>
  }
>()('TodoText') {
  static readonly layer = Layer.succeed(TodoText, {
    normalize: (text) => {
      const normalized = text.trim()
      return normalized.length > 0
        ? Effect.succeed(normalized)
        : Effect.fail(new InvalidTodo({ message: 'Enter a todo before saving.' }))
    },
  })
}

export const makeTodoEvent = (draft: string) =>
  Effect.gen(function* () {
    const service = yield* TodoText
    const text = yield* service.normalize(draft)
    // Record time and identity in the event so replay never calls the clock or RNG.
    return events.todoCreated({ id: crypto.randomUUID(), text, completed: false, createdAt: new Date() })
  }).pipe(Effect.provide(TodoText.layer))
