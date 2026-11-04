import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { fromSyncSource, initializeSource, SourceIdentity } from '@livestore/common/source-db'
import type { ApplicationBinding, SourceMaintenanceLocationOwner } from '@livestore/common/source-maintenance'
import { withRetainedSource } from '@livestore/common/source-maintenance/internal'
import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'
import {
  reserveNodeSource,
  sqliteDbFactory,
  type MakeNodeSqliteDb,
  type NodeDatabaseInput,
  type NodeDatabaseMetadata,
} from '@livestore/sqlite-wasm/node'
import { Effect, Exit } from '@livestore/utils/effect'
import { PlatformNode } from '@livestore/utils/node'

import { makeNodeSourceMaintenanceOpener } from './source-maintenance.ts'

const binding: ApplicationBinding = {
  operationId: 'pending-maintenance',
  context: {
    namespaceId: 'installation',
    ledgerRevision: 2,
    routing: {
      physicalStoreId: 'replica',
      graphId: 'graph',
      gatewayOrigin: 'https://test.invalid',
      accountId: 'account',
    },
    replicaDescriptor: { directory: 'replica' },
    localIdentity: { clientId: 'retained-client' },
    originalGraphAccess: { role: 'owner' },
  },
}

const withFixture = async (
  use: (fixture: { base: string; directory: string; make: MakeNodeSqliteDb }) => Promise<void>,
) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'node-source-maintenance-'))
  try {
    const sqlite3 = await loadSqlite3Wasm()
    const make = await Effect.runPromise(
      sqliteDbFactory({ sqlite3 }).pipe(Effect.provide(PlatformNode.NodeFileSystem.layer)),
    )
    await use({ base, directory: path.join(base, 'replica'), make })
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
}
const seed = async (directory: string, make: MakeNodeSqliteDb, valid = true) => {
  await fs.mkdir(directory)
  const native = await Effect.runPromise(
    make({
      _tag: 'fs',
      directory,
      fileName: 'eventlog.db',
      sourceCreation: reserveNodeSource(path.join(directory, 'eventlog.db')),
    }),
  )
  if (valid === false) {
    native.execute('CREATE TABLE retained_raw (value TEXT)')
    native.execute("INSERT INTO retained_raw VALUES ('keep')")
    native.close()
  } else {
    const owner = await Effect.runPromise(fromSyncSource(native, native.metadata.sourceCreation))
    try {
      await Effect.runPromise(initializeSource(owner))
    } finally {
      await Effect.runPromise(owner.close)
    }
  }
}
const observed = (make: MakeNodeSqliteDb, failClose = false) => {
  const events: string[] = []
  let held = false,
    closeFinished = false,
    closes = 0
  const inputs: Parameters<MakeNodeSqliteDb>[0][] = []
  // This controlled application-owner fixture observes lifetime ordering; it does not model an OS file lock.
  const locationOwner: SourceMaintenanceLocationOwner = {
    run: (actual, effect) =>
      Effect.suspend(() => {
        expect(actual).toEqual({ purpose: 'capture', binding })
        held = true
        events.push('location-enter')
        return effect.pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              if (closeFinished === true) {
                held = false
                events.push('location-release')
              } else events.push('location-retained')
            }),
          ),
        )
      }),
  }
  const makeSqliteDb: MakeNodeSqliteDb = <
    TInput extends NodeDatabaseInput,
    TMetadata extends NodeDatabaseMetadata & { _tag: TInput['_tag'] } = NodeDatabaseMetadata & { _tag: TInput['_tag'] },
  >(
    input: TInput,
  ) => {
    expect(held).toBe(true)
    inputs.push(input)
    return make<TInput, TMetadata>(input).pipe(
      Effect.map((native) => ({
        ...native,
        close: () => {
          expect(held).toBe(true)
          closes++
          events.push('source-close')
          native.close()
          if (failClose === true) throw new Error('close acknowledgement failed')
          closeFinished = true
        },
      })),
    )
  }
  return { locationOwner, makeSqliteDb, events, inputs, held: () => held, closes: () => closes }
}

