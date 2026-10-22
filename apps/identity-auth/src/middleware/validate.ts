import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

interface Schemas {
    body?: z.ZodType;
    params?: z.ZodType;
    query?: z.ZodType;
}

/** Zod validation middleware — 400 {error, details} on failure. */
export function validate(schemas: Schemas): RequestHandler {
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
                req.params = result.data as typeof req.params;
            }
            if (schemas.query) {
                const result = schemas.query.safeParse(req.query);
                if (!result.success) return validationError(res, result.error);
                Object.defineProperty(req, 'query', { value: result.data, writable: true });
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

function validationError(res: Response, zodError: z.ZodError): Response {
    return res.status(400).json({
        error: 'Validation failed',
        details: zodError.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message
        }))
    });
}
