import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Each test file can take up to 60s (network + DB)
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run all test files sequentially in a single process so shared DB state is predictable
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: { shuffle: false },
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
})
