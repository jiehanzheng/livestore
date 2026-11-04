import { beforeEach, expect, test, vi } from 'vitest'

import { SourceIdentity } from '@livestore/common/source-db'
import { type ApplicationBinding, type SourceMaintenanceLocationOwner } from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { Effect } from '@livestore/utils/effect'

import type * as ResourceModule from './resources.ts'
import { fakeDatabase, fakeStatement } from './sqlite-test-support.ts'

const state = vi.hoisted(() => ({
  entries: ['livestore-eventlog@7.db'],
  held: false,
  events: [] as string[],
  open: vi.fn(),
  failClose: false,
  valid: true,
  failList: false,
}))
vi.mock('expo-sqlite', () => ({ openDatabaseSync: state.open }))
vi.mock('expo-file-system', () => {
  class File {
    uri: string
    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = `${typeof parent === 'string' ? parent : parent.uri}${name === undefined ? '' : `/${name}`}`
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1)
    }
  }
  class Directory extends File {
    list() {
      expect(state.held).toBe(true)
      state.events.push('inventory')
      if (state.failList === true) throw new Error('unreadable')
      return state.entries.map((name) => new File(this, name))
    }
    create() {
      throw new Error('Maintenance may not create directories')
    }
  }
  return { Directory, File }
})
vi.mock('./resources.ts', async (original) => {
  const actual = await original<typeof ResourceModule>()
  return {
    ...actual,
    createResourceLedger: () => {
      const ledger = actual.createResourceLedger()
      return {
        ...ledger,
        assertClosed: () => {
          state.events.push('ledger')
          ledger.assertClosed()
        },
      }
    },
  }
})
import { makeExpoSourceMaintenanceOpener } from './source-maintenance.ts'

const binding: ApplicationBinding = {
  operationId: 'expo-retained',
  context: { location: 'actual-app-owned-namespace' },
}
const locationOwner: SourceMaintenanceLocationOwner = {
  run: (_context, effect) =>
    Effect.suspend(() => {
      state.held = true
      state.events.push('location')
      return effect.pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            if (state.failClose === false) {
              state.held = false
              state.events.push('release')
            }
          }),
        ),
      )
    }),
}
const opener = () => makeExpoSourceMaintenanceOpener({ binding, locationOwner, directory: 'file:///retained' })
beforeEach(() => {
  state.entries = ['livestore-eventlog@7.db']
  state.held = false
  state.events = []
  state.failClose = false
  state.valid = true
  state.failList = false
  state.open.mockReset().mockImplementation((_name: string, options: unknown, directory: string) => {
    expect(state.held).toBe(true)
    expect(options).toEqual({ useNewConnection: true })
    expect(directory).toBe('file:///retained')
    state.events.push('open')
    const database = fakeDatabase()
    database.closeSync.mockImplementation(() => {
      state.events.push('close')
      if (state.failClose === true) throw new Error('native close uncertain')
    })
    database.prepareSync.mockImplementation((sql?: string) => {
      const statement = fakeStatement()
      statement.result.getAllSync.mockImplementation(() => {
        if (sql?.includes('sqlite_master') === true)
          return state.valid === true
            ? ['eventlog', '__livestore_sync_status', '__livestore_source_identity'].map((name) => ({ name }))
            : []
        if (sql?.includes('__livestore_source_identity') === true)
          return [{ id: 1, formatVersion: 7, incarnation: 'retained-incarnation' }]
        return []
      })
      return statement
    })
    return { ...database, getFirstSync: () => ({ locking_mode: 'exclusive' }) }
  })
})

test('same native factory validates existing SOURCE and joins exclusive close plus ledger before release', async () => {
  const identity = await Effect.runPromise(
    withRetainedSource(opener(), binding, (source) => {
      expect(source.fresh).toBeUndefined()
      return SourceIdentity.read(source.handle)
    }),
  )
  expect(identity).toEqual({ formatVersion: 7, incarnation: 'retained-incarnation' })
  expect(state.open).toHaveBeenCalledOnce()
  expect(state.open.mock.calls[0]?.[0]).toBe('livestore-eventlog@7.db')
  expect(state.events).toEqual(['location', 'inventory', 'open', 'close', 'ledger', 'release'])
})
for (const kind of ['missing', 'old-format', 'unreadable'] as const)
  test(`retained ${kind} refuses before permissive native open`, async () => {
    if (kind === 'missing') state.entries = []
    if (kind === 'old-format') state.entries = ['livestore-eventlog@6.db']
    if (kind === 'unreadable') state.failList = true
    expect((await Effect.runPromiseExit(withRetainedSource(opener(), binding, () => Effect.void)))._tag).toBe('Failure')
    expect(state.open).not.toHaveBeenCalled()
  })
test('incompatible existing SQLite closes and ledger checks without initialization', async () => {
  state.valid = false
  expect((await Effect.runPromiseExit(withRetainedSource(opener(), binding, () => Effect.void)))._tag).toBe('Failure')
  expect(state.events).toEqual(['location', 'inventory', 'open', 'close', 'ledger', 'release'])
})
test('native close and ledger uncertainty cannot yield a closed receipt or release app ownership', async () => {
  state.failClose = true
  expect((await Effect.runPromiseExit(withRetainedSource(opener(), binding, () => Effect.void)))._tag).toBe('Failure')
  expect(state.events).toEqual(['location', 'inventory', 'open', 'close', 'ledger'])
  expect(state.held).toBe(true)
})
