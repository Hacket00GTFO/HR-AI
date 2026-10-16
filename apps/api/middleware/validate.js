const { z } = require('zod');

/**
 * Express middleware factory: validates req.body / req.params / req.query
 * against the provided Zod schemas. On failure → 400 with details.
 * Parsed (and stripped) values are written back onto the request.
 *
 * @param {{ body?: z.ZodType, params?: z.ZodType, query?: z.ZodType }} schemas
 */
function validate(schemas) {
    return (req, res, next) => {
        try {
            if (schemas.body) {
                const result = schemas.body.safeParse(req.body);
                if (!result.success) return validationError(res, result.error);
                req.body = result.data;
            }
            if (schemas.params) {
                const result = schemas.params.safeParse(req.params);
                if (!result.success) return validationError(res, result.error);
                req.params = result.data;
            }
            if (schemas.query) {
                const result = schemas.query.safeParse(req.query);
                if (!result.success) return validationError(res, result.error);
                req.query = result.data;
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

function validationError(res, zodError) {
    return res.status(400).json({
        error: 'Validation failed',
        details: zodError.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message
        }))
    });
}

module.exports = { validate, z };
