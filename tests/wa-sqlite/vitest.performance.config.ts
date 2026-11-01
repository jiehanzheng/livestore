import { defineConfig } from 'vitest/config'

// This opt-in job owns the large fixture generation and retains the original timing thresholds.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/performance/**/*.test.ts'],
    globalSetup: ['test/setup/database-setup.ts'],
    testTimeout: 120_000,
  },
})
