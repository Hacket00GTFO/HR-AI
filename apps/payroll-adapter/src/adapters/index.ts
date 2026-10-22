import { httpError } from '@strafor/node-common';
import type { Pool } from 'pg';
import { createFileGenericAdapter } from './fileGeneric.js';
import { createSandboxStubAdapter } from './sandboxStub.js';
import { createSuaFileAdapter } from './suaFile.js';
import { createBankDispersionAdapter } from './bankDispersion.js';
import type { PayrollAdapter } from './types.js';

export type { AdapterPeriod, PayrollAdapter, ProviderItem } from './types.js';

export interface AdapterCtx {
    importsDir: string;
    /** Adapters that render export layouts (sua_file) need this. */
    exportsDir?: string;
    /** Adapters that resolve employees via employee_fiscal_mx need this. */
    pool?: Pool;
}

/**
 * Adapter registry — keyed by payroll_providers.adapter. Adding a provider
 * means: implement PayrollAdapter, add one line here. Routes never change.
 */
export function resolveAdapter(adapterKey: string, ctx: AdapterCtx): PayrollAdapter {
    switch (adapterKey) {
        case 'file_generic':
            return createFileGenericAdapter(ctx.importsDir);
        case 'sandbox_stub':
            return createSandboxStubAdapter();
        case 'sua_file':
            return createSuaFileAdapter(ctx);
        case 'bank_dispersion':
            return createBankDispersionAdapter(ctx.importsDir);
        default:
            throw httpError(422, `Unknown payroll adapter '${adapterKey}'`);
    }
}
