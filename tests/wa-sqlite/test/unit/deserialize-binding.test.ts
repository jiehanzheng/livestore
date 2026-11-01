import { beforeAll, describe, expect, it, vi } from 'vitest'

import * as SQLite from '@livestore/wa-sqlite'
import WaSqliteFactory from '@livestore/wa-sqlite/dist/wa-sqlite.node.mjs'

type OwnedModule = {
  _sqlite3_malloc: (bytes: number) => number
  _sqlite3_free: (pointer: number) => void
  _sqlite3_memory_used: () => number
  _sqlite3_shutdown: () => number
  _malloc: (bytes: number) => number
  _free: (pointer: number) => void
  setValue: (pointer: number, value: number, type: string) => void
  ccall: (name: string, result: string, types: string[], args: number[]) => number
  HEAPU8: Uint8Array<ArrayBuffer>
  cwrap: (...args: unknown[]) => (...args: unknown[]) => unknown
}

async function environment(setup?: (module: OwnedModule) => void) {
  const module: OwnedModule = await WaSqliteFactory()
  // This binary defaults MEMSTATUS off. Enable SQLite's supported accounting only on
  // this fresh, unopened module; otherwise zero memory counters cannot prove ownership.
  expect(module._sqlite3_shutdown()).toBe(SQLite.SQLITE_OK)
  const args = module._malloc(4)
  try {
    // WASM C varargs are passed in a memory block; SQLITE_CONFIG_MEMSTATUS (9) takes one int.
    module.setValue(args, 1, 'i32')
    expect(module.ccall('sqlite3_config', 'number', ['number', 'number'], [9, args])).toBe(SQLite.SQLITE_OK)
  } finally {
    module._free(args)
  }
  const before = module._sqlite3_memory_used()
  const positive = module._sqlite3_malloc(1024)
  expect(module._sqlite3_memory_used() - before).toBeGreaterThanOrEqual(1024)
  module._sqlite3_free(positive)
  expect(module._sqlite3_memory_used()).toBe(before)
  setup?.(module)
  const api = SQLite.Factory(module)
  const open = () => api.open_v2Sync(':memory:')
  // Initialize SQLite's persistent module state before measuring per-database allocations.
  api.close(open())
  return { module, api, open, cleanMemory: module._sqlite3_memory_used() }
}

function rows(api: SQLite.SQLiteAPI, db: number, sql: string) {
  const result: Array<Record<string, ReturnType<SQLite.SQLiteAPI['column']>>> = []
  api.exec(db, sql, (values, names) => {
    result.push(Object.fromEntries(names.map((name, index) => [name, values[index] ?? null])))
  })
  return result
}

let image: Uint8Array<ArrayBuffer>
beforeAll(async () => {
  const { api, open } = await environment()
  const db = open()
  try {
    api.exec(db, 'CREATE TABLE fixture(id INTEGER PRIMARY KEY, label TEXT, exact INTEGER, bytes BLOB)')
    api.exec(db, "INSERT INTO fixture VALUES(1,'alpha',9007199254740993,x'0001ff')")
    api.exec(db, 'CREATE INDEX fixture_label ON fixture(label)')
    image = api.serialize(db, 'main')
  } finally {
    api.close(db)
  }
})

