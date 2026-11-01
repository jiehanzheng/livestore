import { readFileSync } from 'node:fs'

import { beforeAll, describe, expect, it } from 'vitest'

import type { SQLiteAPI } from '@livestore/wa-sqlite'

import { exportDb, importDb, loadSqlite3Wasm, select } from '../lib/sqlite-utils.ts'
import { largeDatabasePath } from '../setup/database-setup.ts'

describe('500MB serialize/deserialize performance', () => {
  let sqlite3: SQLiteAPI
  beforeAll(async () => {
    sqlite3 = await loadSqlite3Wasm()
  })

  it('should handle large database (500MB+) import/export with timing', () => {
    // globalSetup must produce the fixture; a missing file is a failing job, never a passing skip.
    const largeDbData = readFileSync(largeDatabasePath)

    console.log(`\nLarge database size: ${(largeDbData.length / 1024 / 1024).toFixed(2)} MB`)

    // Create in-memory database
    const db = sqlite3.open_v2Sync(':memory:', 0, undefined)

    try {
      // Time the import operation
      const importStart = performance.now()
      importDb(sqlite3, db, largeDbData)
      const importEnd = performance.now()
      const importTime = importEnd - importStart

      console.log(`Import time: ${importTime.toFixed(2)} ms`)

      // Verify the data was imported correctly
      const tables = select(sqlite3, db, "SELECT name FROM sqlite_master WHERE type='table'")
      expect(tables.length).toBeGreaterThan(0)
      console.log(`Tables imported: ${tables.length}`)

      // Get row counts for verification
      const userCount = select(sqlite3, db, 'SELECT COUNT(*) as count FROM users')[0]?.count || 0
      const postCount = select(sqlite3, db, 'SELECT COUNT(*) as count FROM posts')[0]?.count || 0
      const commentCount = select(sqlite3, db, 'SELECT COUNT(*) as count FROM comments')[0]?.count || 0

      console.log(`Rows imported - Users: ${userCount}, Posts: ${postCount}, Comments: ${commentCount}`)

      expect(userCount).toBeGreaterThan(0)
      expect(postCount).toBeGreaterThan(0)
      expect(commentCount).toBeGreaterThan(0)

      // Time the export operation
      const exportStart = performance.now()
      const exported = exportDb(sqlite3, db)
      const exportEnd = performance.now()
      const exportTime = exportEnd - exportStart

      console.log(`Export time: ${exportTime.toFixed(2)} ms`)
      console.log(`Exported database size: ${(exported.length / 1024 / 1024).toFixed(2)} MB`)

      // Verify the export is valid
      expect(exported[0]).toBe(0x53)
      expect(exported.length).toBeGreaterThan(500 * 1024 * 1024) // Should be at least 500MB

      console.log(`Total operation time: ${(importTime + exportTime).toFixed(2)} ms`)

      // Performance assertions (adjust these based on your requirements)
      expect(importTime).toBeLessThan(30_000) // Should import within 30 seconds
      expect(exportTime).toBeLessThan(30_000) // Should export within 30 seconds
    } finally {
      sqlite3.close(db)
    }
  })
})
