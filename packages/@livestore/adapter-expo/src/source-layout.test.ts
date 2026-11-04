import { beforeEach, expect, test, vi } from 'vitest'

import { liveStoreStorageFormatVersion, LegacyStorageFormatError, type AdapterArgs } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { Effect } from '@livestore/utils/effect'
const releaseSchema = makeSchema({
  projectionRevision: 'adapter-expo-fixture-v1',
  events: {},
  state: State.SQLite.makeState({ tables: {}, materializers: {} }),
})

const fs = vi.hoisted(() => ({
  entries: new Map<string, { name: string; kind: 'file' | 'directory'; uri?: string }[]>(),
  errors: new Map<string, Error>(),
  creates: vi.fn(),
  creationError: undefined as Error | undefined,
  legacyCreates: vi.fn(),
}))
vi.mock('expo-file-system/legacy', () => ({ makeDirectoryAsync: fs.legacyCreates }))
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: '/sqlite' }))
vi.mock('expo-file-system', () => {
  const uri = (parts: (string | { uri: string })[]) => {
    const value = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/')
    return `file:///${value
      .replace(/^file:\/\//, '')
      .replace(/\/+/g, '/')
      .replace(/^\//, '')
      .replace(/\/$/, '')}`
  }
  class File {
    uri: string
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts)
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1)
    }
  }
  class Directory extends File {
    get exists(): never {
      throw new Error('exists cannot authorize absence')
    }
    create(options: unknown) {
      fs.creates(this.uri, options)
      if (fs.creationError !== undefined) throw fs.creationError
      if (fs.entries.has(this.uri) === false) fs.entries.set(this.uri, [])
    }
    list(): (File | Directory)[] {
      if (fs.errors.has(this.uri) === true) throw fs.errors.get(this.uri)
      const rows = fs.entries.get(this.uri)
      if (rows === undefined) throw new Error('Directory is unreadable')
      return rows.map((row) => new (row.kind === 'directory' ? Directory : File)(row.uri ?? `${this.uri}/${row.name}`))
    }
  }
  return { Directory, File }
})
import { createExpoLeader } from './leader.ts'
import { expoPersistencePaths } from './paths.ts'
import { allocateExpoSource, prepareExpoSourceLayout } from './source-layout.ts'

const root = 'file:///sqlite',
  target = `${root}/fixture`
const source = `livestore-eventlog@${liveStoreStorageFormatVersion}.db`
const paths = () => expoPersistencePaths('fixture', releaseSchema)
const file = (name: string) => ({ name, kind: 'file' as const })
beforeEach(() => {
  fs.entries.clear()
  fs.errors.clear()
  fs.creates.mockClear()
  fs.creationError = undefined
  fs.legacyCreates.mockReset()
  fs.legacyCreates.mockImplementation(async (uri: string, options: { intermediates: boolean }) => {
    expect(options).toEqual({ intermediates: false })
    if (fs.entries.has(uri) === true) throw new Error('Native target already exists')
    const parent = uri.slice(0, uri.lastIndexOf('/'))
    fs.entries.get(parent)?.push({ name: uri.slice(uri.lastIndexOf('/') + 1), kind: 'directory' })
    fs.entries.set(uri, [])
  })
})
const retained = function (rows: { name: string; kind: 'file' | 'directory'; uri?: string }[]) {
  fs.entries.set(root, [{ name: 'fixture', kind: 'directory' }])
  fs.entries.set(target, rows)
}

