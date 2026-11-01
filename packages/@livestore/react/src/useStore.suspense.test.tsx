import { it as effectIt } from '@effect/vitest'
import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import { type Adapter, OtelLiveDummy, UnknownError } from '@livestore/common'
import { type Store, StoreRegistry, storeOptions } from '@livestore/livestore'
import { env } from '@livestore/utils'
import { type Context, Deferred, Effect, TestClock } from '@livestore/utils/effect'

import { schema, tables } from './__tests__/fixture.tsx'
import { StoreRegistryProvider } from './StoreRegistryContext.tsx'
import { useStore } from './useStore.ts'

type RegistryContext = NonNullable<ConstructorParameters<typeof StoreRegistry>[0]>['context']
type RegistryServices = NonNullable<RegistryContext> extends Context.Context<infer Services> ? Services : never

const Mode = env('REACT_STRICT_MODE') === '1' ? React.StrictMode : React.Fragment
const Tree = ({ registry, children }: { registry: StoreRegistry; children: React.ReactNode }) => (
  <Mode>
    <StoreRegistryProvider storeRegistry={registry}>{children}</StoreRegistryProvider>
  </Mode>
)

const useActionControl = () => {
  const [state, dispatch, pending] = React.useActionState((_previous: string, value: string) => value, 'idle')
  const submit = React.useCallback(() => React.startTransition(() => dispatch('updated')), [dispatch])
  return { state, pending, submit }
}

it('finishes a committed cold suspension without skipping the original promise read', async () => {
  const gate = Deferred.makeUnsafe<void>()
  const base = makeInMemoryAdapter()
  const adapter: Adapter = (args) => Deferred.await(gate).pipe(Effect.flatMap(() => base(args)))
  const options = storeOptions({ storeId: 'controlled-cold-suspension', schema, adapter })
  const registry = new StoreRegistry()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let fallbackCommits = 0
  const Fallback = () => {
    React.useEffect(() => {
      fallbackCommits++
    }, [])
    return <div data-fallback="true">Loading</div>
  }
  const fallback = React.createElement(Fallback)
  const Consumer = ({ name }: { name: string }) => {
    const store = useStore(options)
    const action = useActionControl()
    return (
      <>
        <output data-consumer={name}>{`${store.storeId}:${action.state}:${action.pending}`}</output>
        <button data-action={name} onClick={action.submit}>
          Submit
        </button>
      </>
    )
  }
  try {
    // Use the browser scheduler, rather than wrapping the whole async boot in act().
    // The warning concerns an actual committed fallback followed by a separate retry.
    root.render(
      <Tree registry={registry}>
        <React.Suspense fallback={fallback}>
          <Consumer name="header" />
          <Consumer name="footer" />
        </React.Suspense>
      </Tree>,
    )
    await vi.waitFor(() => expect(fallbackCommits).toBeGreaterThan(0))
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    await vi.waitFor(() => expect(container.querySelectorAll('output')).toHaveLength(2))
    expect(container.querySelector('[data-fallback]')).toBeNull()
    const conditionalUseWarnings = errors.mock.calls
      .flat()
      .filter(
        (value: unknown) => value instanceof Error && value.message.includes('did not call use() when it finished'),
      )
    expect(conditionalUseWarnings).toEqual([])
    container.querySelector<HTMLButtonElement>('[data-action=footer]')?.click()
    await vi.waitFor(() =>
      expect(container.querySelector('[data-consumer=footer]')?.textContent).toContain(':updated:false'),
    )
    expect(errors.mock.calls).toEqual([])
  } finally {
    root.unmount()
    container.remove()
    errors.mockRestore()
    await registry.dispose()
  }
})

