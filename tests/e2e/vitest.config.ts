import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['*.test.ts'],
        // Live HTTP calls against the compose stack can be slow under load.
        // Serial files: parallel workers stall each other on Docker Desktop's
        // port forwarding; the retry budget (timeout + 429 backoff) needs a
        // larger per-test ceiling.
        fileParallelism: false,
        testTimeout: 90000,
        hookTimeout: 90000
    }
});