test('declared base creation is idempotent; absence follows successful enumeration only', () => {
  expect(prepareExpoSourceLayout(paths())).toEqual({ sourceIsNew: true })
  expect(fs.creates).toHaveBeenCalledExactlyOnceWith(root, { intermediates: true, idempotent: true })
  retained([])
  expect(prepareExpoSourceLayout(paths())).toEqual({ sourceIsNew: true })
})
test('current source preserves unrelated opaque files and sidecars', () => {
  retained([file(source), file(`${source}-wal`), file('opaque-backup')])
  const before = [...fs.entries].map(([key, rows]) => [key, rows.map((row) => ({ ...row }))])
  expect(prepareExpoSourceLayout(paths())).toEqual({ sourceIsNew: false })
  expect([...fs.entries]).toEqual(before)
})
test('nested configured children are traversed only within the declared base', () => {
  fs.entries.set(root, [{ name: 'graphs', kind: 'directory' }])
  fs.entries.set(`${root}/graphs`, [])
  expect(
    prepareExpoSourceLayout(expoPersistencePaths('fixture', releaseSchema, { subDirectory: 'graphs/nested' })),
  ).toEqual({ sourceIsNew: true })
  expect([...fs.entries.keys()]).toEqual([root, `${root}/graphs`])
})
test.each([
  ['ambiguous source sibling', [file(source), file('livestore-eventlog@unknown')]],
  ['old source only', [file(`livestore-eventlog@${liveStoreStorageFormatVersion - 1}.db`)]],
  ['mixed source', [file(source), file(`livestore-eventlog@${liveStoreStorageFormatVersion - 1}.db-wal`)]],
  ['derived only', [file(paths().stateDatabaseName)]],
  ['orphan current sidecar', [file(`${source}-wal`)]],
  ['unknown retained data', [file('unknown')]],
  ['source is directory', [{ name: source, kind: 'directory' as const }]],
] as const)('%s refuses before either actual leader database factory', async (_name, rows) => {
  retained([...rows])
  const before = [...fs.entries].map(([key, rows]) => [key, rows.map((row) => ({ ...row }))])
  const factory = vi.fn()
  const args = { storeId: 'fixture', schema: releaseSchema } as unknown as AdapterArgs
  await expect(
    Effect.runPromise(Effect.scoped(createExpoLeader(args, { clientId: 'fixture' }, factory as never))),
  ).rejects.toThrow()
  expect(factory).not.toHaveBeenCalled()
  expect([...fs.entries]).toEqual(before)
})
test.each([root, target])('unreadable %s never becomes absence or creates a database', async (directory) => {
  retained([])
  const cause = new Error('Permission denied')
  fs.errors.set(directory, cause)
  const factory = vi.fn()
  expect(() => prepareExpoSourceLayout(paths())).toThrow(cause)
  const args = { storeId: 'fixture', schema: releaseSchema } as unknown as AdapterArgs
  await expect(
    Effect.runPromise(Effect.scoped(createExpoLeader(args, { clientId: 'fixture' }, factory as never))),
  ).rejects.toThrow()
  expect(factory).not.toHaveBeenCalled()
})
test('a configured child occupied by a file is refused', () => {
  fs.entries.set(root, [file('fixture')])
  expect(() => prepareExpoSourceLayout(paths())).toThrow(LegacyStorageFormatError)
})

test('declared base creation failure refuses before source or state IO', async () => {
  fs.creationError = new Error('base cannot be established')
  const factory = vi.fn(),
    before = [...fs.entries].map(([key, rows]) => [key, rows.map((row) => ({ ...row }))])
  const args = { storeId: 'fixture', schema: releaseSchema } as unknown as AdapterArgs
  const { Cause, Exit } = await import('@livestore/utils/effect')
  const exit = await Effect.runPromiseExit(
    Effect.scoped(createExpoLeader(args, { clientId: 'fixture' }, factory as never)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit) === true) expect(Cause.pretty(exit.cause)).toContain('base cannot be established')
  expect(factory).not.toHaveBeenCalled()
  expect([...fs.entries]).toEqual(before)
})

test('only successful exact legacy mkdir issues a new allocation; retained empty namespace refuses', async () => {
  const result = await allocateExpoSource(paths())
  expect(result.kind).toBe('new')
  expect(fs.legacyCreates).toHaveBeenCalledExactlyOnceWith(target, { intermediates: false })
  await expect(allocateExpoSource(paths())).rejects.toMatchObject({
    reason: expect.stringContaining('Retained native namespace'),
  })
  expect(fs.legacyCreates).toHaveBeenCalledTimes(1)
})

test('retained source returns no allocation and does not invoke namespace creation', async () => {
  retained([file(source), file('opaque-backup')])
  expect(await allocateExpoSource(paths())).toEqual({ kind: 'retained' })
  expect(fs.legacyCreates).not.toHaveBeenCalled()
})

test('native creation failure cannot become freshness or a fallback retained open', async () => {
  fs.legacyCreates.mockRejectedValueOnce(new Error('competing creator or native uncertainty'))
  await expect(allocateExpoSource(paths())).rejects.toThrow('competing creator or native uncertainty')
  expect(fs.legacyCreates).toHaveBeenCalledTimes(1)
  expect(fs.entries.has(target)).toBe(false)
})
