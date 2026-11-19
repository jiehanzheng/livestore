import { act, type queries, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { expect, it, vi } from 'vitest'

import { makeInMemoryAdapter } from '@livestore/adapter-web'
import type { Adapter } from '@livestore/common'
import { StoreRegistry } from '@livestore/livestore'
import { Effect } from '@livestore/utils/effect'

import { schema } from './__tests__/fixture.tsx'
import { StoreRegistryProvider } from './StoreRegistryContext.tsx'
import { useStore } from './useStore.ts'

it.each([false, true])(
  'changes a first-warm selection while a later use replays (StrictMode: %s)',
  async (strictMode) => {
    const registry = new StoreRegistry()
    const base = makeInMemoryAdapter()
    const warm = { storeId: 'first-mount-warm', schema, adapter: base, disableDevtools: true }
    await registry.preload(warm)
    const gate = Promise.withResolvers<void>()
    const later = Promise.withResolvers<string>()
    const started = vi.fn()
    const delayed: Adapter = (args) =>
      Effect.andThen(
        Effect.promise(() => {
          started()
          return gate.promise
        }),
        base(args),
      )
    const cold = { ...warm, storeId: 'changed-to-cold', adapter: delayed }
    const recovered: unknown[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const Consumer = ({ options }: { options: typeof warm }) => {
      const store = useStore(options)
      const value = React.use(later.promise)
      return <output>{`${store.storeId}/${value}`}</output>
    }
    const tree = (options: typeof warm) => (
      <StoreRegistryProvider storeRegistry={registry}>
        <React.Suspense fallback="waiting-for-resource">
          <Consumer options={options} />
        </React.Suspense>
      </StoreRegistryProvider>
    )
    let unmount: (() => void) | undefined
    try {
      const view = await act(async () =>
        render<typeof queries>(tree(warm), {
          reactStrictMode: strictMode,
          onRecoverableError: (error) => recovered.push(error),
        }),
      )
      unmount = () => view.unmount()
      expect(view.container.textContent).toBe('waiting-for-resource')
      await act(async () => view.rerender(tree(cold)))
      await waitFor(() => expect(started).toHaveBeenCalled())
      await act(async () => later.resolve('unrelated'))
      await act(async () => gate.resolve())
      await waitFor(() => expect(view.container.querySelector('output')?.textContent).toBe('changed-to-cold/unrelated'))
      expect(recovered).toEqual([])
      expect(errors.mock.calls).toEqual([])
    } finally {
      gate.resolve()
      later.resolve('unrelated')
      if (unmount !== undefined) {
        const cleanup = unmount
        await act(async () => cleanup())
      }
      await registry.dispose()
      errors.mockRestore()
    }
  },
)

it.each([false, true])('keeps sequential cold stores distinct (StrictMode: %s)', async (strictMode) => {
  const registry = new StoreRegistry()
  const adapter = makeInMemoryAdapter()
  const first = { storeId: 'sequential-first', schema, adapter, disableDevtools: true }
  const second = { ...first, storeId: 'sequential-second' }
  const initial = { ...first, storeId: 'sequential-initial' }
  await registry.getOrLoadPromise(initial)
  const recovered: unknown[] = []
  const errors = vi.spyOn(console, 'error')
  const Consumer = ({ cold }: { cold: boolean }) => {
    const a = useStore(cold === true ? first : initial)
    const b = useStore(cold === true ? second : initial)
    if (cold === true) expect(a).not.toBe(b)
    return <span data-testid="stores">{`${a.storeId}/${b.storeId}`}</span>
  }
  const tree = (cold: boolean) => (
    <StoreRegistryProvider storeRegistry={registry}>
      <React.Suspense fallback="loading">
        <Consumer cold={cold} />
      </React.Suspense>
    </StoreRegistryProvider>
  )
  const view = await act(async () =>
    render<typeof queries>(tree(false), {
      reactStrictMode: strictMode,
      onRecoverableError: (error) => recovered.push(error),
    }),
  )
  try {
    await act(async () => view.rerender(tree(true)))
    await waitFor(() => expect(view.getByTestId('stores').textContent).toBe('sequential-first/sequential-second'))
    expect(recovered).toEqual([])
    expect(errors).not.toHaveBeenCalled()
  } finally {
    await act(async () => view.unmount())
    await registry.dispose()
    errors.mockRestore()
  }
})

it('preserves the store thenable through a later unrelated suspension', async () => {
  const registry = new StoreRegistry()
  const options = { storeId: 'before-unrelated', schema, adapter: makeInMemoryAdapter(), disableDevtools: true }
  const initial = { ...options, storeId: 'unrelated-initial' }
  await registry.getOrLoadPromise(initial)
  // Already fulfilled but not yet consumed by React: the first use still suspends,
  // then replays immediately with the store promise occupying thenable slot zero.
  const later = Promise.resolve('unrelated')
  const reachedLater = vi.fn()
  const recovered: unknown[] = []
  const errors = vi.spyOn(console, 'error')
  const Consumer = ({ cold }: { cold: boolean }) => {
    const store = useStore(cold === true ? options : initial)
    reachedLater()
    const value = cold === true ? React.use(later) : 'initial'
    return <span data-testid="result">{`${store.storeId}/${value}`}</span>
  }
  const tree = (cold: boolean) => (
    <StoreRegistryProvider storeRegistry={registry}>
      <React.Suspense fallback="loading">
        <Consumer cold={cold} />
      </React.Suspense>
    </StoreRegistryProvider>
  )
  const view = await act(async () =>
    render<typeof queries>(tree(false), { onRecoverableError: (error) => recovered.push(error) }),
  )
  try {
    reachedLater.mockClear()
    await act(async () => view.rerender(tree(true)))
    await waitFor(() => expect(reachedLater).toHaveBeenCalled())
    await waitFor(() => expect(view.getByTestId('result').textContent).toBe('before-unrelated/unrelated'))
    expect(recovered).toEqual([])
    expect(errors).not.toHaveBeenCalled()
  } finally {
    await act(async () => view.unmount())
    await registry.dispose()
    errors.mockRestore()
  }
})
