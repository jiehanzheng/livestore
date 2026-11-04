import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'

/**
 * Frontend snapshot/session databases share one memory-only API. Physical leaders
 * load their own native API directly inside their dedicated worker context.
 * Eager browser loading hides download/compilation latency; Workerd forbids
 * asynchronous module-evaluation fetches, so server loading remains deferred.
 */
const isServerRuntime = String(import.meta.env?.SSR) === 'true' || typeof window === 'undefined'
const memoryPromise = isServerRuntime === false ? loadSqlite3Wasm() : undefined

export const loadInMemorySqlite3 = () =>
  isServerRuntime === true ? loadSqlite3Wasm() : (memoryPromise ?? loadSqlite3Wasm())
