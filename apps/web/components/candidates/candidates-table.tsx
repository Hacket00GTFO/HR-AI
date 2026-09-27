'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Candidate } from '@/lib/schemas';
import { candidateMatchScore, candidateName, candidateVacancyTitle } from '@/lib/candidates';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusActions } from './status-actions';
import { CandidateDetailDialog } from './candidate-detail-dialog';
import { FeedbackDialog } from './feedback-dialog';

type SortKey = 'name' | 'applied' | 'status' | 'match';

interface Props {
    candidates: Candidate[];
    /** Vacancy context for status writes/history/feedback. */
    vacancyId?: number | null | undefined;
    onChanged?: (() => void) | undefined;
    /** Show the vacancy column (global /candidates view). */
    showVacancy?: boolean | undefined;
    /** Show the AI match column (vacancy-scoped views). */
    showMatch?: boolean | undefined;
    caption: string;
}

function sortValue(c: Candidate, key: SortKey): string | number {
    switch (key) {
        case 'name':
            return candidateName(c).toLowerCase();
        case 'applied':
            return c.applied_at ? Date.parse(c.applied_at) || 0 : 0;
        case 'status':
            return (c.status ?? '').toLowerCase();
        case 'match':
            return candidateMatchScore(c) ?? -1;
    }
}

export function CandidatesTable({ candidates, vacancyId, onChanged, showVacancy, showMatch, caption }: Props) {
    const t = useTranslations('candidates.table');
    const tDetail = useTranslations('candidateDetail');
    const tCommon = useTranslations('common');
    const locale = useLocale();
    const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'applied', dir: 'desc' });
    const [selected, setSelected] = React.useState<Candidate | null>(null);
    const [feedbackFor, setFeedbackFor] = React.useState<Candidate | null>(null);

    const sorted = React.useMemo(() => {
        const rows = [...candidates];
        rows.sort((a, b) => {
            const va = sortValue(a, sort.key);
            const vb = sortValue(b, sort.key);
            const cmp =
                typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
            return sort.dir === 'asc' ? cmp : -cmp;
        });
        return rows;
    }, [candidates, sort]);

    const toggleSort = (key: SortKey) =>
        setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

    const SortableHead = ({ id, label }: { id: SortKey; label: string }) => (
        <TableHead aria-sort={sort.key === id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
            <button
                type="button"
                onClick={() => toggleSort(id)}
                className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-foreground"
                aria-label={`${label} — ${sort.key === id && sort.dir === 'asc' ? t('sortDesc') : t('sortAsc')}`}
            >
                {label}
                {sort.key === id ? (
                    sort.dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden="true" />
                    ) : (
                        <ArrowDown className="size-3" aria-hidden="true" />
                    )
                ) : (
                    <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
                )}
            </button>
        </TableHead>
    );

    return (
        <>
            <Table>
                <caption className="sr-only">{caption}</caption>
                <TableHeader>
                    <TableRow>
                        <SortableHead id="name" label={t('name')} />
                        <TableHead>{t('email')}</TableHead>
                        {showVacancy && <TableHead>{t('vacancy')}</TableHead>}
                        <TableHead>{t('skills')}</TableHead>
                        <SortableHead id="status" label={t('status')} />
                        <SortableHead id="applied" label={t('applied')} />
                        {showMatch && <SortableHead id="match" label={t('match')} />}
                        <TableHead>{t('actions')}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {sorted.map((c, i) => {
                        const needsFeedback = c.needs_feedback || (c.status === 'accepted' && !c.hiring_feedback);
                        const score = showMatch ? candidateMatchScore(c) : null;
                        return (
                            <TableRow key={`${c.application_id ?? c.id}-${i}`}>
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setSelected(c)}
                                            className="font-medium text-foreground underline-offset-4 hover:underline"
                                        >
                                            {candidateName(c)}
                                        </button>
                                        {needsFeedback && (
                                            <Badge variant="warning" title={tDetail('feedback.pending')}>
                                                !
                                            </Badge>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="text-muted-foreground">{c.email || '—'}</TableCell>
                                {showVacancy && (
                                    <TableCell className="text-muted-foreground">
                                        {candidateVacancyTitle(c) ?? '—'}
                                    </TableCell>
                                )}
                                <TableCell className="max-w-48">
                                    <span className="line-clamp-1 text-muted-foreground">{c.skills || '—'}</span>
                                </TableCell>
                                <TableCell>
                                    <StatusBadge status={c.status ?? 'pending'} />
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-muted-foreground">
                                    {c.applied_at ? formatDate(c.applied_at, locale) : '—'}
                                </TableCell>
                                {showMatch && (
                                    <TableCell className="tabular-nums">
                                        {score != null ? `${Math.round(score * 100)}%` : '—'}
                                    </TableCell>
                                )}
                                <TableCell>
                                    <div className="flex items-center gap-1.5">
                                        <StatusActions candidate={c} vacancyId={vacancyId} onChanged={onChanged} />
                                        {needsFeedback && (
                                            <button
                                                type="button"
                                                onClick={() => setFeedbackFor(c)}
                                                className="rounded-md px-2 py-1 text-xs font-medium text-warning-700 underline-offset-4 hover:underline dark:text-amber-300"
                                            >
                                                {tDetail('feedback.button')}
                                            </button>
                                        )}
                                    </div>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            <CandidateDetailDialog
                candidate={selected}
                open={selected !== null}
                onOpenChange={(o) => !o && setSelected(null)}
                vacancyId={vacancyId}
                onChanged={onChanged}
            />
            {feedbackFor && (
                <FeedbackDialog
                    candidate={feedbackFor}
                    vacancyId={vacancyId ?? null}
                    open
                    onOpenChange={(o) => !o && setFeedbackFor(null)}
                    onSubmitted={onChanged}
                />
            )}
        </>
    );
}
