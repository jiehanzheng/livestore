import { vi, type Mock } from 'vitest'

export const snapshotBytes = () =>
  new Uint8Array([...'SQLite format 3\0fake-native-snapshot'].map((char) => char.charCodeAt(0)))

type FakeResult = { changes: number; getAllSync: Mock<() => Record<string, unknown>[]>; resetSync: Mock<() => void> }
export const fakeResult = function (): FakeResult {
  return { changes: 3, getAllSync: vi.fn((): Record<string, unknown>[] => []), resetSync: vi.fn() }
}
type FakeStatement = {
  result: FakeResult
  executeSync: Mock<() => FakeResult>
  finalizeSync: Mock<() => void>
  getColumnNamesSync: Mock<() => string[]>
}
export const fakeStatement = function (): FakeStatement {
  const result = fakeResult()
  return { result, executeSync: vi.fn(() => result), finalizeSync: vi.fn(), getColumnNamesSync: vi.fn(() => ['value']) }
}
type FakeSession = {
  attachSync: Mock<() => void>
  closeSync: Mock<() => void>
  createChangesetSync: Mock<() => Uint8Array | ArrayBuffer>
  invertChangesetSync: Mock<() => Uint8Array | ArrayBuffer>
  applyChangesetSync: Mock<() => void>
}
export const fakeSession = function (): FakeSession {
  return {
    attachSync: vi.fn(),
    closeSync: vi.fn(),
    createChangesetSync: vi.fn((): Uint8Array | ArrayBuffer => new Uint8Array([2, 3])),
    invertChangesetSync: vi.fn((): Uint8Array | ArrayBuffer => new Uint8Array([3, 2])),
    applyChangesetSync: vi.fn(),
  }
}
type FakeDatabase = {
  statements: FakeStatement[]
  sessions: FakeSession[]
  closeSync: Mock<() => void>
  execSync: Mock<() => void>
  totalChanges: number
  serializeSync: Mock<() => Uint8Array | ArrayBuffer>
  prepareSync: Mock<(sql?: string) => FakeStatement>
  createSessionSync: Mock<() => FakeSession>
}
export const fakeDatabase = function (): FakeDatabase {
  const statements: ReturnType<typeof fakeStatement>[] = []
  const sessions: ReturnType<typeof fakeSession>[] = []
  let totalChanges = 0
  return {
    statements,
    sessions,
    closeSync: vi.fn(),
    execSync: vi.fn(),
    get totalChanges() {
      return totalChanges
    },
    set totalChanges(value: number) {
      totalChanges = value
    },
    serializeSync: vi.fn((): Uint8Array | ArrayBuffer => snapshotBytes()),
    prepareSync: vi.fn((sql?: string) => {
      const value = fakeStatement()
      if (sql === 'SELECT total_changes() AS changes')
        value.result.getAllSync.mockImplementation(() => [{ changes: totalChanges }])
      statements.push(value)
      return value
    }),
    createSessionSync: vi.fn(() => {
      const value = fakeSession()
      sessions.push(value)
      return value
    }),
  }
}
