import { httpError } from '@strafor/node-common';
import type { PayrollAdapter, ProviderItem } from './types.js';

/**
 * sandbox_stub — deterministic fake provider for dev/tests. Emits one item
 * per employee id in config.employees (default [1]); amounts are pure
 * functions of (period id, employee id) so repeated imports and reconcile
 * runs are reproducible.
 *
 * Config:
 *   employees: number[]   employee ids to generate (default [1])
 *   baseGross: number     base salary before per-employee bump (default 15000)
 *   netRatio:  number     net = gross * ratio, rounded to cents (default 0.8)
 */
export function createSandboxStubAdapter(): PayrollAdapter {
    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
        async fetchPeriodResults(period, config) {
            const employees = Array.isArray(config.employees)
                ? (config.employees as unknown[]).filter(
                      (e): e is number => typeof e === 'number' && Number.isInteger(e) && e > 0
                  )
                : [1];
            const baseGross = typeof config.baseGross === 'number' ? config.baseGross : 15000;
            const netRatio = typeof config.netRatio === 'number' ? config.netRatio : 0.8;

            return employees.map((employeeId): ProviderItem => {
                const gross = round2(baseGross + employeeId * 100 + (period.frequency === 'mensual' ? 2000 : 0));
                const net = round2(gross * netRatio);
                const providerRef = `stub-${period.id}-${employeeId}`;
                return {
                    employeeId,
                    gross,
                    deductions: { isr: round2(gross - net), imss: 0 },
                    net,
                    providerRef,
                    raw: { adapter: 'sandbox_stub', periodId: period.id, employeeId, gross, net }
                };
            });
        },

        async validateConfig(config) {
            if (config.employees !== undefined) {
                const ok =
                    Array.isArray(config.employees) &&
                    (config.employees as unknown[]).every((e) => Number.isInteger(e) && (e as number) > 0);
                if (!ok) throw httpError(400, 'sandbox_stub config.employees must be an array of positive integers');
            }
        }
    };
}