test('retained maintenance reads only SOURCE and joins its close before location release', async () =>
  withFixture(async ({ directory, make }) => {
    await seed(directory, make)
    const before = await fs.readFile(path.join(directory, 'eventlog.db'))
    const scope = observed(make)
    const opener = makeNodeSourceMaintenanceOpener({ binding, directory, fileName: 'eventlog.db', ...scope })
    await Effect.runPromise(
      withRetainedSource(opener, binding, (source) =>
        SourceIdentity.read(source.handle).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(scope.held()).toBe(true)
              expect(source.fresh).toBeUndefined()
              expect(source.persistence.kind).toBe('independent')
              scope.events.push('source-read')
            }),
          ),
        ),
      ),
    )
    expect(scope.inputs).toHaveLength(1)
    expect(scope.inputs[0]).toMatchObject({ _tag: 'fs', directory, fileName: 'eventlog.db', create: false })
    expect(scope.inputs[0]).not.toHaveProperty('sourceCreation')
    expect(scope.closes()).toBe(1)
    expect(scope.events).toEqual(['location-enter', 'source-read', 'source-close', 'location-release'])
    expect(await fs.readdir(directory)).toEqual(['eventlog.db'])
    expect(await fs.readFile(path.join(directory, 'eventlog.db'))).toEqual(before)
  }))

test('missing retained directory is not created', async () =>
  withFixture(async ({ base, directory, make }) => {
    const scope = observed(make)
    const opener = makeNodeSourceMaintenanceOpener({ binding, directory, fileName: 'eventlog.db', ...scope })
    expect(Exit.isFailure(await Effect.runPromiseExit(withRetainedSource(opener, binding, () => Effect.void)))).toBe(
      true,
    )
    expect(await fs.readdir(base)).toEqual([])
    expect(scope.closes()).toBe(0)
  }))

test('invalid retained SOURCE is never initialized and closes once', async () =>
  withFixture(async ({ directory, make }) => {
    await seed(directory, make, false)
    const before = await fs.readFile(path.join(directory, 'eventlog.db'))
    const scope = observed(make)
    const opener = makeNodeSourceMaintenanceOpener({ binding, directory, fileName: 'eventlog.db', ...scope })
    expect(Exit.isFailure(await Effect.runPromiseExit(withRetainedSource(opener, binding, () => Effect.void)))).toBe(
      true,
    )
    expect(scope.closes()).toBe(1)
    expect(await fs.readFile(path.join(directory, 'eventlog.db'))).toEqual(before)
    expect(await fs.readdir(directory)).toEqual(['eventlog.db'])
  }))

test('failed close acknowledgement cannot release the caller location owner', async () =>
  withFixture(async ({ directory, make }) => {
    await seed(directory, make)
    const scope = observed(make, true)
    const opener = makeNodeSourceMaintenanceOpener({ binding, directory, fileName: 'eventlog.db', ...scope })
    expect(Exit.isFailure(await Effect.runPromiseExit(withRetainedSource(opener, binding, () => Effect.void)))).toBe(
      true,
    )
    expect(scope.closes()).toBe(1)
    expect(scope.held()).toBe(true)
    expect(scope.events).toEqual(['location-enter', 'source-close', 'location-retained'])
  }))

test('missing retained main file is not created in an existing directory', async () =>
  withFixture(async ({ directory, make }) => {
    await fs.mkdir(directory)
    const scope = observed(make)
    const opener = makeNodeSourceMaintenanceOpener({ binding, directory, fileName: 'eventlog.db', ...scope })
    expect(Exit.isFailure(await Effect.runPromiseExit(withRetainedSource(opener, binding, () => Effect.void)))).toBe(
      true,
    )
    expect(await fs.readdir(directory)).toEqual([])
    expect(scope.closes()).toBe(0)
  }))
