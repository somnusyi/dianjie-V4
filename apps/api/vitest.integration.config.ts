import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { shuffle: false },
    include: ['tests/**/*.integration.test.ts'],
    setupFiles: ['tests/setup/integration-database-guard.ts'],
  },
})
