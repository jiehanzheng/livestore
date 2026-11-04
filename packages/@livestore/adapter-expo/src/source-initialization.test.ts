import { beforeEach, expect, test, vi } from 'vitest'

import {
  LegacyStorageFormatError,
  liveStoreStorageFormatVersion,
  type AdapterArgs,
  type SyncOptions,
} from '@livestore/common'
import type * as LeaderThread from '@livestore/common/leader-thread'
import { EventSequenceNumber } from '@livestore/common/schema'
import type * as Source from '@livestore/common/source-db'
import { Effect, Exit } from '@livestore/utils/effect'

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), layout: vi.fn(), layer: vi.fn() }))
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: '/sqlite' }))
vi.mock('./source-layout.ts', () => ({ allocateExpoSource: mocks.layout }))
vi.mock('@livestore/common/source-db', async (original) => ({
  ...(await original<typeof Source>()),
  initializeSource: mocks.initialize,
}))
vi.mock('@livestore/common/leader-thread', async (original) => ({
  ...(await original<typeof LeaderThread>()),
  makeLeaderThreadLayer: mocks.layer,
}))
import { createExpoLeader } from './leader.ts'
const args = {
  storeId: 'fixture',
  schema: { state: { sqlite: { hash: 'hash' } }, projectionRevision: 'v1' },
} as unknown as AdapterArgs

const nativeSource = (fresh = false) => {
  let held = true
  const isHeld = () => held
  const close = vi.fn(() => {
    held = false
  })
  return {
    metadata: {
      persistenceInfo: { fileName: '/sqlite/fixture/eventlog.db' },
      sourceLease: { isHeld },
      ...(fresh === false
        ? {}
        : {
            sourceCreation: {
              storageName: '/sqlite/fixture/eventlog.db',
              kind: 'exclusive-expo-source-namespace' as const,
              isHeld,
            },
          }),
    },
    debug: { head: EventSequenceNumber.Client.ROOT },
    execute: vi.fn(),
    select: vi.fn(() => []),
    close,
    export: () => new Uint8Array(),
    import: () => {},
  }
}

beforeEach(() => vi.resetAllMocks())

test('retained proof failure precedes STATE and closes the SOURCE owner with its physical lease', async () => {
  mocks.layout.mockResolvedValue({ kind: 'retained' })
  const refusal = new LegacyStorageFormatError({
    expectedFormatVersion: liveStoreStorageFormatVersion,
    reason: 'missing source identity',
  })
  mocks.initialize.mockReturnValue(Effect.fail(refusal))
  const native = nativeSource(),
    factory = vi.fn(() => Effect.succeed(native))
  const exit = await Effect.runPromiseExit(
    Effect.scoped(createExpoLeader(args, { clientId: 'stable' }, factory as never)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) === true)
    expect(exit.cause.reasons.some((reason) => 'error' in reason && reason.error === refusal)).toBe(true)
  expect(factory).toHaveBeenCalledOnce()
  expect(factory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceOwner: 'exclusive' }))
  const owner: Source.SourceOwner = mocks.initialize.mock.calls[0]![0]
  expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith(owner)
  expect(owner.fresh).toBeUndefined()
  expect(native.close).toHaveBeenCalledOnce()
  expect(native.metadata.sourceLease.isHeld()).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.handle.select('AFTER CLOSE')))).toBe(true)
  expect(native.select).not.toHaveBeenCalled()
})

test('new allocation crosses native open and initialization finishes before STATE acquisition', async () => {
  const allocation = {},
    order: string[] = [],
    native = nativeSource(true)
  mocks.layout.mockResolvedValue({ kind: 'new', allocation })
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
      return Effect.succeed(native)
    })
    .mockImplementationOnce(() => {
      order.push('state')
      return Effect.die(new Error('state failed'))
    })
  await expect(
    Effect.runPromise(Effect.scoped(createExpoLeader(args, { clientId: 'stable' }, factory))),
  ).rejects.toThrow('state failed')
  expect(order).toEqual(['source', 'initialized', 'state'])
  expect(factory.mock.calls[0]![0]).toMatchObject({ sourceOwner: 'exclusive', sourceAllocation: allocation })
  const owner: Source.SourceOwner = mocks.initialize.mock.calls[0]![0]
  expect(owner.fresh).toBeDefined()
  expect(native.close).toHaveBeenCalledOnce()
  expect(native.metadata.sourceLease.isHeld()).toBe(false)
  expect(Exit.isFailure(await Effect.runPromiseExit(owner.handle.select('AFTER CLOSE')))).toBe(true)
})

test('leader forwards the successful owner-bound proof and backend policy unchanged', async () => {
  mocks.layout.mockResolvedValue({ kind: 'retained' })
  const initializedSource = {},
    native = nativeSource(),
    state = { close: vi.fn() }
  mocks.initialize.mockReturnValue(Effect.succeed(initializedSource))
  mocks.layer.mockImplementation(() => {
    throw new Error('SDK boundary')
  })
  const sync: SyncOptions = { backend: vi.fn(), onBackendIdMismatch: 'shutdown', onSyncError: 'shutdown' }
  const factory = vi.fn().mockReturnValueOnce(Effect.succeed(native)).mockReturnValueOnce(Effect.succeed(state))
  await expect(
    Effect.runPromise(Effect.scoped(createExpoLeader(args, { clientId: 'stable', sync }, factory))),
  ).rejects.toThrow('SDK boundary')
  const forwarded = mocks.layer.mock.calls.at(-1)![0]
  expect(forwarded.initializedSource).toBe(initializedSource)
  expect(forwarded.syncOptions).toBe(sync)
  expect(native.close).toHaveBeenCalledOnce()
  expect(native.metadata.sourceLease.isHeld()).toBe(false)
  expect(state.close).toHaveBeenCalledOnce()
})

test('conversion failure closes the acquired native connection and does not initialize or allocate STATE', async () => {
  mocks.layout.mockResolvedValue({ kind: 'new', allocation: {} })
  const native = nativeSource(true)
  native.metadata.sourceCreation!.isHeld = () => false
  const factory = vi.fn(() => Effect.succeed(native))
  const exit = await Effect.runPromiseExit(
    Effect.scoped(createExpoLeader(args, { clientId: 'stable' }, factory as never)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(factory).toHaveBeenCalledOnce()
  expect(mocks.initialize).not.toHaveBeenCalled()
  expect(native.close).toHaveBeenCalledOnce()
  expect(native.metadata.sourceLease.isHeld()).toBe(false)
})
