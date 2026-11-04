import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { PlatformNode } from '@livestore/utils/node'
import * as VFS from '@livestore/wa-sqlite/src/VFS.js'

import { loadSqlite3Wasm } from '../load-wasm/mod.node.ts'
import { makeSqliteDb } from '../make-sqlite-db.ts'
import { sqliteDbFactory } from './mod.ts'
import { NodeFS } from './NodeFS.ts'
import { reserveNodeSource } from './source-creation.ts'

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-source-allocation-'))
  try {
    await run(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

class ObservedNodeFS extends NodeFS {
  readonly ordinaryOpens: Array<{ pathname: string; flags: number }> = []
  readonly sqliteOpens: Array<{ pathname: string | null; flags: number; fileId: number }> = []

  protected override openDescriptor(pathname: string, flags: number): number {
    this.ordinaryOpens.push({ pathname, flags })
    return super.openDescriptor(pathname, flags)
  }

  override jOpen(name: string | null, fileId: number, flags: number, out: DataView): number {
    this.sqliteOpens.push({ pathname: name, flags, fileId })
    return super.jOpen(name, fileId, flags, out)
  }
}

describe('owned Node SOURCE creation', () => {
  test('exclusive reservation cannot truncate an existing retained path', async () =>
    withDirectory(async (directory) => {
      const pathname = path.join(directory, 'eventlog.db')
      fs.writeFileSync(pathname, 'retained')
      expect(() => reserveNodeSource(pathname)).toThrow()
      expect(fs.readFileSync(pathname, 'utf8')).toBe('retained')
    }))

  test('actual shipped SQLite adopts the exact descriptor once and never reopens it for source or sidecars', async () =>
    withDirectory(async (directory) => {
      const sqlite = await loadSqlite3Wasm()
      if ('module' in sqlite === false) throw new Error('Missing owned WASM module')
      const vfs = new ObservedNodeFS('owned-source-test', sqlite.module, directory)
      sqlite.vfs_register(vfs, false)
      const pathname = path.join(directory, 'eventlog.db')
      const creation = reserveNodeSource(pathname)
      const adoption = vi.spyOn(creation, 'adopt')
      vfs.registerSourceCreation(creation)
      const pointer = sqlite.open_v2Sync('eventlog.db', undefined, vfs.name)
      const boundary = creation.opened()
      const db = makeSqliteDb({
        sqlite3: sqlite,
        metadata: {
          dbPointer: pointer,
          persistenceInfo: { fileName: 'eventlog.db' },
          deleteDb: () => {},
          configureDb: () => {},
        },
      })
      try {
        db.execute('CREATE TABLE retained(value TEXT)')
        db.execute("INSERT INTO retained VALUES ('original')")
        const main = vfs.sqliteOpens.filter((row) => row.pathname === 'eventlog.db')
        expect(main).toHaveLength(1)
        expect(main[0]!.flags & (VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_READWRITE | VFS.SQLITE_OPEN_CREATE)).toBe(
          VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_READWRITE | VFS.SQLITE_OPEN_CREATE,
        )
        expect(adoption).toHaveBeenCalledExactlyOnceWith(pathname, main[0]!.flags)
        expect(vfs.ordinaryOpens.some((row) => row.pathname === pathname)).toBe(false)
        const adopted = adoption.mock.results[0]!
        if (adopted.type !== 'return') throw new Error('Descriptor adoption failed')
        expect(fs.fstatSync(adopted.value).ino).toBe(fs.statSync(pathname).ino)
        const stateVfs = new ObservedNodeFS('state-descriptor-owner', sqlite.module, directory)
        sqlite.vfs_register(stateVfs, false)
        const statePointer = sqlite.open_v2Sync('state.db', undefined, stateVfs.name)
        const state = makeSqliteDb({
          sqlite3: sqlite,
          metadata: {
            dbPointer: statePointer,
            persistenceInfo: { fileName: 'state.db' },
            deleteDb: () => {},
            configureDb: () => {},
          },
        })
        try {
          state.execute('CREATE TABLE derived(value INTEGER)')
        } finally {
          state.close()
        }
        expect(stateVfs.ordinaryOpens.some((row) => row.pathname === path.join(directory, 'state.db'))).toBe(true)
        expect(adoption).toHaveBeenCalledTimes(1)
        expect(boundary.isHeld()).toBe(true)
      } finally {
        db.close()
      }
      expect(boundary.isHeld()).toBe(false)
      expect(creation.disposition).toBe('closed')
      const before = fs.readFileSync(pathname)
      const reopenedPointer = sqlite.open_v2Sync('eventlog.db', VFS.SQLITE_OPEN_READWRITE, vfs.name)
      const reopened = makeSqliteDb({
        sqlite3: sqlite,
        metadata: {
          dbPointer: reopenedPointer,
          persistenceInfo: { fileName: 'eventlog.db' },
          deleteDb: () => {},
          configureDb: () => {},
        },
      })
      try {
        expect(reopened.select('SELECT value FROM retained')).toEqual([{ value: 'original' }])
      } finally {
        reopened.close()
      }
      expect(fs.readFileSync(pathname)).toEqual(before)
      expect(adoption).toHaveBeenCalledTimes(1)
      const lastMain = vfs.sqliteOpens.findLast((row) => row.pathname === 'eventlog.db')!
      expect(lastMain.flags & VFS.SQLITE_OPEN_CREATE).toBe(0)
    }))

  test('factory metadata reports only successful adoption and retained open refuses missing files', async () =>
    withDirectory(async (directory) => {
      const sqlite = await loadSqlite3Wasm()
      const creation = reserveNodeSource(path.join(directory, 'eventlog.db'))
      await Effect.runPromise(
        Effect.gen(function* () {
          const make = yield* sqliteDbFactory({ sqlite3: sqlite })
          const db = yield* make({ _tag: 'fs', directory, fileName: 'eventlog.db', sourceCreation: creation })
          try {
            expect(db.metadata.vfs).toBeInstanceOf(NodeFS)
            expect(db.metadata.sourceCreation?.kind).toBe('exclusive-node-file-creation')
            expect(db.metadata.sourceCreation?.isHeld()).toBe(true)
            db.execute('CREATE TABLE kept(value INTEGER)')
          } finally {
            db.close()
          }
          expect(creation.disposition).toBe('closed')
          const missing = yield* Effect.exit(make({ _tag: 'fs', directory, fileName: 'absent.db', create: false }))
          expect(missing._tag).toBe('Failure')
          expect(fs.existsSync(path.join(directory, 'absent.db'))).toBe(false)
        }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
    }))

  test('pre-adoption validation failure closes reservation without removing its path', async () =>
    withDirectory(async (directory) => {
      const sqlite = await loadSqlite3Wasm(),
        fileName = `${'x'.repeat(57)}.db`
      const creation = reserveNodeSource(path.join(directory, fileName))
      await Effect.runPromise(
        Effect.gen(function* () {
          const make = yield* sqliteDbFactory({ sqlite3: sqlite })
          expect((yield* Effect.exit(make({ _tag: 'fs', directory, fileName, sourceCreation: creation })))._tag).toBe(
            'Failure',
          )
        }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
      expect(creation.disposition).toBe('closed')
      expect(fs.statSync(path.join(directory, fileName)).size).toBe(0)
    }))

  test('a source reservation cannot be redirected into a state or different main database', async () =>
    withDirectory(async (directory) => {
      const sqlite = await loadSqlite3Wasm()
      const creation = reserveNodeSource(path.join(directory, 'eventlog.db'))
      await Effect.runPromise(
        Effect.gen(function* () {
          const make = yield* sqliteDbFactory({ sqlite3: sqlite })
          const result = yield* Effect.exit(
            make({ _tag: 'fs', directory, fileName: 'state.db', sourceCreation: creation }),
          )
          expect(result._tag).toBe('Failure')
        }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
      expect(creation.disposition).toBe('closed')
      expect(fs.statSync(path.join(directory, 'eventlog.db')).size).toBe(0)
      expect(fs.existsSync(path.join(directory, 'state.db'))).toBe(false)
    }))

  test('configuration failure after actual adoption joins SQLite close and preserves created bytes', async () =>
    withDirectory(async (directory) => {
      const sqlite = await loadSqlite3Wasm(),
        fileName = 'eventlog.db'
      const creation = reserveNodeSource(path.join(directory, fileName))
      await Effect.runPromise(
        Effect.gen(function* () {
          const make = yield* sqliteDbFactory({ sqlite3: sqlite })
          const failed = yield* Effect.exit(
            make({
              _tag: 'fs',
              directory,
              fileName,
              sourceCreation: creation,
              configureDb: (db) => {
                db.execute('CREATE TABLE retained(value INTEGER)')
                throw new Error('configuration failed')
              },
            }),
          )
          expect(failed._tag).toBe('Failure')
          expect(creation.disposition).toBe('closed')
          const retained = yield* make({ _tag: 'fs', directory, fileName, create: false })
          try {
            expect(retained.select("SELECT name FROM sqlite_master WHERE name='retained'")).toEqual([
              { name: 'retained' },
            ])
          } finally {
            retained.close()
          }
        }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
      )
    }))

  test('failed native descriptor close remains uncertain rather than claiming release', async () =>
    withDirectory(async (directory) => {
      const sqlite = await loadSqlite3Wasm()
      if ('module' in sqlite === false) throw new Error('Missing owned WASM module')
      const vfs = new NodeFS('uncertain-close-test', sqlite.module, directory)
      const creation = reserveNodeSource(path.join(directory, 'eventlog.db'))
      const adoption = vi.spyOn(creation, 'adopt')
      vfs.registerSourceCreation(creation)
      expect(
        vfs.jOpen(
          'eventlog.db',
          1,
          VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_READWRITE | VFS.SQLITE_OPEN_CREATE,
          new DataView(new ArrayBuffer(4)),
        ),
      ).toBe(VFS.SQLITE_OK)
      const boundary = creation.opened(),
        adopted = adoption.mock.results[0]!
      if (adopted.type !== 'return') throw new Error('Descriptor adoption failed')
      // Controlled external closure makes the subsequent owned close fail with EBADF; no live native resource is discarded.
      fs.closeSync(adopted.value)
      expect(vfs.jClose(1)).toBe(VFS.SQLITE_IOERR_CLOSE)
      expect(creation.disposition).toBe('uncertain')
      expect(
        vfs.jOpen(
          'replacement.db',
          1,
          VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_READWRITE | VFS.SQLITE_OPEN_CREATE,
          new DataView(new ArrayBuffer(4)),
        ),
      ).toBe(VFS.SQLITE_CANTOPEN)
      expect(fs.existsSync(path.join(directory, 'replacement.db'))).toBe(false)
      expect(boundary.isHeld()).toBe(false)
      creation.closeUnadopted()
      expect(creation.disposition).toBe('uncertain')
    }))
})
