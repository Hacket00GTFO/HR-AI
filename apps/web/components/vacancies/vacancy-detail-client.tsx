'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    ArrowLeft,
    Briefcase,
    CalendarDays,
    MapPin,
    SearchX,
    Sparkles,
    Trophy,
    UserPlus,
    Users,
    Wifi
} from 'lucide-react';
import {
    candidateListSchema,
    topCandidateListSchema,
    vacancySchema,
    type Candidate,
    type TopCandidate,
    type Vacancy
} from '@/lib/schemas';
import { ApiError, fetchJson } from '@/lib/http';
import { candidateId, candidateName } from '@/lib/candidates';
import { formatDate, formatSalary, vacancyId } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { CandidatesTable } from '@/components/candidates/candidates-table';
import { CandidateCreateDialog } from '@/components/candidates/candidate-create-dialog';
import { CandidateDetailDialog } from '@/components/candidates/candidate-detail-dialog';
import { VacancyFormDialog } from './vacancy-form-dialog';

type LoadState = 'loading' | 'error' | 'notFound' | 'done';
type Tab = 'candidates' | 'top';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section>
            <h2 className="font-display text-base font-semibold">{title}</h2>
            <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
        </section>
    );
}

function TopCandidatesPanel({
    vacancyId: vid,
    reloadKey,
    onSelect
}: {
    vacancyId: number;
    reloadKey: number;
    onSelect: (c: Candidate) => void;
}) {
    const t = useTranslations('topCandidates');
    const [state, setState] = React.useState<'loading' | 'error' | 'unavailable' | 'done'>('loading');
    const [rows, setRows] = React.useState<TopCandidate[]>([]);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const data = await fetchJson(`/api/proxy/vacancies/${vid}/top-candidates`, topCandidateListSchema);
            setRows([...data].sort((a, b) => b.match_score - a.match_score));
            setState('done');
        } catch (err) {
            setState(err instanceof ApiError && err.status === 503 ? 'unavailable' : 'error');
        }
    }, [vid]);

    React.useEffect(() => {
        load();
    }, [load, reloadKey]);

    if (state === 'loading') {
        return (
            <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-2">
                {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
            </div>
        );
    }
    if (state === 'unavailable') {
        return (
            <EmptyState
                icon={<Sparkles />}
                title={t('unavailable')}
                description={t('unavailableBody')}
                actionLabel={t('retry')}
                onAction={load}
            />
        );
    }
    if (state === 'error') {
        return <EmptyState icon={<SearchX />} title={t('error')} actionLabel={t('retry')} onAction={load} />;
    }
    if (rows.length === 0) {
        return <EmptyState icon={<Trophy />} title={t('empty')} />;
    }

    return (
        <ol className="flex flex-col gap-3">
            {rows.map((c, i) => {
                const pct = Math.round(c.match_score * 100);
                const breakdown = Object.entries(c.match_details?.score_breakdown ?? {});
                const redFlags = c.match_details?.red_flags ?? [];
                return (
                    <li key={`${c.application_id ?? c.id}-${i}`}>
                        <Card>
                            <CardContent className="flex flex-col gap-3 p-5">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                            {t('rank', { rank: i + 1 })}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => onSelect(c)}
                                            className="text-left font-display text-lg font-semibold underline-offset-4 hover:underline"
                                        >
                                            {candidateName(c)}
                                        </button>
                                        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                            <span>{c.email}</span>
                                            <StatusBadge status={c.status ?? 'pending'} />
                                            {c.match_details?.match_level && (
                                                <Badge variant="neutral">{c.match_details.match_level}</Badge>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        <span className="font-display text-2xl font-bold tabular-nums">
                                            {t('matchScore', { score: pct })}
                                        </span>
                                        <div
                                            role="meter"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={pct}
                                            aria-label={t('matchScore', { score: pct })}
                                            className="h-2 w-32 overflow-hidden rounded-full bg-muted"
                                        >
                                            <div
                                                className="h-full rounded-full bg-coral-500"
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                    </div>
                                </div>
                                {c.match_details?.recommendation && (
                                    <p className="text-sm">
                                        <span className="font-medium">{t('recommendation')}: </span>
                                        <span className="text-muted-foreground">{c.match_details.recommendation}</span>
                                    </p>
                                )}
                                {breakdown.length > 0 && (
                                    <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                                        <dt className="sr-only">{t('breakdown')}</dt>
                                        {breakdown.map(([k, v]) => (
                                            <div key={k} className="flex items-center justify-between gap-2">
                                                <span className="capitalize text-muted-foreground">
                                                    {k.replace(/_/g, ' ')}
                                                </span>
                                                <dd className="tabular-nums">{Math.round(v * 100)}%</dd>
                                            </div>
                                        ))}
                                    </dl>
                                )}
                                {redFlags.length > 0 && (
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                            {t('redFlags')}
                                        </p>
                                        <div className="mt-1 flex flex-wrap gap-1.5">
                                            {redFlags.map((f) => (
                                                <Badge key={f} variant="danger">
                                                    {f}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </li>
                );
            })}
        </ol>
    );
}

export function VacancyDetailClient({ id }: { id: string }) {
    const t = useTranslations('vacancies');
    const tCandidates = useTranslations('candidates');
    const tCandidateDetail = useTranslations('candidateDetail');
    const tTop = useTranslations('topCandidates');
    const tTypes = useTranslations('vacancyType');
    const tLevels = useTranslations('experienceLevel');
    const tCard = useTranslations('careers.card');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [vacancy, setVacancy] = React.useState<Vacancy | null>(null);
    const [state, setState] = React.useState<LoadState>('loading');
    const [candidates, setCandidates] = React.useState<Candidate[]>([]);
    const [candState, setCandState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [tab, setTab] = React.useState<Tab>('candidates');
    const [reloadKey, setReloadKey] = React.useState(0);
    const [editing, setEditing] = React.useState(false);
    const [createOpen, setCreateOpen] = React.useState(false);
    const [selected, setSelected] = React.useState<Candidate | null>(null);

    const numericId = Number(id);

    const loadVacancy = React.useCallback(async () => {
        setState('loading');
        try {
            setVacancy(await fetchJson(`/api/proxy/vacancies/${encodeURIComponent(id)}`, vacancySchema));
            setState('done');
        } catch (err) {
            setState(err instanceof ApiError && err.status === 404 ? 'notFound' : 'error');
        }
    }, [id]);

    const loadCandidates = React.useCallback(async () => {
        setCandState('loading');
        try {
            setCandidates(
                await fetchJson(`/api/proxy/vacancies/${encodeURIComponent(id)}/candidates`, candidateListSchema)
            );
            setCandState('done');
        } catch {
            setCandState('error');
        }
    }, [id]);

    React.useEffect(() => {
        loadVacancy();
        loadCandidates();
    }, [loadVacancy, loadCandidates]);

    const refresh = React.useCallback(() => {
        loadCandidates();
        setReloadKey((k) => k + 1);
    }, [loadCandidates]);

    const pendingFeedback = candidates.filter(
        (c) => c.needs_feedback || (c.status === 'accepted' && !c.hiring_feedback)
    ).length;
    const pendingFeedbackLabel = tCandidateDetail('feedback.pendingCount', { count: pendingFeedback });

    if (state === 'loading') {
        return (
            <div aria-busy="true" aria-label={t('detail.loading')} className="flex flex-col gap-4">
                <Skeleton className="h-8 w-64 rounded-md" />
                <Skeleton className="h-40 rounded-xl" />
                <Skeleton className="h-64 rounded-xl" />
            </div>
        );
    }

    if (state !== 'done' || !vacancy) {
        return (
            <div className="flex flex-col gap-6">
                <Button asChild variant="ghost" size="sm" className="w-fit">
                    <Link href="/vacancies">
                        <ArrowLeft aria-hidden="true" />
                        {t('detail.back')}
                    </Link>
                </Button>
                <EmptyState
                    icon={<SearchX />}
                    title={state === 'notFound' ? t('detail.notFound') : t('detail.error')}
                    {...(state !== 'notFound' ? { actionLabel: tCommon('retry'), onAction: loadVacancy } : {})}
                />
            </div>
        );
    }

    const salary = formatSalary(vacancy.salary_range, locale);
    const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
        { id: 'candidates', label: t('detail.candidates'), icon: <Users aria-hidden="true" /> },
        { id: 'top', label: t('detail.topCandidates'), icon: <Trophy aria-hidden="true" /> }
    ];

    return (
        <div className="flex flex-col gap-6">
            <Button asChild variant="ghost" size="sm" className="w-fit">
                <Link href="/vacancies">
                    <ArrowLeft aria-hidden="true" />
                    {t('detail.back')}
                </Link>
            </Button>

            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <h1 className="font-display text-2xl font-bold">{vacancy.title}</h1>
                        <StatusBadge status={vacancy.status || 'Draft'} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
                        {vacancy.department && (
                            <span className="inline-flex items-center gap-1.5">
                                <Briefcase className="size-4" aria-hidden="true" />
                                {vacancy.department}
                            </span>
                        )}
                        {vacancy.location && (
                            <span className="inline-flex items-center gap-1.5">
                                <MapPin className="size-4" aria-hidden="true" />
                                {vacancy.location}
                            </span>
                        )}
                        {vacancy.type && (
                            <Badge variant="neutral">
                                {tTypes.has(vacancy.type) ? tTypes(vacancy.type) : vacancy.type}
                            </Badge>
                        )}
                        {vacancy.experience_level && (
                            <Badge variant="neutral">
                                {tLevels.has(vacancy.experience_level)
                                    ? tLevels(vacancy.experience_level)
                                    : vacancy.experience_level}
                            </Badge>
                        )}
                        {vacancy.remote_option && (
                            <Badge variant="info">
                                <Wifi className="mr-1 size-3" aria-hidden="true" />
                                {tCard('remote')}
                            </Badge>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        {salary && <span className="font-semibold">{salary}</span>}
                        {vacancy.application_deadline && (
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                <CalendarDays className="size-4" aria-hidden="true" />
                                {tCard('deadline', { date: formatDate(vacancy.application_deadline, locale) })}
                            </span>
                        )}
                        {vacancy.created_at && (
                            <span className="text-muted-foreground">
                                {t('detail.posted', { date: formatDate(vacancy.created_at, locale) })}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                        {t('actions.edit')}
                    </Button>
                    <Button onClick={() => setCreateOpen(true)}>
                        <UserPlus aria-hidden="true" />
                        {tCandidates('add')}
                    </Button>
                </div>
            </header>

            <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
                <Card className="lg:self-start">
                    <CardHeader>
                        <CardTitle>{t('detail.description')}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                        {vacancy.description && (
                            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                                {vacancy.description}
                            </p>
                        )}
                        {vacancy.responsibilities && (
                            <Section title={t('detail.responsibilities')}>
                                <p className="whitespace-pre-line">{vacancy.responsibilities}</p>
                            </Section>
                        )}
                        {vacancy.requirements && (
                            <Section title={t('detail.requirements')}>
                                <p className="whitespace-pre-line">{vacancy.requirements}</p>
                            </Section>
                        )}
                        {vacancy.skills_required.length > 0 && (
                            <Section title={t('detail.skills')}>
                                <div className="flex flex-wrap gap-1.5">
                                    {vacancy.skills_required.map((s) => (
                                        <Badge key={s} variant="coral">
                                            {s}
                                        </Badge>
                                    ))}
                                </div>
                            </Section>
                        )}
                        {vacancy.benefits.length > 0 && (
                            <Section title={t('detail.benefits')}>
                                <ul className="list-disc space-y-1 pl-5">
                                    {vacancy.benefits.map((b) => (
                                        <li key={b}>{b}</li>
                                    ))}
                                </ul>
                            </Section>
                        )}
                    </CardContent>
                </Card>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div
                            role="tablist"
                            aria-label={t('detail.candidates')}
                            className="flex gap-1 rounded-lg bg-muted p-1"
                        >
                            {tabs.map((tb) => (
                                <button
                                    key={tb.id}
                                    type="button"
                                    role="tab"
                                    id={`vtab-${tb.id}`}
                                    aria-selected={tab === tb.id}
                                    aria-controls={`vpanel-${tb.id}`}
                                    onClick={() => setTab(tb.id)}
                                    className={
                                        tab === tb.id
                                            ? 'inline-flex items-center gap-2 rounded-md bg-card px-3 py-1.5 text-sm font-medium shadow-sm [&_svg]:size-4'
                                            : 'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground [&_svg]:size-4'
                                    }
                                >
                                    {tb.icon}
                                    {tb.label}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
                            {candState === 'done' && <span>{tCandidates('count', { count: candidates.length })}</span>}
                            {pendingFeedback > 0 && <Badge variant="warning">{pendingFeedbackLabel}</Badge>}
                        </div>
                    </div>

                    <div
                        role="tabpanel"
                        id="vpanel-candidates"
                        aria-labelledby="vtab-candidates"
                        hidden={tab !== 'candidates'}
                    >
                        {candState === 'loading' ? (
                            <div aria-busy="true" aria-label={tCandidates('loading')} className="flex flex-col gap-2">
                                {[0, 1, 2].map((i) => (
                                    <Skeleton key={i} className="h-14 rounded-lg" />
                                ))}
                            </div>
                        ) : candState === 'error' ? (
                            <EmptyState
                                icon={<SearchX />}
                                title={tCandidates('error')}
                                actionLabel={tCommon('retry')}
                                onAction={loadCandidates}
                            />
                        ) : candidates.length === 0 ? (
                            <EmptyState
                                icon={<Users />}
                                title={tCandidates('empty')}
                                actionLabel={tCandidates('add')}
                                onAction={() => setCreateOpen(true)}
                            />
                        ) : (
                            <div className="rounded-xl border border-border bg-card shadow-sm">
                                <CandidatesTable
                                    candidates={candidates}
                                    vacancyId={numericId}
                                    onChanged={refresh}
                                    showMatch
                                    caption={`${tCandidates('table.caption')} — ${vacancy.title}`}
                                />
                            </div>
                        )}
                    </div>

                    <div role="tabpanel" id="vpanel-top" aria-labelledby="vtab-top" hidden={tab !== 'top'}>
                        {tab === 'top' && (
                            <>
                                <h2 className="sr-only">{tTop('title')}</h2>
                                <TopCandidatesPanel
                                    vacancyId={numericId}
                                    reloadKey={reloadKey}
                                    onSelect={setSelected}
                                />
                            </>
                        )}
                    </div>
                </div>
            </div>

            <VacancyFormDialog
                open={editing}
                onOpenChange={setEditing}
                mode="edit"
                vacancy={vacancy}
                onSaved={loadVacancy}
            />
            <CandidateCreateDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                vacancyId={numericId}
                vacancyTitle={vacancy.title}
                onCreated={refresh}
            />
            <CandidateDetailDialog
                candidate={selected}
                open={selected !== null}
                onOpenChange={(o) => !o && setSelected(null)}
                vacancyId={numericId}
                onChanged={refresh}
            />
        </div>
    );
}

export { vacancyId };
