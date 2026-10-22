// Shared test scaffolding: a stubbed pg Pool (no live DB — same pattern as
// hr-core/apps/api tests), a recording event publisher and a silent logger.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import type { EventPublisher } from '../src/events.js';
import { loadConfig, type ServiceConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { Express } from 'express';

export const HR = { 'X-User-Id': '2', 'X-User-Role': 'hr' };
export const HR_OTHER = { 'X-User-Id': '9', 'X-User-Role': 'hr' };
export const ADMIN = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
export const SERVICE = { 'X-Service-Token': 'test-service-token' };

export const silentLog = new Proxy({} as never, {
    get: () => () => {}
}) as ServiceLogger;

type SqlResult = { rows?: Record<string, unknown>[]; rowCount?: number };
export type SqlHandler = (text: string, params: unknown[]) => SqlResult | undefined;

export interface StubPool {
    pool: Pool;
    calls: Array<{ text: string; params: unknown[] }>;
    queryTexts(): string[];
}

/**
 * Minimal Pool stand-in. `connect()` returns a client whose query delegates
 * to the same handler, so transactional paths (BEGIN/COMMIT/ROLLBACK) are
 * recorded in `calls` too.
 */
export function stubPool(handler?: SqlHandler): StubPool {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const query = vi.fn(async (text: string, params: unknown[] = []): Promise<QueryResult> => {
        calls.push({ text, params });
        const out = handler ? await handler(text, params) : undefined;
        const rows = out?.rows ?? [];
        return {
            rows,
            rowCount: out?.rowCount ?? rows.length,
            command: '',
            oid: 0,
            fields: []
        } as unknown as QueryResult;
    });
    const client = {
        query: (t: string, p?: unknown[]) => query(t, p),
        release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
        query,
        connect: vi.fn(async () => client),
        end: vi.fn(async () => {})
    } as unknown as Pool;
    return { pool, calls, queryTexts: () => calls.map((c) => c.text) };
}

export interface RecordingPublisher extends EventPublisher {
    published: Array<{ type: string; payload: Record<string, unknown> }>;
}

export function recordingPublisher(): RecordingPublisher {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    return {
        published,
        publish: vi.fn(async (_schema: unknown, type: string, payload: Record<string, unknown>) => {
            published.push({ type, payload });
            return true;
        }) as RecordingPublisher['publish'],
        close: vi.fn(async () => {})
    };
}

export function testConfig(): ServiceConfig {
    const tmp = mkdtempSync(path.join(tmpdir(), 'payroll-test-'));
    return loadConfig({
        DATABASE_URL: 'postgres://test:test@localhost:5432/strafor_payroll',
        SERVICE_AUTH_TOKEN: 'test-service-token',
        IMPORTS_DIR: path.join(tmp, 'imports'),
        EXPORTS_DIR: path.join(tmp, 'exports')
    });
}

export function testApp(handler?: SqlHandler): { app: Express; stub: StubPool; publisher: RecordingPublisher } {
    const stub = stubPool(handler);
    const publisher = recordingPublisher();
    const app = createApp({ pool: stub.pool, config: testConfig(), publisher, log: silentLog });
    return { app, stub, publisher };
}

export const PERIOD = {
    id: 5,
    frequency: 'catorcenal',
    period_start: '2025-01-01',
    period_end: '2025-01-14',
    legal_entity: 'Strafor MX',
    status: 'draft',
    created_by: 2,
    approved_by: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};

export const SANDBOX_PROVIDER = {
    id: 2,
    name: 'sandbox_stub',
    adapter: 'sandbox_stub',
    config: { employees: [7, 8], baseGross: 15000 },
    enabled: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z'
};
