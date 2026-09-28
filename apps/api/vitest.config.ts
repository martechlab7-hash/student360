import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    fileParallelism: false, // files share one database and one outbox
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://s360_app:s360_app_dev@localhost:5432/student360_test',
      DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://s360_owner:s360_owner_dev@localhost:5432/student360_test',
      JOB_MODE: 'inline',
      AI_DEFAULT_PROVIDER: 'mock',
      PLATFORM_ADMIN_TOKEN: 'test-platform-token-0123456789abcdef',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MULTIPLIER: '1000',
    },
  },
});
