import nativeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { SqliteDbHelper } from '@livestore/common'
import {
  adoptSource,
  captureSource,
  prepareSourceAdoption,
  SourceMaintenanceError,
  type SourceMaintenanceLocationOwner,
} from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import {
  sqliteDbFactory,
  type MakeNodeSqliteDb,
  type NodeDatabaseInput,
  type NodeDatabaseMetadata,
} from '@livestore/sqlite-wasm/node'
import { Effect, Result } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { binding, definitions, payloadDigest, withFixture } from './source-maintenance-adoption-fixture.ts'
import { makeNodeSourceMaintenanceOpener } from './source-maintenance.ts'

// The application releases its unique fixture location only on SDK-attested joined closure.
const owner = () => {
  const state = { held: false, error: undefined as SourceMaintenanceError | undefined }
  const locationOwner: SourceMaintenanceLocationOwner = {
    run: (_context, effect) =>
      Effect.gen(function* () {
        state.held = true
        const result = yield* Effect.result(effect)
        if (Result.isFailure(result) === true) {
          if (result.failure instanceof SourceMaintenanceError) state.error = result.failure
          if (state.error?.closure === 'joined') state.held = false
          return yield* Effect.fail(result.failure)
        }
        state.held = false
        return result.success
      }),
  }
  return { state, locationOwner }
}
const factory = async () =>
  Effect.runPromise(
    sqliteDbFactory({ sqlite3: await loadSqlite3Wasm() }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
  )

test('post-open guard refusal reports joined closure to the real location owner', async () =>
  withFixture(async (fixture) => {
    const { state, locationOwner } = owner()
    const opener = makeNodeSourceMaintenanceOpener({
      binding,
      locationOwner,
      directory: fixture.directory,
      fileName: 'eventlog.db',
      makeSqliteDb: await factory(),
    })
    const result = await Effect.runPromise(
      Effect.result(
        withRetainedSource(opener, binding, () =>
          Effect.fail(new SourceMaintenanceError('guard-refusal', 'refused after acquisition')),
        ),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(state.error).toMatchObject({ code: 'maintenance-body', closure: 'joined', commitStatus: 'not-started' })
    expect(state.held).toBe(false)
    // Successful reopen proves the physical connection was closed before the app released its grant.
    await Effect.runPromise(withRetainedSource(opener, binding, () => Effect.void))
  }))

test('actual Node descriptor-close failure reports unknown closure and retains the app grant', async () =>
  withFixture(async (fixture) => {
    const { state, locationOwner } = owner()
    const makeSqliteDb = await factory()
    const open = nativeFs.openSync,
      close = nativeFs.closeSync
    let ownedFd: number | undefined, failedFd: number | undefined
    vi.spyOn(nativeFs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode)
      if (file === path.join(fixture.directory, 'eventlog.db')) ownedFd = fd
      return fd
    })
    vi.spyOn(nativeFs, 'closeSync').mockImplementation((fd) => {
      if (fd === ownedFd) {
        failedFd = fd
        throw new Error('actual descriptor retained')
      }
      close(fd)
    })
    syncBuiltinESMExports()
    try {
      const opener = makeNodeSourceMaintenanceOpener({
        binding,
        locationOwner,
        directory: fixture.directory,
        fileName: 'eventlog.db',
        makeSqliteDb,
      })
      const result = await Effect.runPromise(Effect.result(withRetainedSource(opener, binding, () => Effect.void)))
      expect(Result.isFailure(result)).toBe(true)
      expect(state.error).toMatchObject({ code: 'maintenance-close', closure: 'unknown' })
      expect(state.held).toBe(true)
      expect(failedFd).toBeDefined()
      expect(nativeFs.fstatSync(failedFd!).isFile()).toBe(true)
    } finally {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      if (failedFd !== undefined) close(failedFd)
    }
  }))

test('seal failure outside SOURCE scope preserves joined closure', async () =>
  withFixture(async (fixture) => {
    const { state, locationOwner } = owner()
    const opener = makeNodeSourceMaintenanceOpener({
      binding,
      locationOwner,
      directory: fixture.directory,
      fileName: 'eventlog.db',
      makeSqliteDb: await factory(),
    })
    const result = await Effect.runPromise(
      Effect.result(
        captureSource({
          opener,
          binding,
          limits: { maxRows: 100, maxBytes: 100_000, maxRowBytes: 10_000, pageSize: 1 },
          provenance: {},
          sink: {
            begin: () => Effect.void,
            chunk: () => Effect.void,
            seal: () => {
              expect(state.held).toBe(false)
              return Effect.fail(new SourceMaintenanceError('seal-refused', 'publication failed'))
            },
          },
        }),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result) === true)
      expect(result.failure).toMatchObject({ code: 'capture-publication', closure: 'joined' })
  }))

test('exact-postimage resume with lost read COMMIT acknowledgement reports committed and joined', async () =>
  withFixture(async (fixture) => {
    const plan = await Effect.runPromise(
      prepareSourceAdoption({
        capture: await fixture.capture(),
        target: fixture.target(),
        eventDefinitions: definitions,
      }),
    )
    const request = {
      opener: fixture.opener,
      plan,
      intent: fixture.intent(plan.planDigest),
      currentTarget: fixture.target(payloadDigest),
      eventDefinitions: definitions,
    }
    await Effect.runPromise(adoptSource(request))
    const make = await factory()
    const makeSqliteDb: MakeNodeSqliteDb = <
      TInput extends NodeDatabaseInput,
      TMetadata extends NodeDatabaseMetadata & { _tag: TInput['_tag'] } = NodeDatabaseMetadata & {
        _tag: TInput['_tag']
      },
    >(
      input: TInput,
    ) =>
      make<TInput, TMetadata>(input).pipe(
        Effect.map((db) => ({
          ...db,
          execute: SqliteDbHelper.makeExecute((...args) => {
            const result = db.execute(...args)
            if (args[0] === 'COMMIT') throw new Error('lost read transaction acknowledgement')
            return result
          }),
        })),
      )
    const { state, locationOwner } = owner()
    const opener = makeNodeSourceMaintenanceOpener({
      binding,
      locationOwner,
      directory: fixture.directory,
      fileName: 'eventlog.db',
      makeSqliteDb,
    })
    const result = await Effect.runPromise(Effect.result(adoptSource({ ...request, opener })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result) === true)
      expect(result.failure).toMatchObject({ commitStatus: 'committed', closure: 'joined' })
    expect(state.held).toBe(false)
  }))
