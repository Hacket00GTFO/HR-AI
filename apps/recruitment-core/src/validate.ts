import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

/**
 * Express middleware factory: validates req.body / req.params / req.query
 * against the provided Zod schemas. On failure → 400 with details.
 * Parsed (and stripped) values are written back onto the request.
 * (Ported from the monolith's middleware/validate.js — same error shape.)
 */
export function validate(schemas: { body?: z.ZodType; params?: z.ZodType; query?: z.ZodType }): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            if (schemas.body) {
                const result = schemas.body.safeParse(req.body);
                if (!result.success) return validationError(res, result.error);
                req.body = result.data;
            }
            if (schemas.params) {
                const result = schemas.params.safeParse(req.params);
                if (!result.success) return validationError(res, result.error);
                req.params = result.data as Request['params'];
            }
            if (schemas.query) {
                const result = schemas.query.safeParse(req.query);
                if (!result.success) return validationError(res, result.error);
                req.query = result.data as Request['query'];
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

export function validationError(res: Response, zodError: z.ZodError) {
    return res.status(400).json({
        error: 'Validation failed',
        details: zodError.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message
        }))
    });
}
