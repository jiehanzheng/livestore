import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const load = vi.hoisted(() => vi.fn())
vi.mock('@livestore/sqlite-wasm/load-wasm', () => ({ loadSqlite3Wasm: load }))
beforeEach(() => {
  vi.resetModules()
  load.mockReset()
  load.mockImplementation(async () => ({}))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const browser = async () => {
  vi.stubGlobal('window', {})
  vi.stubEnv('SSR', false)
  return import('./sqlite-loader.ts')
}

test('twenty browser memory sessions share the eager API and only one wasm load', async () => {
  const loader = await browser()
  expect(load).toHaveBeenCalledTimes(1)
  const apis = await Promise.all(Array.from({ length: 20 }, () => loader.loadInMemorySqlite3()))
  expect(new Set(apis).size).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
})

test('server evaluation performs no eager native load and retains deferred per-call loading', async () => {
  vi.stubGlobal('window', undefined)
  vi.stubEnv('SSR', true)
  const loader = await import('./sqlite-loader.ts')
  expect(load).not.toHaveBeenCalled()
  expect(await loader.loadInMemorySqlite3()).not.toBe(await loader.loadInMemorySqlite3())
  expect(load).toHaveBeenCalledTimes(2)
})
