// Zod-based required-env loader. Each service declares the vars it needs;
// requireEnv throws at boot listing every missing/invalid variable — fail
// fast, never fall back to insecure defaults.
const { z } = require('zod');

/**
 * Validate process.env against a Zod schema (or a plain shape that is
 * wrapped in z.object). Returns the parsed, typed config object.
 *
 * @param {z.ZodTypeAny|Record<string, z.ZodTypeAny>} schema
 * @param {object} [source] - defaults to process.env (injectable for tests)
 * @returns {object} parsed env
 */
function requireEnv(schema, source = process.env) {
    const zodSchema = schema instanceof z.ZodType ? schema : z.object(schema);
    const result = zodSchema.safeParse(source);
    if (!result.success) {
        const missing = result.error.issues
            .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n');
        throw new Error(`Missing or invalid environment variables:\n${missing}`);
    }
    return result.data;
}

module.exports = { requireEnv };
