import { beforeEach, expect, test, vi } from 'vitest'

import type { AdapterArgs } from '@livestore/common'
import { Effect, Exit, Queue, Scope } from '@livestore/utils/effect'
const mocks = vi.hoisted(() => ({ factory: vi.fn(), leader: vi.fn(), session: vi.fn() }))
vi.mock('./sqlite', () => ({ createSqliteFactory: mocks.factory }))
vi.mock('./leader', () => ({ createExpoLeader: mocks.leader }))
vi.mock('@livestore/common', async (original) => ({ ...(await original<object>()), makeClientSession: mocks.session }))
import { makeOwnedAdapter } from './index.ts'
const args = (): AdapterArgs =>
  ({ devtoolsEnabled: false, bootStatusQueue: Effect.runSync(Queue.unbounded()) }) as AdapterArgs
beforeEach(() => vi.clearAllMocks())

test('one adapter boot exposes only the admitted client DB and independent physical attestation', async () => {
  const db = {}
  const makeSqliteDb = vi.fn()
  const assertClosed = vi.fn()
  const leaderThread = {}
  mocks.factory.mockReturnValue({ makeSqliteDb, assertClosed })
  mocks.leader.mockReturnValue(Effect.succeed({ leaderThread, sqliteDb: db }))
  mocks.session.mockImplementation((value) => Effect.succeed(value))
  const options = {
    clientId: 'replica',
    sync: { backend: vi.fn(), onBackendIdMismatch: 'shutdown' as const, onSyncError: 'shutdown' as const },
  }
  const owned = makeOwnedAdapter(options)
  const scope = Scope.makeUnsafe()
  const session = await Effect.runPromise(owned.adapter(args()).pipe(Scope.provide(scope)))
  expect(session.sqliteDb).toBe(db)
  expect(session.clientId).toBe('replica')
  expect(session.leaderThread).toBe(leaderThread)
  expect(makeSqliteDb).not.toHaveBeenCalled()
  const second = await Effect.runPromiseExit(owned.adapter(args()).pipe(Scope.provide(scope)))
  expect(Exit.isFailure(second)).toBe(true)
  expect(mocks.leader).toHaveBeenCalledExactlyOnceWith(expect.anything(), options, makeSqliteDb)
  expect(mocks.leader.mock.calls[0]![1].sync).toBe(options.sync)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  owned.assertClosed()
  expect(assertClosed).toHaveBeenCalledOnce()
})

test('unsupported devtools refuses before opening storage', async () => {
  const makeSqliteDb = vi.fn()
  mocks.factory.mockReturnValue({ makeSqliteDb, assertClosed: vi.fn() })
  const owned = makeOwnedAdapter({ clientId: 'replica' })
  const exit = await Effect.runPromise(Effect.scoped(Effect.exit(owned.adapter({ ...args(), devtoolsEnabled: true }))))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(mocks.leader).not.toHaveBeenCalled()
  expect(makeSqliteDb).not.toHaveBeenCalled()
})

test('failed admission never exposes a client session and joins the acquired leader lifetime', async () => {
  const release = vi.fn()
  mocks.factory.mockReturnValue({ makeSqliteDb: vi.fn(), assertClosed: vi.fn() })
  mocks.leader.mockReturnValue(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () => Effect.sync(release))
      return yield* Effect.die(new Error('Leader lost before snapshot admission'))
    }),
  )
  const owned = makeOwnedAdapter({ clientId: 'replica' })
  const exit = await Effect.runPromiseExit(Effect.scoped(owned.adapter(args())))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(mocks.session).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})
