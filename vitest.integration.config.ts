import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/greenmail.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One mail server shared by all files: run files sequentially.
    fileParallelism: false,
  },
});
