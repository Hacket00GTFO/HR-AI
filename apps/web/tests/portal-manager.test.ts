import { describe, it, expect } from 'vitest';
import {
    flattenOrgTree,
    normalizeOrgTree,
    orgHeadName,
    orgSubtreeCount,
    orgTotalCount
} from '@/components/portal/org-lib';
import {
    attendanceCorrectionsResponseSchema,
    balanceSummaryParts,
    balancesFor,
    callerEmployeeId,
    employeeDisplayName,
    normalizeCorrections,
    normalizeTeamEmployees,
    pendingCorrectionsFor,
    teamEmployeesResponseSchema
} from '@/components/portal/team-lib';
import {
    cellThreshold,
    formatAvgScore,
    groupLabel,
    isSuppressedResult,
    normalizeSurveys,
    pivotResults,
    suppressionMinK,
    surveyListResponseSchema,
    surveyResultsResponseSchema,
    type SurveyResultCell
} from '@/components/portal/surveys-lib';
import type { LeaveBalance } from '@/components/portal/schemas';
import type { OrgNode } from '@/components/portal/org-lib';

const dept = (over: Partial<OrgNode>): OrgNode => ({
    id: 1,
    name: 'Engineering',
    code: null,
    head: null,
    employeeCount: 0,
    status: 'active',
    location: null,
    children: [],
    ...over
});

describe('org tree helpers', () => {
    const tree: OrgNode[] = [
        dept({
            id: 1,
            name: 'Ops',
            employeeCount: 4,
            children: [
                dept({ id: 2, name: 'Infra', employeeCount: 3 }),
                dept({ id: 3, name: 'QA', employeeCount: 2, children: [dept({ id: 4, employeeCount: 1 })] })
            ]
        }),
        dept({ id: 5, name: 'Sales', employeeCount: 7 })
    ];

    it('sums subtree headcounts recursively', () => {
        expect(orgSubtreeCount(tree[0]!)).toBe(10);
        expect(orgTotalCount(tree)).toBe(17);
    });

    it('flattens depth-first with depth markers', () => {
        const flat = flattenOrgTree(tree);
        expect(flat.map((f) => [f.node.id, f.depth])).toEqual([
            [1, 0],
            [2, 1],
            [3, 1],
            [4, 2],
            [5, 0]
        ]);
    });

    it('unwraps both envelopes ({departments} and bare array)', () => {
        expect(normalizeOrgTree({ departments: tree })).toHaveLength(2);
        expect(normalizeOrgTree(tree)).toHaveLength(2);
        expect(normalizeOrgTree({} as never)).toEqual([]);
    });

    it('formats head names and tolerates missing heads', () => {
        expect(orgHeadName(dept({ head: { firstName: 'Ana', lastName: 'Ruiz' } }))).toBe('Ana Ruiz');
        expect(orgHeadName(dept({ head: null }))).toBeNull();
        expect(orgHeadName(dept({ head: { firstName: null, lastName: null } }))).toBeNull();
    });
});

