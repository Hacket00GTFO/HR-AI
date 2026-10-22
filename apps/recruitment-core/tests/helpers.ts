// Test harness — no live DB, no broker. The route layer is what is under
// test: the pg Pool is replaced by a recording fake client (withTransaction
// is exercised for real), the publisher is a stub, and model/serviceClient
// modules are vi.mock'd per file.
import { vi } from 'vitest';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from '../src/config.js';
import type { EventPublisher } from '../src/events.js';
import type { ServiceDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface FakeClient {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    calls: Array<{ sql: string; params: unknown[] }>;
}

/**
 * Recording stand-in for a pg PoolClient/Pool. `handlers` map a SQL substring
 * (lowercased match) to rows — first match wins; default { rows: [] }.
 */
export function makeFakeDb(handlers: Array<[string, Row[]]> = []): { pool: Pool; client: FakeClient } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const lower = sql.toLowerCase();
        for (const [needle, rows] of handlers) {
            if (lower.includes(needle.toLowerCase())) return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
    });
    const client: FakeClient = { query, release: vi.fn(), calls };
    const pool = {
        connect: vi.fn(async () => client),
        query,
        end: vi.fn(async () => undefined)
    } as unknown as Pool;
    return { pool, client };
}

export const testConfig: ServiceConfig = {
    NODE_ENV: 'test',
    PORT: 3009,
    SERVICE_NAME: 'recruitment-core',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AI_SERVICE_URL: 'http://ai-matching:3005',
    AI_MIN_MATCH_SCORE: 0.35,
    DOCUMENTS_URL: 'http://documents-resumes:3004',
    SERVICE_AUTH_TOKEN: 'test-service-token',
    SERVICE_CALLER_USER_ID: 1,
    RESUMES_DIR: undefined,
    RABBITMQ_URL: undefined,
    RABBITMQ_EXCHANGE: 'domain.events',
    OUTBOX_POLL_MS: 15000,
    MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
    PUBLIC_APPLY_RATE_MAX: 20,
    PUBLIC_APPLY_RATE_WINDOW_MS: 60 * 60 * 1000
} as ServiceConfig;

export const nullLog: ServiceLogger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => nullLog
};

export function makePublisher(): EventPublisher & { publish: ReturnType<typeof vi.fn> } {
    return {
        publish: vi.fn(async () => true),
        isConnected: vi.fn(() => true),
        close: vi.fn(async () => undefined)
    };
}

export function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
    return {
        pool: makeFakeDb().pool,
        config: testConfig,
        publisher: makePublisher(),
        log: nullLog,
        ...overrides
    };
}

export function makeApp(deps: ServiceDeps): Express {
    return createApp(deps);
}

// Gateway-injected identity headers the service trusts.
export const HR_HEADERS = { 'X-User-Id': '5', 'X-User-Role': 'hr' };
export const ADMIN_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
export const SVC_HEADERS = { 'X-Service-Token': 'test-service-token' };

export const VALID_PDF = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]);
export const VALID_DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
export const FAKE_PDF = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]); // MZ exe
