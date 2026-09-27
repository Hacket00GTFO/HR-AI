'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRight, Network, SearchX, Users } from 'lucide-react';
import { fetchJson } from '@/lib/http';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
    normalizeOrgTree,
    orgHeadName,
    orgSubtreeCount,
    orgTotalCount,
    orgTreeResponseSchema,
    type OrgNode
} from './org-lib';

type LoadState = 'loading' | 'error' | 'done';

// Organigrama — read-only department hierarchy for HR.
// Upstream: GET /api/proxy/org/tree → hr-core GET /v1/org/tree (HR role only).
// Each department links to the employees directory filtered by department;
// NOTE: the /employees page does not consume ?departmentId yet — the param is
// forward-compatible and harmless today.
function DeptNode({ node, depth, t }: { node: OrgNode; depth: number; t: ReturnType<typeof useTranslations> }) {
    const head = orgHeadName(node);
    const subtree = orgSubtreeCount(node);
    return (
        <li>
            <div
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-3"
                style={depth > 0 ? { marginInlineStart: `${Math.min(depth, 6)}rem` } : undefined}
            >
                <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="truncate">{node.name || `#${String(node.id)}`}</span>
                        {node.code && (
                            <Badge variant="neutral" className="font-mono">
                                {node.code}
                            </Badge>
                        )}
                        {node.status && node.status !== 'active' && <Badge variant="warning">{node.status}</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {head ? t('head', { name: head }) : t('noHead')}
                        {node.location ? ` · ${node.location}` : ''}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground" title={t('subtreeCount', { count: subtree })}>
                        <Users className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
                        {t('members', { count: node.employeeCount })}
                    </span>
                    <Link
                        href={`/employees?departmentId=${encodeURIComponent(String(node.id))}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-coral-600 hover:underline dark:text-coral-400"
                        aria-label={t('viewMembers', { name: node.name || String(node.id) })}
                    >
                        {t('viewEmployees')}
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                    </Link>
                </div>
            </div>
            {node.children.length > 0 && (
                <ul className="mt-2 flex flex-col gap-2">
                    {node.children.map((c) => (
                        <DeptNode key={String(c.id)} node={c} depth={depth + 1} t={t} />
                    ))}
                </ul>
            )}
        </li>
    );
}

export function OrgClient() {
    const t = useTranslations('portal.org');
    const tCommon = useTranslations('common');
    useLocale();

    const [roots, setRoots] = React.useState<OrgNode[]>([]);
    const [state, setState] = React.useState<LoadState>('loading');

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const data = await fetchJson('/api/proxy/org/tree', orgTreeResponseSchema);
            setRoots(normalizeOrgTree(data));
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const deptCount = (list: OrgNode[]): number => list.reduce((acc, n) => acc + 1 + deptCount(n.children), 0);

    return (
        <div className="flex flex-col gap-6">
            <header>
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
            </header>

            {state === 'loading' ? (
                <div aria-busy="true" className="flex flex-col gap-2">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className={cn('h-16 rounded-lg', i % 2 === 1 && 'ml-8')} />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : roots.length === 0 ? (
                <EmptyState icon={<Network />} title={t('empty')} description={t('emptyHint')} />
            ) : (
                <>
                    <p className="text-sm text-muted-foreground" role="status">
                        {t('summary', {
                            departments: deptCount(roots),
                            members: orgTotalCount(roots)
                        })}
                    </p>
                    <ul className="flex flex-col gap-2">
                        {roots.map((n) => (
                            <DeptNode key={String(n.id)} node={n} depth={0} t={t} />
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
