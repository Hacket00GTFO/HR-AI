// Minimal typings for the CJS workspace package @strafor/node-common.
declare module '@strafor/node-common' {
    import type { NextFunction, Request, RequestHandler, Response } from 'express';

    export const logger: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        child: (bindings: Record<string, unknown>) => typeof logger;
    };

    export function createLogger(options?: Record<string, unknown>, stream?: unknown): typeof logger;

    export const correlationId: RequestHandler;
    export const CORRELATION_HEADER: string;

    export interface HttpError extends Error {
        status: number;
        details?: unknown;
    }
    export function httpError(status: number, message: string, details?: unknown): HttpError;
    export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void;
    export function notFound(req: Request, res: Response): void;
    export function requireEnv(schema: unknown, source?: unknown): Record<string, unknown>;

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
