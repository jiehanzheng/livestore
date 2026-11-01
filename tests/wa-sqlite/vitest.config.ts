import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    include: ['test/unit/**/*.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
