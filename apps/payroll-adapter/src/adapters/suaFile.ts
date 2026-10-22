import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { httpError } from '@strafor/node-common';
import {
    SUA_MOVEMENT_LABELS,
    formatSuaLine,
    parseSuaFile,
    type SuaMovement,
    type SuaMovementType
} from '../formats.js';
import type { AdapterPeriod, PayrollAdapter, ProviderItem } from './types.js';

/**
 * sua_file — IMSS SUA movements dropped into IMPORTS_DIR:
 *
 *   period-<id>.sua.txt   (or config.file, basename only)
 *
 * Layout: fixed-width movement records — see src/formats.ts for the field
 * map ('02' alta / '07' baja / '08' modificación de salario, NSS, employee
 * ref, SBC diario en centavos, fecha AAAAMMDD).
 *
 * Mapping notes (pragmatic — SUA reports salary/movements, not a pay slip):
 *   - gross = SBC diario × calendar days in the period; '07' baja → 0
 *     (termination carries no period pay in this projection).
 *   - net = gross; deductions carries { movement, sbcDiario } for context.
 *   - providerRef = sua-<nss>-<movement>-<fecha> (idempotent re-import).
 *   - employeeId is resolved via employee_fiscal_mx.nss; unresolved lines are
 *     kept with employeeId null + unmatched: true (providerRef retained).
 *
 * Config:
 *   file:             optional filename override (basename only)
 *   registroPatronal: optional employer registration, recorded in raw
 */

const MOVEMENT_TYPES = new Set<string>(['02', '07', '08']);

