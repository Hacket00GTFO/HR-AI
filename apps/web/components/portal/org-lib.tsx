import { z } from 'zod';

// ── Org chart wire schemas + pure helpers (/portal/org) ─────────────────────
// Verified upstream contract (hr-core src/routes/org.ts):
//   GET /v1/org/tree → { departments: OrgNode[] }
// Each node: { id, name, code, description, parentDepartmentId,
//   headEmployeeId, head: { firstName, lastName } | null, location,
//   costCenter, status, employeeCount, children: OrgNode[] }
// hr-core also serves GET /v1/departments?format=tree as a BARE array, so the
// response schema accepts both envelopes.
//
// Proxy path NOTE: the gateway routes /api/v1/{employees,hr,org}/* to hr-core,
// where the router is mounted at /v1/org — so the browser calls
// /api/proxy/org/tree (NOT /api/proxy/hr/org/tree, which would 404 upstream).

export interface OrgNode {
    id: number | string;
    name: string;
    code: string | null;
    head: { firstName: string | null; lastName: string | null } | null;
    employeeCount: number;
    status: string;
    location: string | null;
    children: OrgNode[];
}

const orgNodeSchema: z.ZodType<OrgNode> = z.lazy(() =>
    z
        .object({
            id: z.union([z.number(), z.string()]),
            name: z.string().optional().default(''),
            code: z.string().nullable().optional().default(null),
            head: z
                .object({
                    firstName: z.string().nullable().optional().default(null),
                    lastName: z.string().nullable().optional().default(null),
                    // Tolerate the raw SQL alias shape just in case.
                    first_name: z.string().nullable().optional(),
                    last_name: z.string().nullable().optional()
                })
                .loose()
                .nullable()
                .optional()
                .default(null),
            employeeCount: z.coerce.number().int().nonnegative().optional().default(0),
            employee_count: z.coerce.number().int().nonnegative().optional(),
            status: z.string().optional().default('active'),
            location: z.string().nullable().optional().default(null),
            children: z.array(orgNodeSchema).optional().default([])
        })
        .loose()
        .transform((n) => ({
            ...n,
            employeeCount: n.employeeCount || n.employee_count || 0,
            head: n.head
                ? {
                      firstName: n.head.firstName ?? n.head.first_name ?? null,
                      lastName: n.head.lastName ?? n.head.last_name ?? null
                  }
                : null
        }))
) as z.ZodType<OrgNode>;

export const orgTreeResponseSchema = z.union([
    z.object({ departments: z.array(orgNodeSchema) }).loose(),
    z.array(orgNodeSchema)
]);
export type OrgTreeResponse = z.infer<typeof orgTreeResponseSchema>;

/** Unwrap whichever envelope the upstream returned. */
export function normalizeOrgTree(data: OrgTreeResponse): OrgNode[] {
    if (Array.isArray(data)) return data;
    return (data as { departments?: OrgNode[] }).departments ?? [];
}

/** "First Last" for a department head; null when unassigned. */
export function orgHeadName(node: Pick<OrgNode, 'head'>): string | null {
    if (!node.head) return null;
    const name = [node.head.firstName, node.head.lastName].filter(Boolean).join(' ').trim();
    return name || null;
}

/** Headcount including every descendant department (recursive sum). */
export function orgSubtreeCount(node: Pick<OrgNode, 'employeeCount' | 'children'>): number {
    return node.employeeCount + node.children.reduce((acc, c) => acc + orgSubtreeCount(c), 0);
}

/** Total headcount across the whole forest. */
export function orgTotalCount(roots: Pick<OrgNode, 'employeeCount' | 'children'>[]): number {
    return roots.reduce((acc, n) => acc + orgSubtreeCount(n), 0);
}

/** Depth-first flat list with depth — handy for counts/tests. */
export function flattenOrgTree(roots: OrgNode[], depth = 0): { node: OrgNode; depth: number }[] {
    return roots.flatMap((node) => [{ node, depth }, ...flattenOrgTree(node.children, depth + 1)]);
}