describe('deserialize JS/WASM binding', () => {
  it.each([4, 5])('enforces READONLY with flags %i and frees the private image on close', async (flags) => {
    const { api, module, open, cleanMemory } = await environment()
    const db = open()
    const original = image.slice()
    try {
      expect(api.deserialize(db, 'main', image, image.length, image.length, flags)).toBe(SQLite.SQLITE_OK)
      expect(rows(api, db, 'SELECT * FROM fixture INDEXED BY fixture_label')).toEqual([
        { id: 1, label: 'alpha', exact: 9007199254740993n, bytes: new Uint8Array([0, 1, 255]) },
      ])
      expect(rows(api, db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(() => api.exec(db, "UPDATE fixture SET label='alter'")).toThrow(
        expect.objectContaining({ code: SQLite.SQLITE_READONLY }),
      )
      expect(image).toEqual(original)
    } finally {
      api.close(db)
    }
    expect(module._sqlite3_memory_used()).toBe(cleanMemory)
  })

  it.each([2, 3])('preserves mutable RESIZEABLE growth with flags %i on the same binary', async (flags) => {
    const { api, module, open, cleanMemory } = await environment()
    const db = open()
    try {
      expect(api.deserialize(db, 'main', image, image.length, image.length, flags)).toBe(SQLite.SQLITE_OK)
      api.exec(db, "UPDATE fixture SET label='alter'")
      api.exec(db, "INSERT INTO fixture VALUES(2,'grown',-9007199254740993,zeroblob(65536))")
      expect(rows(api, db, 'SELECT id,label,exact,length(bytes) AS bytes FROM fixture ORDER BY id')).toEqual([
        { id: 1, label: 'alter', exact: 9007199254740993n, bytes: 3 },
        { id: 2, label: 'grown', exact: -9007199254740993n, bytes: 65536 },
      ])
      expect(rows(api, db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally {
      api.close(db)
    }
    expect(module._sqlite3_memory_used()).toBe(cleanMemory)
  })

  it('accepts safe zero sizes and creates an empty resizeable database', async () => {
    const { api, module, open, cleanMemory } = await environment()
    const db = open()
    try {
      expect(api.deserialize(db, 'main', new Uint8Array(0), 0, 0, 2)).toBe(SQLite.SQLITE_OK)
      api.exec(db, 'CREATE TABLE empty_origin(id INTEGER)')
      api.exec(db, 'INSERT INTO empty_origin VALUES(1)')
      expect(rows(api, db, 'SELECT id FROM empty_origin')).toEqual([{ id: 1 }])
    } finally {
      api.close(db)
    }
    expect(module._sqlite3_memory_used()).toBe(cleanMemory)
  })

  it('honors allocated capacity without RESIZEABLE, including caller flags without FREEONCLOSE', async () => {
    const { api, module, open, cleanMemory } = await environment()
    const db = open()
    const input = new Uint8Array(image.length + 17)
    input.set(image)
    input.fill(0xa5, image.length)
    const original = input.slice()
    try {
      const before = module._sqlite3_memory_used()
      const capacity = image.length + 65536
      expect(api.deserialize(db, 'main', input, image.length, capacity, 0)).toBe(SQLite.SQLITE_OK)
      expect(module._sqlite3_memory_used() - before).toBeGreaterThanOrEqual(capacity)
      api.exec(db, "INSERT INTO fixture VALUES(2,'fits',2,zeroblob(20000))")
      expect(() => api.exec(db, "INSERT INTO fixture VALUES(3,'too large',3,zeroblob(131072))")).toThrow(
        expect.objectContaining({ code: SQLite.SQLITE_FULL }),
      )
      expect(rows(api, db, 'SELECT id FROM fixture ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }])
      expect(rows(api, db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(input).toEqual(original)
    } finally {
      api.close(db)
    }
    expect(module._sqlite3_memory_used()).toBe(cleanMemory)
  })

  it('marshals the requested schema instead of silently using main', async () => {
    const { api, module, open, cleanMemory } = await environment()
    const db = open()
    try {
      api.exec(db, "ATTACH ':memory:' AS other_é")
      expect(api.deserialize(db, 'other_é', image, image.length, image.length, 5)).toBe(SQLite.SQLITE_OK)
      expect(rows(api, db, 'SELECT id,label FROM other_é.fixture')).toEqual([{ id: 1, label: 'alpha' }])
      expect(rows(api, db, "SELECT name FROM main.sqlite_schema WHERE name='fixture'")).toEqual([])
      expect(() => api.exec(db, "UPDATE other_é.fixture SET label='alter'")).toThrow(
        expect.objectContaining({ code: SQLite.SQLITE_READONLY }),
      )
    } finally {
      api.close(db)
    }
    expect(module._sqlite3_memory_used()).toBe(cleanMemory)
  })

  it('lets SQLite release its private allocation exactly once on native schema failure', async () => {
    const { api, module, open, cleanMemory } = await environment()
    const db = open()
    try {
      const before = module._sqlite3_memory_used()
      const free = vi.spyOn(module, '_sqlite3_free')
      expect(api.deserialize(db, 'missing', image, image.length, image.length, 0)).toBe(SQLite.SQLITE_ERROR)
      // The wrapper releases only its schema; SQLite releases the hidden image internally.
      expect(free).toHaveBeenCalledTimes(1)
      expect(module._sqlite3_memory_used()).toBe(before)
      free.mockRestore()
    } finally {
      api.close(db)
    }
    expect(module._sqlite3_memory_used()).toBe(cleanMemory)
  })

  it('rejects invalid sizes, flags and NUL-containing schemas before allocating', async () => {
    const { api, module, open } = await environment()
    const db = open()
    try {
      const malloc = vi.spyOn(module, '_sqlite3_malloc')
      for (const [size, capacity, flags] of [
        [-1, image.length, 1],
        [image.length + 1, image.length + 1, 1],
        [1.5, image.length, 1],
        [NaN, image.length, 1],
        [Infinity, image.length, 1],
        [image.length, image.length - 1, 1],
        [image.length, 0x80000000, 1],
        [image.length, image.length, -1],
        [image.length, image.length, 1.5],
        [image.length, image.length, 0x100000000],
      ]) {
        expect(() => api.deserialize(db, 'main', image, size!, capacity!, flags!)).toThrow(
          expect.objectContaining({ code: SQLite.SQLITE_MISUSE }),
        )
      }
      expect(() => api.deserialize(db, 'main\0other', image, image.length, image.length, 1)).toThrow(
        expect.objectContaining({ code: SQLite.SQLITE_MISUSE }),
      )
      expect(malloc).not.toHaveBeenCalled()
      malloc.mockRestore()
    } finally {
      api.close(db)
    }
  })

  it('reports allocation failure without entering native deserialization', async () => {
    const { api, module, open } = await environment()
    const db = open()
    try {
      const before = module._sqlite3_memory_used()
      const malloc = vi.spyOn(module, '_sqlite3_malloc').mockReturnValueOnce(0)
      expect(api.deserialize(db, 'main', image, image.length, image.length, 1)).toBe(SQLite.SQLITE_NOMEM)
      expect(module._sqlite3_memory_used()).toBe(before)
      malloc.mockRestore()
    } finally {
      api.close(db)
    }
  })

  it('releases a real allocation on a JS copy failure before native entry', async () => {
    const { api, module, open } = await environment()
    const db = open()
    try {
      const before = module._sqlite3_memory_used()
      const failure = new Error('copy rejected before native entry')
      const copy = vi.spyOn(module.HEAPU8, 'set').mockImplementationOnce(() => {
        throw failure
      })
      expect(() => api.deserialize(db, 'main', image, image.length, image.length, 1)).toThrow(failure)
      copy.mockRestore()
      expect(module._sqlite3_memory_used()).toBe(before)
    } finally {
      api.close(db)
    }
  })

  it('does not free the image again when an error is thrown after native entry', async () => {
    const failure = new Error('injected after native schema error released the image')
    const { api, module, open } = await environment((module) => {
      const cwrap = module.cwrap.bind(module)
      module.cwrap = (...args) => {
        const native = cwrap(...args)
        return args[0] === 'sqlite3_deserialize'
          ? (...values) => {
              expect(native(...values)).toBe(SQLite.SQLITE_ERROR)
              throw failure
            }
          : native
      }
    })
    const db = open()
    try {
      const before = module._sqlite3_memory_used()
      const free = vi.spyOn(module, '_sqlite3_free')
      expect(() => api.deserialize(db, 'missing', image, image.length, image.length, 1)).toThrow(failure)
      expect(free).toHaveBeenCalledTimes(1)
      free.mockRestore()
      expect(module._sqlite3_memory_used()).toBe(before)
    } finally {
      api.close(db)
    }
  })
})
