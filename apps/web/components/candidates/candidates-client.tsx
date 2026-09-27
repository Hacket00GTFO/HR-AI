'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, SearchX, Users } from 'lucide-react';
import { candidateListSchema, vacancyListSchema, type Candidate, type Vacancy } from '@/lib/schemas';
import { fetchJson } from '@/lib/http';
import { vacancyId } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CandidateCreateDialog } from './candidate-create-dialog';
import { CandidatesTable } from './candidates-table';

const CANDIDATE_STATUSES = ['pending', 'interview', 'accepted', 'rejected'] as const;

export function CandidatesClient() {
    const t = useTranslations('candidates');
    const tStatus = useTranslations('status');
    const tCommon = useTranslations('common');
    const [candidates, setCandidates] = React.useState<Candidate[]>([]);
    const [vacancies, setVacancies] = React.useState<Vacancy[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [search, setSearch] = React.useState('');
    const [status, setStatus] = React.useState('');
    const [vacancyFilter, setVacancyFilter] = React.useState('');
    const [createOpen, setCreateOpen] = React.useState(false);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const params = new URLSearchParams();
            if (status) params.set('status', status);
            if (vacancyFilter) params.set('vacancy_id', vacancyFilter);
            if (search.trim()) params.set('q', search.trim());
            const qs = params.toString();
            const url = qs ? `/api/proxy/candidates?${qs}` : '/api/proxy/candidates';
            setCandidates(await fetchJson(url, candidateListSchema));
            setState('done');
        } catch {
            setState('error');
        }
    }, [status, vacancyFilter, search]);

    const loadVacancies = React.useCallback(async () => {
        try {
            setVacancies(await fetchJson('/api/proxy/vacancies', vacancyListSchema));
        } catch {
            /* best effort */
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    React.useEffect(() => {
        loadVacancies();
    }, [loadVacancies]);

    const clearFilters = () => {
        setSearch('');
        setStatus('');
        setVacancyFilter('');
    };

    const hasFilters = search || status || vacancyFilter;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <Button onClick={() => setCreateOpen(true)}>
                    <Plus aria-hidden="true" />
                    {t('add')}
                </Button>
            </div>

            <div className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cf-search">{t('filters.search')}</Label>
                    <Input
                        id="cf-search"
                        type="search"
                        value={search}
                        placeholder={t('filters.search')}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cf-status">{t('filters.status')}</Label>
                    <Select id="cf-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">{t('filters.allStatuses')}</option>
                        {CANDIDATE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {tStatus(s)}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cf-vacancy">{t('filters.vacancy')}</Label>
                    <Select id="cf-vacancy" value={vacancyFilter} onChange={(e) => setVacancyFilter(e.target.value)}>
                        <option value="">{t('filters.allVacancies')}</option>
                        {vacancies.map((v) => (
                            <option key={vacancyId(v)} value={String(vacancyId(v))}>
                                {v.title}
                            </option>
                        ))}
                    </Select>
                </div>
                {hasFilters && (
                    <div className="sm:col-span-3">
                        <Button variant="ghost" size="sm" onClick={clearFilters}>
                            {t('filters.clear')}
                        </Button>
                    </div>
                )}
            </div>

            {state === 'loading' ? (
                <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-2">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-14 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : candidates.length === 0 ? (
                <EmptyState
                    icon={<Users />}
                    title={t('empty')}
                    description={t('emptyHint')}
                    {...(hasFilters ? { actionLabel: t('filters.clear'), onAction: clearFilters } : {})}
                />
            ) : (
                <>
                    <p className="text-sm text-muted-foreground" role="status">
                        {t('count', { count: candidates.length })}
                    </p>
                    <div className="rounded-xl border border-border bg-card shadow-sm">
                        <CandidatesTable candidates={candidates} showVacancy onChanged={load} caption={t('title')} />
                    </div>
                </>
            )}

            <CandidateCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
        </div>
    );
}
