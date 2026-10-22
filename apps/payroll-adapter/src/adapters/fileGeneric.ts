import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { httpError } from '@strafor/node-common';
import { z } from 'zod';
import { parseCsv } from '../csv.js';
import type { AdapterPeriod, PayrollAdapter, ProviderItem } from './types.js';

/**
 * file_generic — the real MVP import path. Provider results arrive as files
 * dropped into IMPORTS_DIR:
 *
 *   period-<id>.json   →  { "items": [...] } or a bare array
 *   period-<id>.csv    →  header: employee_id,gross,net,provider_ref,deductions
 *
 * Provider config may override the filename via `file` (a basename only —
 * path traversal outside IMPORTS_DIR is rejected) or set `format`.
 */

const itemSchema = z.object({
    employee_id: z.coerce.number().int().positive(),
    gross: z.coerce.number(),
    net: z.coerce.number(),
    provider_ref: z.string().min(1).max(200),
    deductions: z.record(z.string(), z.unknown()).optional()
});

function toItems(rawItems: unknown[], source: string): ProviderItem[] {
    return rawItems.map((raw, i) => {
        const parsed = itemSchema.safeParse(raw);
        if (!parsed.success) {
            throw httpError(422, `Invalid provider item at ${source}[${i}]`, parsed.error.issues);
        }
        const d = parsed.data;
        const rec = raw as Record<string, unknown>;
        return {
            employeeId: d.employee_id,
            gross: d.gross,
            deductions: d.deductions ?? {},
            net: d.net,
            providerRef: d.provider_ref,
            raw: rec
        };
    });
}

export function createFileGenericAdapter(importsDir: string): PayrollAdapter {
    function resolveFile(period: AdapterPeriod, config: Record<string, unknown>): string {
        const configured = typeof config.file === 'string' && config.file ? config.file : null;
        // Basename only — never let provider config escape IMPORTS_DIR.
        const name = configured ? path.basename(configured) : `period-${period.id}`;
        const candidates = configured ? [name] : [`${name}.json`, `${name}.csv`, `${name}.jsonl`];
        return (
            candidates.map((c) => path.join(importsDir, c)).find((p) => existsSync(p)) ??
            path.join(importsDir, candidates[0]!)
        );
    }

    return {
        async fetchPeriodResults(period, config) {
            const file = resolveFile(period, config);
            let text: string;
            try {
                text = await fs.readFile(file, 'utf8');
            } catch {
                throw httpError(
                    422,
                    `Provider import file not found for period ${period.id} (expected ${path.basename(file)} in IMPORTS_DIR)`
                );
            }

            if (file.endsWith('.csv')) {
                const records = parseCsv(text);
                const items = records.map((r) => ({
                    employee_id: r['employee_id'],
                    gross: r['gross'],
                    net: r['net'],
                    provider_ref: r['provider_ref'],
                    deductions: r['deductions'] ? safeJson(r['deductions']!) : undefined
                }));
                return toItems(items, path.basename(file));
            }

            let doc: unknown;
            try {
                doc = JSON.parse(text);
            } catch {
                throw httpError(422, `Provider import file ${path.basename(file)} is not valid JSON`);
            }
            const items = Array.isArray(doc) ? doc : (doc as { items?: unknown[] }).items;
            if (!Array.isArray(items)) {
                throw httpError(
                    422,
                    `Provider import file ${path.basename(file)} must be an array or { items: [...] }`
                );
            }
            return toItems(items, path.basename(file));
        },

        async validateConfig(config) {
            if (config.file !== undefined && typeof config.file !== 'string') {
                throw httpError(400, 'file_generic config.file must be a filename string');
            }
        }
    };
}

function safeJson(text: string): Record<string, unknown> | undefined {
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}
