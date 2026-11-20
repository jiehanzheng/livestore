import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { root: import.meta.dirname, environment: 'node', include: ['test/**/*.test.tsx'] },
})
