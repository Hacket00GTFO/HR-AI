// Type declarations for CJS workspace packages and untyped vendors.
// Workspace deps (@strafor/*) ship plain JS — these are the minimal surfaces
// this service consumes.

declare module '@strafor/node-common' {
    import type { NextFunction, Request, RequestHandler, Response } from 'express';
    import type { z } from 'zod';

    export interface ServiceLogger {
        trace(obj: unknown, msg?: string): void;
        debug(obj: unknown, msg?: string): void;
        info(obj: unknown, msg?: string): void;
        warn(obj: unknown, msg?: string): void;
        error(obj: unknown, msg?: string): void;
        fatal(obj: unknown, msg?: string): void;
        child(bindings: Record<string, unknown>): ServiceLogger;
    }

    export function createLogger(options?: Record<string, unknown>, stream?: unknown): ServiceLogger;
    export const logger: ServiceLogger;

    export const CORRELATION_HEADER: string;
    export const correlationId: RequestHandler;

    export interface HttpError extends Error {
        status: number;
        details?: unknown;
    }
    export function httpError(status: number, message: string, details?: unknown): HttpError;

    export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void;
    export function notFound(req: Request, res: Response): void;

    export function requireEnv<S extends z.ZodTypeAny>(
        schema: S,
        source?: Record<string, string | undefined>
    ): z.infer<S>;

    export interface MetricsCounter {
        inc(labels?: Record<string, string>, value?: number): void;
    }
    export interface MetricsGauge {
        set(labels: Record<string, string>, value: number): void;
        inc(labels?: Record<string, string>, value?: number): void;
        dec(labels?: Record<string, string>, value?: number): void;
    }
    export interface MetricsHistogram {
        observe(labels: Record<string, string>, value: number): void;
    }
    export interface MetricsBundle {
        registry: unknown;
        httpMetricsMiddleware: RequestHandler;
        metricsHandler: (req: Request, res: Response) => void;
        counter(name: string, help: string, labelNames?: string[]): MetricsCounter;
        gauge(name: string, help: string, labelNames?: string[]): MetricsGauge;
        histogram(name: string, help: string, labelNames?: string[], buckets?: number[]): MetricsHistogram;
    }
    export function createMetrics(opts?: { serviceName?: string }): MetricsBundle;
}

declare module '@strafor/node-common/tracing' {
    export function startTracing(opts?: { serviceName?: string }): void;
}

declare module '@strafor/contracts' {
    import type { z } from 'zod';

    export const events: Record<string, z.ZodTypeAny>;
    export const EVENT_TYPES: Record<string, z.ZodTypeAny>;
    export const EmployeeCreated: z.ZodTypeAny;
    export const EmployeeUpdated: z.ZodTypeAny;
    export const EmployeeTerminated: z.ZodTypeAny;
}

declare module '@strafor/contracts/events/hr.js' {
    import type { z } from 'zod';
    export const EmployeeCreated: z.ZodTypeAny;
    export const EmployeeUpdated: z.ZodTypeAny;
    export const EmployeeTerminated: z.ZodTypeAny;
}
