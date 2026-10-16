// Vitest config for the Express monolith. Test files import server.js in
// beforeAll — a cold require of the full CJS dependency tree. On Windows that
// easily exceeds the default 10s hook timeout when several files run in
// parallel, so hooks/tests get generous budgets while keeping parallelism.
export default {
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
        testTimeout: 30000,
        hookTimeout: 60000
    }
};
