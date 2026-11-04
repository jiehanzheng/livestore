import { describe, expect, it, vi } from 'vitest'

import { liveStoreStorageFormatVersion } from '@livestore/common'
import { makeSchema, State } from '@livestore/common/schema'
import { Effect, Stream } from '@livestore/utils/effect'
import { Opfs } from '@livestore/utils/effect/browser'

import { discoverPersistedSource, readPersistedStateDbFromClientSession } from './persisted-sqlite.ts'

// Use real native-format headers so extracting shared discovery cannot bypass the strict decoder.
const poolHeader = (name: string) => {
  const bytes = new Uint8Array(4096)
  if (name === 'corrupt') return bytes
  const corpus = bytes.subarray(0, 516)
  new TextEncoder().encodeInto(name, corpus.subarray(0, 512))
  new DataView(bytes.buffer).setUint32(512, name === '' ? 0 : 0x100)
  if (name === '') new Uint32Array(bytes.buffer, 516, 2).set([0xfecc5f80, 0xaccec037])
  else {
    let h1 = 0xdeadbeef,
      h2 = 0x41c6ce57
    for (const value of corpus) {
      h1 = Math.imul(h1 ^ value, 2654435761)
      h2 = Math.imul(h2 ^ value, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    new Uint32Array(bytes.buffer, 516, 2).set([h1 >>> 0, h2 >>> 0])
  }
  return bytes
}

// Only read-only handle operations are available; any attempt to create or mutate fails the test.
const directory = (name: string) => ({ name, kind: 'directory' }) as FileSystemDirectoryHandle
const file = (name: string) => ({ name, kind: 'file' }) as FileSystemFileHandle
const current = `livestore-owned@${liveStoreStorageFormatVersion}`
const discover = (roots: FileSystemHandle[], files: FileSystemHandle[] = []) => {
  const operations: string[] = []
  const run = <A, E>(effect: Effect.Effect<A, E, Opfs.Opfs>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* Opfs.Opfs
        return yield* effect.pipe(
          Effect.provideService(Opfs.Opfs, {
            ...base,
            getRootDirectoryHandle: Effect.succeed(directory('root')),
            values: (handle) => Stream.fromIterable(handle.name === 'root' ? roots : files),
            getDirectoryHandle: (_root, name, options) => {
              expect(options?.create).not.toBe(true)
              operations.push(`read-directory:${name}`)
              return Effect.succeed(directory(name))
            },
            getFile: (handle) => {
              operations.push(`read-file:${handle.name}`)
              return Effect.succeed(new File([poolHeader(handle.name)], 'opaque-pool-file'))
            },
          }),
        )
      }).pipe(Effect.provide(Opfs.layerNoop)),
    )
  return { run, operations }
}
const schema = makeSchema({
  projectionRevision: 'opfs-source-guard-test-v1',
  events: {},
  state: State.SQLite.makeState({ tables: {}, materializers: {} }),
})
const request = { storageOptions: { type: 'opfs' as const }, storeId: 'owned' }

describe('OPFS source discovery before database factories', () => {
  for (const roots of [[directory('livestore-owned@6')], [directory('livestore-owned@6'), directory(current)]]) {
    it(`refuses retained legacy roots without creating or reading current storage (${roots.length} roots)`, async () => {
      const { run, operations } = discover(roots)
      const result = await run(discoverPersistedSource(request).pipe(Effect.result))
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'LegacyStorageFormatError', actualFormatVersion: 6, storageBase: 'livestore-owned' },
      })
      expect(operations).toEqual([])
    })
  }

  it('ignores unrelated old application namespaces', async () => {
    const { run, operations } = discover([directory('another-app@3')])
    expect(await run(discoverPersistedSource(request))).toEqual({ sourceIsNew: true })
    expect(operations).toEqual([])
  })

  it('treats an eventlog pool reservation with zero payload as an existing source', async () => {
    const { run } = discover([directory(current)], [file('/eventlog.db')])
    expect(await run(discoverPersistedSource(request))).toEqual({ sourceIsNew: false })
  })

  it('refuses corrupt pool metadata even alongside a valid eventlog', async () => {
    const { run } = discover([directory(current)], [file('/eventlog.db'), file('corrupt')])
    expect(await run(discoverPersistedSource(request).pipe(Effect.result))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'LegacyStorageFormatError' },
    })
  })

  it('refuses retained subdirectories when authoritative source is absent without descending or mutating', async () => {
    const { run, operations } = discover([directory(current)], [directory('archive')])
    expect(await run(discoverPersistedSource(request).pipe(Effect.result))).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'LegacyStorageFormatError',
        reason: 'Retained OPFS directories exist without the authoritative eventlog',
      },
    })
    expect(operations).toEqual([`read-directory:${current}`])
  })

  it('keeps retained archive directories alongside a valid source reservation', async () => {
    const { run, operations } = discover([directory(current)], [file('/eventlog.db'), directory('archive')])
    expect(await run(discoverPersistedSource(request))).toEqual({ sourceIsNew: false })
    expect(operations).toEqual([`read-directory:${current}`, 'read-file:/eventlog.db'])
  })

  it('refuses retained state when authoritative source is missing', async () => {
    const { run } = discover([directory(current)], [file('/state.db')])
    expect(await run(discoverPersistedSource(request).pipe(Effect.result))).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'LegacyStorageFormatError',
        reason: 'Retained database associations exist without the authoritative eventlog',
      },
    })
  })

  it('proves absence in an empty current directory', async () => {
    const { run } = discover([directory(current)])
    expect(await run(discoverPersistedSource(request))).toEqual({ sourceIsNew: true })
  })

  it('refuses a legacy fast-cache read before its in-memory database factory', async () => {
    const { run } = discover([directory('livestore-owned@6')])
    const makeSqliteDb = vi.fn()
    const result = await run(
      readPersistedStateDbFromClientSession({ ...request, schema, makeSqliteDb }).pipe(Effect.result, Effect.scoped),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'LegacyStorageFormatError' } })
    expect(makeSqliteDb).not.toHaveBeenCalled()
  })
})
