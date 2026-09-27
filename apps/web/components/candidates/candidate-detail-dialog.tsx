'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ExternalLink, FileText, Linkedin, Mail, MapPin, Phone } from 'lucide-react';
import { statusHistorySchema, type Candidate, type StatusHistoryEntry } from '@/lib/schemas';
import { fetchJson } from '@/lib/http';
import { candidateId, candidateMatchScore, candidateName, candidateVacancyId } from '@/lib/candidates';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusActions } from './status-actions';
import { FeedbackDialog } from './feedback-dialog';

interface Props {
    candidate: Candidate | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Vacancy context — used for status writes, history and feedback. */
    vacancyId?: number | null | undefined;
    onChanged?: (() => void) | undefined;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="text-sm">{children}</dd>
        </div>
    );
}

function HistoryTimeline({ candidate, vacancyId }: { candidate: Candidate; vacancyId?: number | null }) {
    const t = useTranslations('candidateDetail.history');
    const tStatus = useTranslations('status');
    const locale = useLocale();
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [entries, setEntries] = React.useState<StatusHistoryEntry[]>([]);

    React.useEffect(() => {
        let cancelled = false;
        const cid = candidateId(candidate);
        const vid = vacancyId ?? candidateVacancyId(candidate);
        fetchJson(`/api/proxy/candidates/${cid}/history${vid ? `?vacancy_id=${vid}` : ''}`, statusHistorySchema)
            .then((rows) => {
                if (!cancelled) {
                    setEntries(rows);
                    setState('done');
                }
            })
            .catch(() => {
                if (!cancelled) setState('error');
            });
        return () => {
            cancelled = true;
        };
    }, [candidate, vacancyId]);

    if (state === 'loading') {
        return (
            <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-2">
                <Skeleton className="h-8 rounded-md" />
                <Skeleton className="h-8 rounded-md" />
            </div>
        );
    }
    if (state === 'error') {
        return <p className="text-sm text-muted-foreground">{t('error')}</p>;
    }
    if (entries.length === 0) {
        return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
    }

    return (
        <ol className="relative flex flex-col gap-3 border-l border-border pl-4">
            {entries.map((e, i) => {
                const actor = [e.changed_by_first_name, e.changed_by_last_name].filter(Boolean).join(' ');
                return (
                    <li key={e.id ?? i} className="relative text-sm">
                        <span
                            aria-hidden="true"
                            className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-coral-500"
                        />
                        <div className="flex flex-wrap items-center gap-1.5">
                            {e.from_status ? (
                                <>
                                    <StatusBadge status={e.from_status} />
                                    <span aria-hidden="true">→</span>
                                </>
                            ) : (
                                <span className="text-muted-foreground">{t('created')}</span>
                            )}
                            {e.to_status && <StatusBadge status={e.to_status} />}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                            {e.changed_at && <time dateTime={e.changed_at}>{formatDate(e.changed_at, locale)}</time>}
                            {actor && <span>{t('by', { name: actor })}</span>}
                            {e.note && <span>{t('note', { note: e.note })}</span>}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

export function CandidateDetailDialog({ candidate, open, onOpenChange, vacancyId, onChanged }: Props) {
    const t = useTranslations('candidateDetail');
    const tCommon = useTranslations('common');
    const [feedbackOpen, setFeedbackOpen] = React.useState(false);

    const name = candidate ? candidateName(candidate) : '';
    const score = candidate ? candidateMatchScore(candidate) : null;
    const vid = vacancyId ?? (candidate ? candidateVacancyId(candidate) : null);
    const needsFeedback =
        candidate != null &&
        (candidate.needs_feedback || (candidate.status === 'accepted' && !candidate.hiring_feedback));

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl" closeLabel={tCommon('close')}>
                    {candidate && (
                        <>
                            <DialogHeader>
                                <DialogTitle className="flex flex-wrap items-center gap-2">
                                    {name}
                                    <StatusBadge status={candidate.status} />
                                    {needsFeedback && <Badge variant="warning">{t('feedback.pending')}</Badge>}
                                </DialogTitle>
                                <DialogDescription>{t('title')}</DialogDescription>
                            </DialogHeader>

                            <div className="flex flex-col gap-5">
                                <dl className="grid gap-4 sm:grid-cols-2">
                                    <Field label={t('email')}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <Mail className="size-3.5 text-muted-foreground" aria-hidden="true" />
                                            {candidate.email || '—'}
                                        </span>
                                    </Field>
                                    <Field label={t('phone')}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <Phone className="size-3.5 text-muted-foreground" aria-hidden="true" />
                                            {candidate.phone || '—'}
                                        </span>
                                    </Field>
                                    <Field label={t('location')}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <MapPin className="size-3.5 text-muted-foreground" aria-hidden="true" />
                                            {candidate.location || '—'}
                                        </span>
                                    </Field>
                                    <Field label={t('linkedin')}>
                                        {candidate.linkedin ? (
                                            <a
                                                href={candidate.linkedin}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1.5 text-coral-600 hover:underline dark:text-coral-400"
                                            >
                                                <Linkedin className="size-3.5" aria-hidden="true" />
                                                {t('viewProfile')}
                                                <ExternalLink className="size-3" aria-hidden="true" />
                                            </a>
                                        ) : (
                                            '—'
                                        )}
                                    </Field>
                                    <Field label={t('currentPosition')}>{candidate.current_position || '—'}</Field>
                                    <Field label={t('experience')}>
                                        {candidate.experience != null && candidate.experience !== ''
                                            ? t('years', { count: Number(candidate.experience) || 0 })
                                            : '—'}
                                    </Field>
                                    <Field label={t('education')}>{candidate.education || '—'}</Field>
                                    <Field label={t('matchScore')}>
                                        {score != null ? `${Math.round(score * 100)}%` : '—'}
                                    </Field>
                                </dl>

                                <div>
                                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        {t('skills')}
                                    </p>
                                    {candidate.skills ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {candidate.skills
                                                .split(',')
                                                .map((s) => s.trim())
                                                .filter(Boolean)
                                                .map((s) => (
                                                    <Badge key={s} variant="coral">
                                                        {s}
                                                    </Badge>
                                                ))}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">—</p>
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    {candidate.resume ? (
                                        String(candidate.resume).startsWith('http') ? (
                                            <Button asChild variant="secondary" size="sm">
                                                <a href={candidate.resume} target="_blank" rel="noopener noreferrer">
                                                    <FileText aria-hidden="true" />
                                                    {t('viewResume')}
                                                </a>
                                            </Button>
                                        ) : (
                                            // Authenticated download through the BFF proxy — the
                                            // session cookie rides along and Bearer is injected
                                            // server-side.
                                            <Button asChild variant="secondary" size="sm">
                                                <a
                                                    href={`/api/proxy/candidates/${candidateId(candidate)}/resume`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    <FileText aria-hidden="true" />
                                                    {t('viewResume')}
                                                </a>
                                            </Button>
                                        )
                                    ) : (
                                        <span className="text-sm text-muted-foreground">{t('noResume')}</span>
                                    )}
                                    <StatusActions candidate={candidate} vacancyId={vid} onChanged={onChanged} />
                                    {needsFeedback && (
                                        <Button variant="secondary" size="sm" onClick={() => setFeedbackOpen(true)}>
                                            {t('feedback.button')}
                                        </Button>
                                    )}
                                </div>

                                <section>
                                    <h3 className="mb-2 text-sm font-semibold">{t('history.title')}</h3>
                                    <HistoryTimeline candidate={candidate} vacancyId={vid} />
                                </section>
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {candidate && (
                <FeedbackDialog
                    candidate={candidate}
                    vacancyId={vid}
                    open={feedbackOpen}
                    onOpenChange={setFeedbackOpen}
                    onSubmitted={onChanged}
                />
            )}
        </>
    );
}
