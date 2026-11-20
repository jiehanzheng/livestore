import { Effect } from 'effect'
import { type ChangeEvent, type FormEvent, useCallback, useState, useTransition } from 'react'

import { useStore } from '@livestore/react'

import { todoStoreOptions } from './store.ts'
import { makeTodoEvent } from './todo-input.ts'

export const CreateTodo = () => {
  const store = useStore(todoStoreOptions)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submitTodo = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      startTransition(async () => {
        setError(null)
        try {
          const todoCreated = await Effect.runPromise(makeTodoEvent(draft))
          store.commit(todoCreated)
          setDraft('')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Could not save the todo.')
        }
      })
    },
    [draft, store, startTransition],
  )
  const changeDraft = useCallback((event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value), [])

  return (
    <form onSubmit={submitTodo}>
      <label>
        New todo <input value={draft} disabled={pending} onChange={changeDraft} />
      </label>
      <button type="submit" disabled={pending}>
        {pending === true ? 'Saving…' : 'Save todo'}
      </button>
      {error === null ? null : <p role="alert">{error}</p>}
    </form>
  )
}