function periodDays(period: AdapterPeriod): number {
    const ms = Date.parse(period.period_end) - Date.parse(period.period_start);
    return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

const compactDate = (iso: string) => iso.slice(0, 10).replaceAll('-', '');

export interface SuaAdapterCtx {
    importsDir: string;
    exportsDir?: string;
    /** Required for NSS → employee_id resolution. */
    pool?: Pool;
}

export function createSuaFileAdapter(ctx: SuaAdapterCtx): PayrollAdapter {
    function resolveFile(period: AdapterPeriod, config: Record<string, unknown>): string {
        const configured = typeof config.file === 'string' && config.file ? config.file : null;
        const name = configured ? path.basename(configured) : `period-${period.id}.sua.txt`;
        return path.join(ctx.importsDir, name);
    }

    /** Batch NSS → employee_id resolution via employee_fiscal_mx. */
    async function resolveEmployees(nssList: string[]): Promise<Map<string, number>> {
        if (!ctx.pool) {
            throw httpError(422, 'sua_file adapter requires database access for NSS resolution');
        }
        const map = new Map<string, number>();
        if (nssList.length === 0) return map;
        const { rows } = await ctx.pool.query(
            `SELECT employee_id, nss FROM employee_fiscal_mx WHERE nss = ANY($1::varchar[])`,
            [nssList]
        );
        for (const r of rows as Array<{ employee_id: number; nss: string }>) {
            map.set(String(r.nss), Number(r.employee_id));
        }
        return map;
    }

    return {
        async fetchPeriodResults(period, config) {
            const file = resolveFile(period, config);
            if (!existsSync(file)) {
                throw httpError(
                    422,
                    `SUA movements file not found for period ${period.id} (expected ${path.basename(file)} in IMPORTS_DIR)`
                );
            }
            const text = await fs.readFile(file, 'utf8');
            let movements: SuaMovement[];
            try {
                movements = parseSuaFile(text);
            } catch (err) {
                throw httpError(422, err instanceof Error ? err.message : 'Invalid SUA file');
            }

            const byNss = await resolveEmployees([...new Set(movements.map((m) => m.nss))]);
            const days = periodDays(period);
            const registroPatronal = typeof config.registroPatronal === 'string' ? config.registroPatronal : null;

            return movements.map((m): ProviderItem => {
                const employeeId = byNss.get(m.nss) ?? null;
                const sbcDiario = m.sbcCents / 100;
                const gross = m.movement === '07' ? 0 : Math.round(sbcDiario * days * 100) / 100;
                return {
                    employeeId,
                    unmatched: employeeId === null,
                    gross,
                    deductions: { movement: SUA_MOVEMENT_LABELS[m.movement], sbcDiario },
                    net: gross,
                    providerRef: `sua-${m.nss}-${m.movement}-${m.fecha}`,
                    raw: {
                        adapter: 'sua_file',
                        movement: m.movement,
                        nss: m.nss,
                        employeeRef: m.employeeRef,
                        sbcCents: m.sbcCents,
                        fecha: m.fecha,
                        registroPatronal,
                        unmatched: employeeId === null
                    }
                };
            });
        },

        /**
         * Render an IDSE-style SUA movement file (alta/baja/modif. salario
         * blocks) into EXPORTS_DIR. Field map is the same fixed-width record
         * documented in src/formats.ts. Movement type comes from
         * item.raw.movement when present, else '08' (modif. de salario — the
         * common case when exporting a payroll period). SBC is derived as
         * gross ÷ period days. NSS comes from item.raw.nss or is looked up in
         * employee_fiscal_mx by employee_id; items with neither are skipped.
         */
        async exportLayout(period, items, config) {
            if (!ctx.exportsDir) {
                throw httpError(422, 'sua_file export requires EXPORTS_DIR configured');
            }
            const days = periodDays(period);
            const fecha = compactDate(period.period_end);
            const defaultMovement = (
                typeof config.defaultMovement === 'string' && MOVEMENT_TYPES.has(config.defaultMovement)
                    ? config.defaultMovement
                    : '08'
            ) as SuaMovementType;

            // Resolve NSS for items that don't carry it in raw.
            const missing = items
                .map((i) => i.employeeId)
                .filter((id): id is number => typeof id === 'number' && id > 0);
            const nssByEmployee = new Map<number, string>();
            if (ctx.pool && missing.length > 0) {
                const { rows } = await ctx.pool.query(
                    `SELECT employee_id, nss FROM employee_fiscal_mx WHERE employee_id = ANY($1::int[])`,
                    [missing]
                );
                for (const r of rows as Array<{ employee_id: number; nss: string | null }>) {
                    if (r.nss) nssByEmployee.set(Number(r.employee_id), String(r.nss));
                }
            }

            const lines: string[] = [];
            for (const item of items) {
                const raw = (item.raw ?? {}) as Record<string, unknown>;
                const nss =
                    typeof raw.nss === 'string' && /^\d{11}$/.test(raw.nss)
                        ? raw.nss
                        : item.employeeId != null
                          ? nssByEmployee.get(item.employeeId)
                          : undefined;
                if (!nss) continue; // cannot place the employee in a SUA file

                const movement = (
                    typeof raw.movement === 'string' && MOVEMENT_TYPES.has(raw.movement)
                        ? raw.movement
                        : defaultMovement
                ) as SuaMovementType;
                const employeeRef =
                    typeof raw.employeeRef === 'string' && raw.employeeRef
                        ? raw.employeeRef
                        : String(item.employeeId ?? item.providerRef);
                const sbcCents =
                    typeof raw.sbcCents === 'number' && Number.isInteger(raw.sbcCents)
                        ? raw.sbcCents
                        : Math.round((item.gross / days) * 100);
                lines.push(
                    formatSuaLine({
                        movement,
                        nss,
                        employeeRef,
                        sbcCents: Math.max(0, sbcCents),
                        fecha: typeof raw.fecha === 'string' && /^\d{8}$/.test(raw.fecha) ? raw.fecha : fecha
                    })
                );
            }

            await fs.mkdir(ctx.exportsDir, { recursive: true });
            const file = path.join(ctx.exportsDir, `sua-movements-${period.id}.txt`);
            await fs.writeFile(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
            return { file, records: lines.length };
        },

        async validateConfig(config) {
            if (config.file !== undefined && typeof config.file !== 'string') {
                throw httpError(400, 'sua_file config.file must be a filename string');
            }
            if (config.registroPatronal !== undefined && typeof config.registroPatronal !== 'string') {
                throw httpError(400, 'sua_file config.registroPatronal must be a string');
            }
            if (config.defaultMovement !== undefined && !MOVEMENT_TYPES.has(String(config.defaultMovement))) {
                throw httpError(400, "sua_file config.defaultMovement must be '02', '07' or '08'");
            }
            try {
                await fs.access(ctx.importsDir, fs.constants.R_OK);
            } catch {
                throw httpError(400, `sua_file IMPORTS_DIR '${ctx.importsDir}' is not readable`);
            }
        }
    };
}
