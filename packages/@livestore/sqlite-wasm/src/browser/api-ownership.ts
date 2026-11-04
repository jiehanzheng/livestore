import { UnknownError } from '@livestore/common'
import type { SQLiteAPI } from '@livestore/wa-sqlite'

const physical = new WeakSet<SQLiteAPI>()
const sharedMemory = new WeakSet<SQLiteAPI>()

export const claimPhysicalApi = (sqlite3: SQLiteAPI) => {
  if (physical.has(sqlite3) === true || sharedMemory.has(sqlite3) === true) {
    throw new UnknownError({ cause: 'A physical SQLite factory requires a fresh API incarnation' })
  }
  // Native VFS registrations are not unregistered by closing an Effect scope.
  physical.add(sqlite3)
}

export const claimSharedMemoryApi = (sqlite3: SQLiteAPI) => {
  if (physical.has(sqlite3) === true) {
    throw new UnknownError({ cause: 'A physical SQLite API cannot become a shared memory-only API' })
  }
  sharedMemory.add(sqlite3)
}
