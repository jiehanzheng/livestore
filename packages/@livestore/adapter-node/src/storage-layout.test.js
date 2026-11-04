import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { liveStoreStorageFormatVersion } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import { sqliteDbFactory } from '@livestore/sqlite-wasm/node'
import { Cause, Effect, Exit } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { openDatabases } from './storage.ts'
const current = `eventlog@${liveStoreStorageFormatVersion}.db`
const old = `eventlog@${liveStoreStorageFormatVersion - 1}.db`
const schema = makeSchema({
  projectionRevision: 'adapter-node-fixture-v1',
  events: {},
  state: State.SQLite.makeState({ tables: {}, materializers: {} }),
})
const fixture = async function (operation) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'node-layout-'))
  try {
    await operation(base, path.join(base, 'replica'))
  } finally {
    vi.restoreAllMocks()
    await fs.rm(base, { recursive: true, force: true })
  }
}
const args = { storeId: 'replica', schema }
const execute = (base, factory) =>
  Effect.runPromise(Effect.scoped(openDatabases(args, { type: 'fs', baseDirectory: base }, factory)))
const failure = async (base, factory) => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(openDatabases(args, { type: 'fs', baseDirectory: base }, factory)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  return Cause.pretty(exit.cause)
}
// Layout tests keep real allocation/adoption and SOURCE initialization; only call/close observation is substituted.
const observedFactory = async (opened = () => {}, closed = () => {}) => {
  const sqlite3 = await loadSqlite3Wasm()
  const native = await Effect.runPromise(
    sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
  )
  return vi.fn((input) => {
    opened(input)
    return native(input).pipe(
      Effect.provide(PlatformNode.NodeFileSystem.layer),
      Effect.map((db) => ({
        ...db,
        close: () => {
          db.close()
          closed(input)
        },
      })),
    )
  })
}

const bytes = async function (directory) {
  const result = []
  for (const name of (await fs.readdir(directory)).sort()) {
    const stat = await fs.lstat(path.join(directory, name))
    result.push([
      name,
      stat.isSymbolicLink() === true
        ? await fs.readlink(path.join(directory, name))
        : stat.isFile() === true
          ? await fs.readFile(path.join(directory, name), 'hex')
          : 'directory',
    ])
  }
  return result
}

test.each([
  ['old-only', [old]],
  ['ambiguous source sibling', [current, 'eventlog@unknown']],
  ['mixed', [current, old]],
  ['legacy sidecar', [current, `${old}-wal`]],
  ['derived-only', ['state@current.db']],
  ['current orphan sidecar', [`${current}-shm`]],
  ['opaque-only', ['notes']],
])('%s layout refuses before either factory and retains every byte', async (_label, names) =>
  fixture(async (base, directory) => {
    await fs.mkdir(directory)
    for (const name of names) await fs.writeFile(path.join(directory, name), `retained:${name}`)
    const before = await bytes(directory),
      factory = vi.fn()
    await expect(execute(base, factory)).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
    expect(await bytes(directory)).toEqual(before)
  }),
)

test.each(['source symlink', 'source directory', 'replica symlink', 'replica file'])(
  '%s refuses without factory IO or mutation',
  async (kind) =>
    fixture(async (base, directory) => {
      await fs.mkdir(directory)
      await fs.writeFile(path.join(base, 'opaque'), 'retained')
      if (kind === 'source symlink') await fs.symlink('../opaque', path.join(directory, current))
      if (kind === 'source directory') await fs.mkdir(path.join(directory, current))
      if (kind.startsWith('replica') === true) {
        await fs.rmdir(directory)
        if (kind === 'replica symlink') {
          await fs.mkdir(path.join(base, 'target'))
          await fs.symlink('target', directory)
        } else await fs.writeFile(directory, 'retained-replica')
      }
      const factory = vi.fn()
      await expect(execute(base, factory)).rejects.toThrow()
      expect(factory).not.toHaveBeenCalled()
      expect(await fs.readFile(path.join(base, 'opaque'), 'utf8')).toBe('retained')
      if (kind === 'replica file') expect(await fs.readFile(directory, 'utf8')).toBe('retained-replica')
    }),
)

