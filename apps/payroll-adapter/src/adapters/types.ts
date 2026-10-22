/**
 * Adapter contract — every payroll provider plugs in through this interface.
 * Routes never know which provider serves a period; they resolve the adapter
 * from payroll_providers.adapter via the registry in ./index.ts.
 */

/** One normalized line item as returned by a provider for a period. */
export interface ProviderItem {
    /**
     * Internal employee id — null when the provider line could not be matched
     * to an employee (e.g. SUA NSS with no employee_fiscal_mx row). Unmatched
     * items are still persisted (providerRef retained) with status 'unmatched'.
     */
    employeeId: number | null;
    /** True when employeeId resolution failed — kept even if id is later set. */
    unmatched?: boolean;
    gross: number;
    /** Provider-specific deduction breakdown (ISR, IMSS, loans…). */
    deductions: Record<string, unknown>;
    net: number;
    /** Provider-side unique line reference — import idempotency key. */
    providerRef: string;
    /** Original provider payload, retained verbatim for audit. */
    raw: Record<string, unknown>;
}

/** Period shape passed to adapters (mirrors payroll_periods). */
export interface AdapterPeriod {
    id: number;
    frequency: 'catorcenal' | 'mensual';
    period_start: string;
    period_end: string;
    legal_entity: string | null;
}

export interface PayrollAdapter {
    /** Fetch the provider's computed results for a period. */
    fetchPeriodResults(period: AdapterPeriod, config: Record<string, unknown>): Promise<ProviderItem[]>;
    /** Validate provider config at enable/configure time (throw on invalid). */
    validateConfig(config: Record<string, unknown>): Promise<void>;
    /**
     * Optional: render a provider-layout file (e.g. SUA movements) for the
     * given period items into the adapter's export dir. Returns the file path
     * and record count.
     */
    exportLayout?(
        period: AdapterPeriod,
        items: ProviderItem[],
        config: Record<string, unknown>
    ): Promise<{ file: string; records: number }>;
}