it('keeps the promise read when a parent rerenders before the loading promise settles', async () => {
  const gate = Deferred.makeUnsafe<void>()
  const base = makeInMemoryAdapter()
  const adapter: Adapter = (args) => Deferred.await(gate).pipe(Effect.flatMap(() => base(args)))
  const options = storeOptions({ storeId: 'controlled-early-parent-retry', schema, adapter })
  const registry = new StoreRegistry()
  const initial = registry.getOrLoadPromise(options)
  if (!(initial instanceof Promise)) throw new Error('Expected controlled pending boot')
  let settled = false
  void initial.then(() => {
    settled = true
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let fallbackCommits = 0
  let windowObserved = false
  const Fallback = () => {
    React.useEffect(() => {
      fallbackCommits++
    }, [])
    return <div>Loading</div>
  }
  const fallback = React.createElement(Fallback)
  const Consumer = ({ revision }: { revision: number }) => {
    const store = useStore(options)
    const action = useActionControl()
    return (
      <>
        <output>{`${store.storeId}:${revision}:${action.state}:${action.pending}`}</output>
        <button onClick={action.submit}>Submit</button>
      </>
    )
  }
  const render = (revision: number) =>
    root.render(
      <Tree registry={registry}>
        <React.Suspense fallback={fallback}>
          <Consumer revision={revision} />
        </React.Suspense>
      </Tree>,
    )
  try {
    render(0)
    await vi.waitFor(() => expect(fallbackCommits).toBeGreaterThan(0))
    const observer = Effect.runPromise(
      registry.getOrLoad(options).pipe(
        Effect.tap((store) =>
          Effect.sync(() => {
            windowObserved = registry.getOrLoadPromise(options) === store && settled === false
            flushSync(() => render(1))
          }),
        ),
        Effect.scoped,
      ),
    )
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    await observer
    expect(windowObserved).toBe(true)
    await vi.waitFor(() => expect(container.querySelector('output')?.textContent).toContain(':1'))
    expect(
      errors.mock.calls
        .flat()
        .filter(
          (value: unknown) => value instanceof Error && value.message.includes('did not call use() when it finished'),
        ),
    ).toEqual([])
    await initial
    container.querySelector('button')?.click()
    await vi.waitFor(() => expect(container.querySelector('output')?.textContent).toContain(':updated:false'))
    expect(errors.mock.calls).toEqual([])
  } finally {
    root.unmount()
    container.remove()
    errors.mockRestore()
    await registry.dispose()
  }
})

it('keeps warm mounts synchronous, balances retention, and follows A/B/A and registry replacement', async () => {
  const registry = new StoreRegistry()
  const replacement = new StoreRegistry()
  const a = storeOptions({ storeId: 'warm-a', schema, adapter: makeInMemoryAdapter() })
  const b = storeOptions({ storeId: 'warm-b', schema, adapter: makeInMemoryAdapter() })
  await registry.preload(a)
  await registry.preload(b)
  await replacement.preload(a)
  let holds = 0
  let replacementHolds = 0
  const retain = registry.retain.bind(registry)
  const retainReplacement = replacement.retain.bind(replacement)
  const retained = vi.spyOn(registry, 'retain').mockImplementation((options) => {
    const release = retain(options)
    holds++
    return () => {
      holds--
      release()
    }
  })
  const replacementRetained = vi.spyOn(replacement, 'retain').mockImplementation((options) => {
    const release = retainReplacement(options)
    replacementHolds++
    return () => {
      replacementHolds--
      release()
    }
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let fallbackCommits = 0
  let current: Store<typeof schema> | undefined
  const Fallback = () => {
    React.useEffect(() => {
      fallbackCommits++
    }, [])
    return <div>Loading</div>
  }
  const fallback = React.createElement(Fallback)
  const Consumer = ({ options }: { options: typeof a }) => {
    const store = useStore(options)
    const action = useActionControl()
    React.useEffect(() => {
      current = store
    }, [store])
    return (
      <>
        <output>{`${store.storeId}:${action.state}:${action.pending}`}</output>
        <button onClick={action.submit}>Submit</button>
      </>
    )
  }
  const render = (owner: StoreRegistry, options: typeof a) =>
    root.render(
      <Tree registry={owner}>
        <React.Suspense fallback={fallback}>
          <Consumer options={options} />
        </React.Suspense>
      </Tree>,
    )
  try {
    flushSync(() => render(registry, a))
    expect(container.querySelector('output')?.textContent).toContain('warm-a')
    expect(fallbackCommits).toBe(0)
    const first = current
    expect(first).toBeDefined()
    expect(holds).toBe(1)
    container.querySelector('button')?.click()
    await vi.waitFor(() => expect(container.querySelector('output')?.textContent).toContain(':updated:false'))
    flushSync(() => render(registry, b))
    expect(current).not.toBe(first)
    expect(current?.storeId).toBe('warm-b')
    expect(holds).toBe(1)
    flushSync(() => render(registry, a))
    expect(current).toBe(first)
    expect(holds).toBe(1)
    flushSync(() => render(replacement, a))
    expect(current?.storeId).toBe('warm-a')
    expect(current).not.toBe(first)
    expect(current?.query(tables.todos)).toEqual([])
    expect(holds).toBe(0)
    expect(replacementHolds).toBe(1)
    expect(fallbackCommits).toBe(0)
  } finally {
    root.unmount()
    expect(holds).toBe(0)
    expect(replacementHolds).toBe(0)
    retained.mockRestore()
    replacementRetained.mockRestore()
    container.remove()
    await registry.dispose()
    await replacement.dispose()
  }
})

effectIt.layer(OtelLiveDummy)('suspended store lifetime', (it) => {
  it.effect('does not return a remembered store after TTL eviction', () =>
    Effect.gen(function* () {
      const services = yield* Effect.context<RegistryServices>()
      const registry = new StoreRegistry({ context: services, defaultOptions: { unusedCacheTime: 25 } })
      const options = storeOptions({ storeId: 'ttl-store', schema, adapter: makeInMemoryAdapter() })
      const container = document.createElement('div')
      document.body.append(container)
      let root = createRoot(container)
      const mounted: Store<typeof schema>[] = []
      const Consumer = () => {
        const store = useStore(options)
        React.useEffect(() => {
          mounted.push(store)
        }, [store])
        return <output>{store.storeId}</output>
      }
      const render = () =>
        root.render(
          <Tree registry={registry}>
            <React.Suspense fallback={null}>
              <Consumer />
            </React.Suspense>
          </Tree>,
        )
      try {
        render()
        yield* Effect.promise(() => vi.waitFor(() => expect(mounted.length).toBeGreaterThan(0)))
        const first = mounted.at(-1)
        root.unmount()
        yield* Effect.yieldNow
        yield* TestClock.adjust(25)
        mounted.length = 0
        root = createRoot(container)
        render()
        yield* Effect.promise(() => vi.waitFor(() => expect(mounted.length).toBeGreaterThan(0)))
        expect(mounted.at(-1)).not.toBe(first)
        expect(mounted.at(-1)?.query(tables.todos)).toEqual([])
      } finally {
        root.unmount()
        container.remove()
        yield* Effect.promise(() => registry.dispose())
      }
    }),
  )
})

class LoadBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed === true ? <output data-load-error="true">Failed</output> : this.props.children
  }
}

it('preserves asynchronous load errors without an observer-created unhandled rejection', async () => {
  const gate = Deferred.makeUnsafe<void>()
  const failure = UnknownError.make({ cause: new Error('controlled asynchronous failure') })
  const adapter: Adapter = () => Deferred.await(gate).pipe(Effect.andThen(failure))
  const options = storeOptions({ storeId: 'controlled-rejection', schema, adapter })
  const registry = new StoreRegistry()
  const caught: unknown[] = []
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container, {
    onCaughtError: (error) => {
      caught.push(error)
    },
  })
  const Consumer = () => {
    useStore(options)
    return <output>Ready</output>
  }
  const fallback = React.createElement('div', { 'data-pending': 'true' })
  try {
    root.render(
      <Tree registry={registry}>
        <LoadBoundary>
          <React.Suspense fallback={fallback}>
            <Consumer />
          </React.Suspense>
        </LoadBoundary>
      </Tree>,
    )
    await vi.waitFor(() => expect(container.querySelector('[data-pending]')).not.toBeNull())
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    await vi.waitFor(() => expect(container.querySelector('[data-load-error]')).not.toBeNull())
    expect(caught).toContain(failure)
  } finally {
    root.unmount()
    container.remove()
    await registry.dispose()
  }
})
