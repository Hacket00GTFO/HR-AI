// Shared test scaffolding: stubbed identity pg pool, recording fetch stub,
// recording logger (for the no-PII assertion) and in-memory metrics.
import { vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import type { SyncMetrics } from '../src/metrics.js';

export const TOKEN = 'test-service-token';

export function testConfig(overrides: Record<string, string> = {}): ServiceConfig {
    return loadConfig({
        IDENTITY_DATABASE_URL: 'postgres://test:test@localhost:5432/strafor_identity',
        SERVICE_AUTH_TOKEN: TOKEN,
        // Deterministic cycles: no retries unless a test opts in.
        SYNC_RETRY_MAX: '0',
        SYNC_RETRY_BASE_MS: '1',
        ...overrides
    });
}

/** Pool stub whose first non-`SELECT 1` query returns `rows` (or throws). */
export function stubIdentityPool(rows: Record<string, unknown>[] | Error): Pool {
    return {
        query: vi.fn(async (text: string): Promise<QueryResult> => {
            if (text === 'SELECT 1') {
                return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult;
            }
            if (rows instanceof Error) throw rows;
            return {
                rows,
                rowCount: rows.length,
                command: '',
                oid: 0,
                fields: []
            } as unknown as QueryResult;
        }),
        end: vi.fn(async () => {})
    } as unknown as Pool;
}

export interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

export type FetchHandler = (call: FetchCall) => { status?: number; data?: unknown };

/**
 * fetch stand-in: records every call (parsed JSON body) and answers via
 * `handler`. Default handler: 200 `{}` for POST, `[]` for GET, 204 for DELETE.
 */
export function stubFetch(handler?: FetchHandler): { fetchImpl: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (
        input: unknown,
        init?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => {
        const call: FetchCall = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers: init?.headers ?? {},
            body: init?.body ? JSON.parse(init.body) : undefined
        };
        calls.push(call);
        const out = handler
            ? handler(call)
            : call.method === 'DELETE'
              ? { status: 204 }
              : { data: call.method === 'GET' ? [] : {} };
        const status = out.status ?? 200;
        if (status === 204) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(out.data ?? {}), {
            status,
            headers: { 'content-type': 'application/json' }
        });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

// ---- recording logger: keeps every logged object for PII assertions ----

export interface LogEntry {
    level: string;
    obj: unknown;
    msg?: string;
}

export function recordingLogger(): { log: ServiceLogger; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const make =
        (level: string) =>
        (obj: unknown, msg?: string): void => {
            entries.push(msg !== undefined ? { level, obj, msg } : { level, obj });
        };
    const log = {
        trace: make('trace'),
        debug: make('debug'),
        info: make('info'),
        warn: make('warn'),
        error: make('error'),
        fatal: make('fatal'),
        child: () => log
    } as unknown as ServiceLogger;
    return { log, entries };
}

// ---- in-memory metrics ----

export interface RecordedInc {
    labels: Record<string, string>;
    value: number;
}

export function stubMetrics(): {
    metrics: SyncMetrics;
    runs: RecordedInc[];
    rows: RecordedInc[];
    durations: Record<string, string>[];
} {
    const runs: RecordedInc[] = [];
    const rows: RecordedInc[] = [];
    const durations: Record<string, string>[] = [];
    const metrics: SyncMetrics = {
        runs: {
            inc: (labels: Record<string, string> = {}, value = 1) => {
                runs.push({ labels, value });
            }
        },
        rows: {
            inc: (labels: Record<string, string> = {}, value = 1) => {
                rows.push({ labels, value });
            }
        },
        duration: {
            observe: (labels: Record<string, string>) => {
                durations.push(labels);
            }
        }
    };
    return { metrics, runs, rows, durations };
}
