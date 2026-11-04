import path from 'node:path'

import { defineConfig } from 'vitest/config'

const root = path.resolve(import.meta.dirname, '../..')

// Explicit owners prevent a root directory scan from silently adding or omitting qualification projects.
export default defineConfig({
  test: {
    projects: [
      'packages/@livestore/sqlite-wasm/vitest.config.ts',
      'packages/@livestore/adapter-node/vitest.config.ts',
      'packages/@livestore/adapter-expo/vitest.config.ts',
      'packages/@livestore/react/vitest.config.ts',
      'packages/@livestore/common/vitest.config.ts',
      'packages/@livestore/livestore/vitest.config.ts',
      'packages/@livestore/adapter-web/vitest.config.ts',
      'tests/package-common/vitest.config.ts',
      'tests/wa-sqlite/vitest.config.ts',
    ].map((config) => path.join(root, config)),
  },
})