describe('team helpers', () => {
    it('parses camelCase and snake_case employee rows', () => {
        const camel = teamEmployeesResponseSchema.parse([
            { id: 7, firstName: 'Ana', lastName: 'Ruiz', position: 'Dev', department: 'Eng', status: 'active' }
        ]);
        const snake = teamEmployeesResponseSchema.parse({
            employees: [{ id: 8, first_name: 'Luis', last_name: 'Paz', status: 'active' }]
        });
        const rows = [...normalizeTeamEmployees(camel), ...normalizeTeamEmployees(snake)];
        expect(employeeDisplayName(rows[0]!)).toBe('Ana Ruiz');
        expect(employeeDisplayName(rows[1]!)).toBe('Luis Paz');
    });

    it('falls back to #id when no name fields exist', () => {
        const rows = normalizeTeamEmployees(teamEmployeesResponseSchema.parse([{ id: 42 }]));
        expect(employeeDisplayName(rows[0]!)).toBe('#42');
    });

    it('resolves the caller employee id (employeeId > employee_id > id, "me" fallback)', () => {
        expect(callerEmployeeId({ id: 5, employeeId: 9 })).toBe(9);
        expect(callerEmployeeId({ id: 5, employee_id: 11 })).toBe(11);
        expect(callerEmployeeId({ id: 5 })).toBe(5);
        expect(callerEmployeeId({ id: 'abc' })).toBe('me');
        expect(callerEmployeeId(null)).toBeNull();
    });

    const balances = [
        { leaveTypeId: 1, year: 2026, entitled: 12, used: 2, carried: 0, available: 10, employeeId: 7 },
        { leaveTypeId: 2, year: 2026, entitled: 5, used: 0, carried: 0, available: 5, employeeId: '7' }
    ] as LeaveBalance[];

    it('filters balances by employee across number/string ids', () => {
        expect(balancesFor(balances, 7)).toHaveLength(2);
        expect(balancesFor(balances, '7')).toHaveLength(2);
        expect(balancesFor(balances, 9)).toHaveLength(0);
        expect(balancesFor(balances, null)).toEqual([]);
    });

    it('summarizes balances via a type-name resolver', () => {
        const parts = balanceSummaryParts(balances, (id) => (id === 1 ? 'Vacaciones' : 'Permiso'));
        expect(parts).toEqual([
            { label: 'Vacaciones', available: 10 },
            { label: 'Permiso', available: 5 }
        ]);
    });

    it('filters pending corrections for a member only', () => {
        const data = attendanceCorrectionsResponseSchema.parse({
            corrections: [
                { id: 1, employeeId: 7, status: 'pending' },
                { id: 2, employeeId: 7, status: 'approved' },
                { id: 3, employeeId: 8, status: 'pending' }
            ]
        });
        const corrections = normalizeCorrections(data);
        expect(pendingCorrectionsFor(corrections, 7).map((c) => c.id)).toEqual([1]);
    });
});

describe('survey results helpers', () => {
    const cells: SurveyResultCell[] = [
        { group: 'Eng', dimension: 'Carga', respondents: 8, avgScore: 3.456 },
        { group: 'Sales', dimension: 'Carga', suppressed: true, reason: 'k<5' },
        { group: '_all', dimension: 'Carga', respondents: 12, avgScore: 4 },
        { group: 'Eng', dimension: 'Clima', respondents: 8, avgScore: null }
    ];

    it('detects suppressed cells and parses the k threshold', () => {
        expect(isSuppressedResult(cells[0]!)).toBe(false);
        expect(isSuppressedResult(cells[1]!)).toBe(true);
        expect(suppressionMinK('k<5')).toBe(5);
        expect(suppressionMinK('nope')).toBeNull();
        expect(suppressionMinK(undefined)).toBeNull();
        expect(cellThreshold(cells[1]!, 3)).toBe(5);
        expect(cellThreshold(cells[0]!, 3)).toBe(3);
    });

    it('pivots cells into a dimension × group matrix with _all first', () => {
        const { groups, rows } = pivotResults(cells);
        expect(groups).toEqual(['_all', 'Eng', 'Sales']);
        expect(rows.map((r) => r.dimension)).toEqual(['Carga', 'Clima']);
        const carga = rows[0]!.cells;
        expect(carga[0]?.avgScore).toBe(4);
        expect(carga[1]?.avgScore).toBeCloseTo(3.456);
        expect(carga[2]?.suppressed).toBe(true);
        // Clima has no _all/Sales cells → null placeholders.
        expect(rows[1]!.cells[0]!).toBeNull();
        expect(rows[1]!.cells[2]!).toBeNull();
    });

    it('maps the _all bucket to a friendly label', () => {
        expect(groupLabel('_all', 'All')).toBe('All');
        expect(groupLabel('', 'All')).toBe('All');
        expect(groupLabel('Eng', 'All')).toBe('Eng');
    });

    it('formats scores to one decimal with an em-dash fallback', () => {
        expect(formatAvgScore(3.456)).toBe('3.5');
        expect(formatAvgScore(4)).toBe('4.0');
        expect(formatAvgScore(null)).toBe('—');
        expect(formatAvgScore(Number.NaN)).toBe('—');
    });

    it('parses survey lists and results envelopes tolerantly', () => {
        const list = normalizeSurveys(
            surveyListResponseSchema.parse([{ id: 1, title: 'NOM-035 Q1', type: 'nom035', status: 'draft' }])
        );
        expect(list[0]!.title).toBe('NOM-035 Q1');
        const res = surveyResultsResponseSchema.parse({
            surveyId: 1,
            status: 'closed',
            respondents: 12,
            minGroupSize: 5,
            results: [{ group: 'Eng', dimension: 'Carga', suppressed: true, reason: 'k<5' }]
        });
        expect(res.minGroupSize).toBe(5);
        expect(res.results[0]!.suppressed).toBe(true);
    });
});
