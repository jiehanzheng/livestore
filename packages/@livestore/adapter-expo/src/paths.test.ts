import { expect, test, vi } from 'vitest'
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: '/sqlite' }))
import { liveStoreStorageFormatVersion } from '@livestore/common'
vi.mock('@livestore/common/schema', async (original) => ({
  ...(await original<object>()),
  getStateDbBaseName: () => 'state-hash',
}))
import type { LiveStoreSchema } from '@livestore/common/schema'

import { expoPersistencePaths } from './paths.ts'
const schema = {} as LiveStoreSchema

test('uses canonical state name and preserves URI directory scheme', () => {
  expect(
    expoPersistencePaths('store', schema, { directory: 'file:///documents/sqlite/', subDirectory: 'graphs/nested/' }),
  ).toEqual({
    baseDirectory: 'file:///documents/sqlite/',
    segments: ['graphs', 'nested', 'store'],
    directory: 'file:///documents/sqlite/graphs/nested/store',
    stateDatabaseName: `state-hash@${liveStoreStorageFormatVersion}.db`,
    eventlogDatabaseName: `livestore-eventlog@${liveStoreStorageFormatVersion}.db`,
  })
  expect(expoPersistencePaths('store', schema).directory).toBe('/sqlite/store')
  expect(expoPersistencePaths('store', schema, { directory: 'file:///' }).directory).toBe('file:///store')
})
test.each(['.', '..', '../other', '/absolute', 'nested/../other', 'a\\b', 'a\0b', 'a?b'])(
  'refuses unsafe storage suffix %j',
  (value) => {
    expect(() => expoPersistencePaths(value, schema)).toThrow()
    expect(() => expoPersistencePaths('store', schema, { subDirectory: value })).toThrow()
  },
)
test.each(['relative', '/sqlite/../other', 'file:///sqlite/./other'])('refuses unsafe base %j', (directory) => {
  expect(() => expoPersistencePaths('store', schema, { directory })).toThrow()
})
