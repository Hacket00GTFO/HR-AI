import { z } from 'zod';

// ── HR survey-console wire schemas + pure helpers (/portal/surveys) ─────────
// Verified upstream contract (hr-services src/routes/surveys.ts, role 'hr'):
//   GET  /v1/surveys             → Survey[] (BARE array, responseCount incl.)
//   POST /v1/surveys             → 201 Survey + questions. STRICT body:
//                                  { title, type: 'nom035'|'climate',
//                                    opensAt?, closesAt? (ISO datetime|null),
//                                    questions: [{ dimension, text,
//                                    scale (2..10, default 5),
//                                    healthRelated (default false) }] }
//   POST /v1/surveys/:id/open    draft → open (409 otherwise)
//   POST /v1/surveys/:id/close   open → closed; computes k-anonymised aggs
//   GET  /v1/surveys/:id         → Survey + { questions }
//   GET  /v1/surveys/:id/results → { surveyId, status, respondents,
//                                  minGroupSize, results: AggResult[] }
//
// k-anonymity: a (group, dimension) cell below minGroupSize respondents comes
// back as { group, dimension, suppressed: true, reason: 'k<minK' } with HTTP
// 200 — NEVER render those as empty/zero cells; they carry no data at all.

const isoOrNull = z.string().nullable().optional().default(null);

export const surveyQuestionSchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        dimension: z.string().optional().default(''),
        text: z.string().optional().default(''),
        scale: z.coerce.number().optional().default(5),
        healthRelated: z.boolean().optional().default(false),
        position: z.coerce.number().optional()
    })
    .loose();
export type SurveyQuestion = z.infer<typeof surveyQuestionSchema>;

export const surveySchema = z
    .object({
        id: z.union([z.number(), z.string()]),
        title: z.string().optional().default(''),
        type: z.string().optional().default(''),
        status: z.string().optional().default('draft'),
        opensAt: isoOrNull,
        closesAt: isoOrNull,
        responseCount: z.coerce.number().optional(),
        createdAt: isoOrNull,
        updatedAt: isoOrNull,
        questions: z.array(surveyQuestionSchema).optional().default([])
    })
    .loose();
export type Survey = z.infer<typeof surveySchema>;

export const surveyListResponseSchema = z.union([
    z.array(surveySchema),
    z.object({ surveys: z.array(surveySchema) }).loose(),
    z.object({ data: z.array(surveySchema) }).loose()
]);
export type SurveyListResponse = z.infer<typeof surveyListResponseSchema>;

// ── results ─────────────────────────────────────────────────────────────────

export const surveyResultCellSchema = z
    .object({
        group: z.string().optional().default(''),
        dimension: z.string().optional().default(''),
        respondents: z.coerce.number().optional(),
        avgScore: z.coerce.number().nullable().optional(),
        suppressed: z.boolean().optional(),
        reason: z.string().optional()
    })
    .loose();
export type SurveyResultCell = z.infer<typeof surveyResultCellSchema>;

export const surveyResultsResponseSchema = z
    .object({
        surveyId: z.union([z.number(), z.string()]).optional(),
        status: z.string().optional().default(''),
        respondents: z.coerce.number().optional().default(0),
        minGroupSize: z.coerce.number().optional().default(5),
        results: z.array(surveyResultCellSchema).optional().default([])
    })
    .loose();
export type SurveyResults = z.infer<typeof surveyResultsResponseSchema>;

// ── pure helpers ────────────────────────────────────────────────────────────

/** Unwrap whichever list envelope the upstream returned. */
export function normalizeSurveys(data: SurveyListResponse): Survey[] {
    if (Array.isArray(data)) return data;
    const d = data as { surveys?: Survey[]; data?: Survey[] };
    return d.surveys ?? d.data ?? [];
}

/** True when the cell is a k-anonymity suppression placeholder. */
export function isSuppressedResult(cell: Pick<SurveyResultCell, 'suppressed'>): boolean {
    return cell.suppressed === true;
}

/** Parse the anonymity threshold out of a 'k<5' reason; null when absent. */
export function suppressionMinK(reason: string | undefined): number | null {
    if (!reason) return null;
    const m = /^k<(\d+)$/.exec(reason.trim());
    return m ? Number(m[1]) : null;
}

/** Effective threshold for a suppressed cell: reason wins, else the payload default. */
export function cellThreshold(cell: SurveyResultCell, fallback: number): number {
    return suppressionMinK(cell.reason) ?? fallback;
}

/** Human label for a group — '_all' is the upstream catch-all bucket. */
export function groupLabel(group: string, allLabel: string): string {
    return group === '_all' || group === '' ? allLabel : group;
}

/**
 * Pivot flat cells into a dimension→group matrix for the results table.
 * Returns { groups, rows } where rows[i].cells[j] aligns with groups[j];
 * missing (dimension, group) combos get null.
 */
export function pivotResults(results: SurveyResultCell[]): {
    groups: string[];
    rows: { dimension: string; cells: (SurveyResultCell | null)[] }[];
} {
    const groups: string[] = [];
    const byDim = new Map<string, Map<string, SurveyResultCell>>();
    for (const cell of results) {
        const g = cell.group || '_all';
        if (!groups.includes(g)) groups.push(g);
        let dim = byDim.get(cell.dimension);
        if (!dim) {
            dim = new Map();
            byDim.set(cell.dimension, dim);
        }
        dim.set(g, cell);
    }
    groups.sort((a, b) => (a === '_all' ? -1 : b === '_all' ? 1 : a.localeCompare(b)));
    const rows = [...byDim.entries()].map(([dimension, dim]) => ({
        dimension,
        cells: groups.map((g) => dim.get(g) ?? null)
    }));
    return { groups, rows };
}

/** Display string for an aggregate score — one decimal, '—' when null. */
export function formatAvgScore(score: number | null | undefined): string {
    if (score === null || score === undefined || !Number.isFinite(score)) return '—';
    return score.toFixed(1);
}
