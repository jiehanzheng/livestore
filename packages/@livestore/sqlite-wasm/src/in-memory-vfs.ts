import type * as WaSqlite from '@livestore/wa-sqlite'
import { MemoryVFS } from '@livestore/wa-sqlite/src/examples/MemoryVFS.js'

const memoryVfsByApi = new WeakMap<WaSqlite.SQLiteAPI, MemoryVFS>()

export const makeInMemoryDb = (sqlite3: WaSqlite.SQLiteAPI) => {
  if (sqlite3.vfs_registered.has('memory-vfs') === false) {
    const vfs = new MemoryVFS('memory-vfs', (sqlite3 as any).module)

    // @ts-expect-error TODO fix types
    sqlite3.vfs_register(vfs, false)
    memoryVfsByApi.set(sqlite3, vfs)
  }

  const dbPointer = sqlite3.open_v2Sync(':memory:', undefined, 'memory-vfs')
  const vfs = memoryVfsByApi.get(sqlite3)!

  return { dbPointer, vfs }
}
