import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { fromSyncSource } from '@livestore/common/source-db'
import { Effect, Exit } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { loadSqlite3Wasm } from '../load-wasm/mod.node.ts'
import { reserveNodeSource, sqliteDbFactory } from './mod.ts'

const withDirectory = async (use: (directory: string) => Promise<void>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-fd-attestation-'))
  try {
    await use(directory)
  } finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('factory scopes SOURCE and STATE fd sets separately, refuses duplicate live paths, and reopens after joined close', async () =>
  withDirectory(async (directory) => {
    const sqlite3 = await loadSqlite3Wasm()
    await Effect.runPromise(
      Effect.gen(function* () {
        const make = yield* sqliteDbFactory({ sqlite3 })
        const source = yield* make({
          _tag: 'fs',
          directory,
          fileName: 'eventlog.db',
          sourceCreation: reserveNodeSource(path.join(directory, 'eventlog.db')),
        })
        const state = yield* make({ _tag: 'fs', directory, fileName: 'state.db' })
        try {
          expect(source.metadata.vfs).not.toBe(state.metadata.vfs)
          source.execute('CREATE TABLE retained(value TEXT)')
          state.execute('CREATE TABLE derived(value TEXT)')
          expect(
            Exit.isFailure(yield* Effect.exit(make({ _tag: 'fs', directory, fileName: 'eventlog.db', create: false }))),
          ).toBe(true)
          expect(source.select('SELECT COUNT(*) AS count FROM retained')).toEqual([{ count: 0 }])
        } finally {
          state.close()
          source.close()
        }
        const before = fs.readFileSync(path.join(directory, 'eventlog.db'))
        const reopened = yield* make({ _tag: 'fs', directory, fileName: 'eventlog.db', create: false })
        expect(reopened.metadata.vfs).toBe(source.metadata.vfs)
        reopened.close()
        const alias = yield* make({
          _tag: 'fs',
          directory: path.dirname(directory),
          fileName: `${path.basename(directory)}/eventlog.db`,
          create: false,
        })
        expect(alias.metadata.vfs).toBe(source.metadata.vfs)
        expect(alias.select('SELECT COUNT(*) AS count FROM retained')).toEqual([{ count: 0 }])
        alias.close()
        expect(fs.readFileSync(path.join(directory, 'eventlog.db'))).toEqual(before)
      }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )
  }))

for (const kind of ['created-main', 'retained-main', 'journal'] as const)
  test(`${kind} descriptor failure fences canonical close without native retry`, async () =>
    withDirectory(async (directory) => {
      const sqlite3 = await loadSqlite3Wasm()
      const file = path.join(directory, 'eventlog.db')
      const open = fs.openSync,
        close = fs.closeSync
      let targetFd: number | undefined,
        failedFd: number | undefined,
        failures = 0
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const make = yield* sqliteDbFactory({ sqlite3 })
            if (kind === 'retained-main') {
              const seed = yield* make({
                _tag: 'fs',
                directory,
                fileName: 'eventlog.db',
                sourceCreation: reserveNodeSource(file),
              })
              seed.close()
            }
            vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
              const fd = open(name, flags, mode)
              if (name === (kind === 'journal' ? `${file}-journal` : file)) targetFd = fd
              return fd
            })
            syncBuiltinESMExports()
            const native = yield* make({
              _tag: 'fs',
              directory,
              fileName: 'eventlog.db',
              ...(kind === 'retained-main' ? { create: false } : { sourceCreation: reserveNodeSource(file) }),
            })
            const owner = yield* fromSyncSource(native, native.metadata.sourceCreation)
            const sqliteClose = vi.spyOn(sqlite3, 'close')
            vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
              if (fd === targetFd && failedFd === undefined) {
                failures++
                failedFd = fd
                throw new Error('injected actual descriptor close failure')
              }
              close(fd)
            })
            syncBuiltinESMExports()
            if (kind === 'journal')
              yield* Effect.exit(owner.write((tx) => tx.execute('CREATE TABLE journal_probe(value TEXT)')))
            const first = yield* Effect.exit(owner.close)
            expect(Exit.isFailure(first)).toBe(true)
            expect(failedFd).not.toBeUndefined()
            if (failedFd === undefined) return yield* Effect.die(new Error('Native close fault was not exercised'))
            expect(fs.fstatSync(failedFd).isFile()).toBe(true)
            expect(failures).toBe(1)
            expect(sqliteClose).toHaveBeenCalledTimes(1)
            expect(Exit.isFailure(yield* Effect.exit(owner.close))).toBe(true)
            expect(() => native.close()).toThrow('descriptor close did not complete')
            expect(failures).toBe(1)
            expect(sqliteClose).toHaveBeenCalledTimes(1)
            expect(
              Exit.isFailure(
                yield* Effect.exit(make({ _tag: 'fs', directory, fileName: 'eventlog.db', create: false })),
              ),
            ).toBe(true)
          }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
        )
      } finally {
        // This exact test-owned fd was deliberately not closed; dispose it without retrying the failed SDK owner.
        if (failedFd !== undefined) close(failedFd)
      }
    }))
