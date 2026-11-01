import { readFile } from 'node:fs/promises'

import { parse } from '@babel/parser'
import { expect, test } from 'vitest'

// Type assertions consume the referenced project's emitted declarations; parser cases below inspect its source.
import type { QuotaExceededError as ImportedQuota } from '../../../packages/@livestore/utils/dist/browser/QuotaExceededError.js'
import type { TODO as ImportedTODO, UNUSED as ImportedUNUSED } from '../../../packages/@livestore/utils/dist/global.js'

const modules = [
  '../../../packages/@livestore/utils/src/global.ts',
  '../../../packages/@livestore/utils/src/browser/QuotaExceededError.ts',
]

test.each(modules)('type exports have local bindings accepted by the supported Babel parser: %s', async (module) => {
  const source = await readFile(new URL(module, import.meta.url), 'utf8')
  expect(() => parse(source, { sourceType: 'module', plugins: ['typescript'] })).not.toThrow()
})

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

// These assertions compile against the real modules, so imports and global augmentations must stay coherent.
export type PlaceholderChecks = [
  Assert<IsAny<ImportedTODO>>,
  Assert<IsAny<ImportedTODO<'reason'>>>,
  Assert<IsAny<ImportedUNUSED>>,
  Assert<IsAny<ImportedUNUSED<'reason'>>>,
  Assert<IsAny<TODO>>,
  Assert<IsAny<TODO<'reason'>>>,
  Assert<IsAny<UNUSED>>,
  Assert<IsAny<UNUSED<'reason'>>>,
]

// @ts-expect-error Imported aliases retain the string-only reason constraint.
export type InvalidImportedTODO = ImportedTODO<42>
// @ts-expect-error Imported aliases retain the string-only reason constraint.
export type InvalidImportedUNUSED = ImportedUNUSED<42>
// @ts-expect-error Global aliases retain the string-only reason constraint.
export type InvalidGlobalTODO = TODO<42>
// @ts-expect-error Global aliases retain the string-only reason constraint.
export type InvalidGlobalUNUSED = UNUSED<42>

export type QuotaChecks = [
  Assert<IsAny<ImportedQuota> extends false ? true : false>,
  Assert<IsAny<ImportedQuota['quota']> extends false ? true : false>,
  Assert<IsAny<ImportedQuota['requested']> extends false ? true : false>,
  Assert<ImportedQuota extends globalThis.QuotaExceededError ? true : false>,
  Assert<globalThis.QuotaExceededError extends ImportedQuota ? true : false>,
  Assert<ImportedQuota extends DOMException ? true : false>,
  Assert<ImportedQuota['quota'] extends number | null ? true : false>,
  Assert<ImportedQuota['requested'] extends number | null ? true : false>,
  Assert<number | null extends ImportedQuota['quota'] ? true : false>,
  Assert<number | null extends ImportedQuota['requested'] ? true : false>,
  Assert<InstanceType<typeof globalThis.QuotaExceededError> extends ImportedQuota ? true : false>,
  Assert<
    ConstructorParameters<typeof globalThis.QuotaExceededError> extends [
      message?: string,
      options?: { quota?: number; requested?: number },
    ]
      ? true
      : false
  >,
]
