import { expect, test, vi } from 'vitest'

import {
  LegacyStorageFormatError,
  liveStoreStorageFormatVersion,
  type AdapterArgs,
  type SyncOptions,
} from '@livestore/common'
import type * as LeaderThread from '@livestore/common/leader-thread'
import { Effect, Exit } from '@livestore/utils/effect'
const mocks = vi.hoisted(() => ({ initialize: vi.fn(), layout: vi.fn(), layer: vi.fn() }))
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: '/sqlite' }))
vi.mock('./source-layout.ts', () => ({ prepareExpoSourceLayout: mocks.layout }))
vi.mock('@livestore/common/leader-thread', async (original) => {
  const real = await original<typeof LeaderThread>()
  return {
    ...real,
    makeLeaderThreadLayer: mocks.layer,
    Eventlog: { ...real.Eventlog, initializeSource: mocks.initialize },
  }
})
import { createExpoLeader } from './leader.ts'
const args = {
  storeId: 'fixture',
  schema: { state: { sqlite: { hash: 'hash' } }, projectionRevision: 'v1' },
} as unknown as AdapterArgs

test('source proof failure precedes state factory and preserves typed refusal', async () => {
  mocks.layout.mockReturnValue({ sourceIsNew: false })
  const refusal = new LegacyStorageFormatError({
    expectedFormatVersion: liveStoreStorageFormatVersion,
    reason: 'missing source identity',
  })
  mocks.initialize.mockReturnValue(Effect.fail(refusal))
  const close = vi.fn(),
    source = { close },
    factory = vi.fn(() => Effect.succeed(source))
  const exit = await Effect.runPromiseExit(
    Effect.scoped(createExpoLeader(args, { clientId: 'stable' }, factory as never)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) === true)
    expect(exit.cause.reasons.some((reason) => 'error' in reason && reason.error === refusal)).toBe(true)
  expect(factory).toHaveBeenCalledOnce()
  expect(mocks.initialize).toHaveBeenLastCalledWith(source, { sourceIsNew: false })
  expect(close).toHaveBeenCalledOnce()
})

test('source initialization finishes before derived acquisition; derived failure closes source once', async () => {
  const order: string[] = [],
    close = vi.fn()
  mocks.layout.mockReturnValue({ sourceIsNew: true })
  mocks.initialize.mockImplementation(() =>
    Effect.sync(() => {
      order.push('initialized')
      return {}
    }),
  )
  const factory = vi
    .fn()
    .mockImplementationOnce(() => {
      order.push('source')
      return Effect.succeed({ close })
    })
    .mockImplementationOnce(() => {
      order.push('state')
      return Effect.die(new Error('state failed'))
    })
  await expect(
    Effect.runPromise(Effect.scoped(createExpoLeader(args, { clientId: 'stable' }, factory))),
  ).rejects.toThrow('state failed')
  expect(order).toEqual(['source', 'initialized', 'state'])
  expect(close).toHaveBeenCalledOnce()
})

test('actual leader forwards same DB-bound source context and fail-closed backend options', async () => {
  mocks.layout.mockReturnValue({ sourceIsNew: false })
  const initializedSource = {},
    source = { close: vi.fn() },
    state = { close: vi.fn() }
  mocks.initialize.mockReturnValue(Effect.succeed(initializedSource))
  mocks.layer.mockImplementation(() => {
    throw new Error('SDK boundary')
  })
  const sync: SyncOptions = { backend: vi.fn(), onBackendIdMismatch: 'shutdown', onSyncError: 'shutdown' }
  const factory = vi.fn().mockReturnValueOnce(Effect.succeed(source)).mockReturnValueOnce(Effect.succeed(state))
  await expect(
    Effect.runPromise(Effect.scoped(createExpoLeader(args, { clientId: 'stable', sync }, factory))),
  ).rejects.toThrow('SDK boundary')
  expect(mocks.initialize).toHaveBeenLastCalledWith(source, { sourceIsNew: false })
  const forwarded = mocks.layer.mock.calls.at(-1)![0]
  expect(forwarded.initializedSource).toBe(initializedSource)
  expect(forwarded.syncOptions).toBe(sync)
  expect(source.close).toHaveBeenCalledOnce()
  expect(state.close).toHaveBeenCalledOnce()
})
