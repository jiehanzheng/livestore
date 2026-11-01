import { defineProject } from 'vitest/config'
export default defineProject({
  test: {
    name: '@livestore/adapter-node',
    root: import.meta.dirname,
    include: ['src/**/*.test.{ts,js}'],
    fileParallelism: false,
  },
})