test.each(['EACCES', 'ENOENT'])('enumeration %s after discovery is uncertainty, not freshness', async (code) =>
  fixture(async (base, directory) => {
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, current), 'retained')
    const before = await bytes(directory)
    const factory = vi.fn(),
      scan = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('injected read failure'), { code }))
    expect(await failure(base, factory)).toContain('injected read failure')
    scan.mockRestore()
    expect(factory).not.toHaveBeenCalled()
    expect(await bytes(directory)).toEqual(before)
  }),
)

test.each(['missing', 'empty', 'current'])('%s opens source before derived state and closes both once', async (kind) =>
  fixture(async (base, directory) => {
    if (kind !== 'missing') await fs.mkdir(directory)
    if (kind === 'current') {
      await execute(base, await observedFactory())
      await fs.writeFile(path.join(directory, 'opaque-extra'), 'keep')
    }
    const before = kind === 'current' ? await bytes(directory) : undefined,
      closes = [],
      calls = []
    const factory = await observedFactory(
      (input) => calls.push(input.fileName),
      (input) => closes.push(input.fileName),
    )
    const result = await execute(base, factory)
    expect(result.dbEventlog.persistence.kind).toBe('independent')
    expect(result.dbEventlog.fresh !== undefined).toBe(kind !== 'current')
    expect(result.initializedSource.identity.formatVersion).toBe(liveStoreStorageFormatVersion)
    expect(factory.mock.calls[0][0].create).toBe(false)
    expect(factory.mock.calls[0][0].sourceCreation !== undefined).toBe(kind !== 'current')
    expect(calls[0]).toBe(current)
    expect(calls).toHaveLength(2)
    expect(closes).toEqual(calls.toReversed())
    if (before !== undefined) expect(await bytes(directory)).toEqual(before)
  }),
)

test('derived open failure still closes the acquired source', async () =>
  fixture(async (base) => {
    const close = vi.fn()
    const native = await observedFactory(() => {}, close)
    const factory = vi.fn((input) =>
      input.fileName === current ? native(input) : Effect.die(new Error('state open failed')),
    )
    expect(await failure(base, factory)).toContain('state open failed')
    expect(close).toHaveBeenCalledOnce()
    expect(close.mock.calls[0][0].fileName).toBe(current)
  }))

test('source disappearance after directory discovery refuses with no factory or mutation', async () =>
  fixture(async (base, directory) => {
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, current), 'retained')
    const before = await bytes(directory)
    const original = fs.lstat.bind(fs),
      factory = vi.fn()
    const stat = vi
      .spyOn(fs, 'lstat')
      .mockImplementation((file) =>
        file === path.join(directory, current)
          ? Promise.reject(Object.assign(new Error('source changed during discovery'), { code: 'ENOENT' }))
          : original(file),
      )
    expect(await failure(base, factory)).toContain('source changed during discovery')
    stat.mockRestore()
    expect(factory).not.toHaveBeenCalled()
    expect(await bytes(directory)).toEqual(before)
  }))

test('source close failure remains a failed scope result instead of successful closure', async () =>
  fixture(async (base) => {
    const closes = []
    const factory = await observedFactory(
      () => {},
      (input) => {
        closes.push(input.fileName)
        if (input.fileName === current) throw new Error('source close failed')
      },
    )
    expect(await failure(base, factory)).toContain('source close failed')
    expect(closes).toHaveLength(2)
    expect(closes[1]).toBe(current)
  }))

test('malformed current WAL refuses before derived open and retains source and sidecar bytes', async () =>
  fixture(async (base, directory) => {
    await execute(base, await observedFactory())
    await fs.writeFile(path.join(directory, `${current}-wal`), 'malformed-sidecar')
    const before = await bytes(directory)
    const calls = [],
      closes = []
    const factory = await observedFactory(
      (input) => calls.push(input.fileName),
      (input) => closes.push(input.fileName),
    )
    expect(await failure(base, factory)).toContain('unable to open database file')
    expect(calls).toEqual([current])
    expect(closes).toEqual([current])
    expect(await bytes(directory)).toEqual(before)
  }))
