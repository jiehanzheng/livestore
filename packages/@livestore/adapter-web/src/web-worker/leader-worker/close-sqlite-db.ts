import type { SqliteDb } from '@livestore/common'
import { Effect } from '@livestore/utils/effect'

// Owner completion must retain close failures so it cannot be mistaken for successful cleanup.
export const closeSqliteDb = (db: Pick<SqliteDb, 'close'>): Effect.Effect<void> => Effect.sync(() => db.close())
