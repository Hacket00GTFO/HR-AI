import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        testTimeout: 20000,
        hookTimeout: 30000,
        // Integration files share one test database and each runs migrations
        // in beforeAll — running files in parallel trips node-pg-migrate's
        // advisory lock.
        fileParallelism: false
    }
});
