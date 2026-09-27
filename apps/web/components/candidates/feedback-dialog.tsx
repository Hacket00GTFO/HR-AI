'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { processFeedbackResponseSchema, type AiFeedbackAnalysis, type Candidate } from '@/lib/schemas';
import { sendJson } from '@/lib/http';
import { candidateId, candidateName } from '@/lib/candidates';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';

interface Props {
    candidate: Candidate;
    vacancyId: number | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmitted?: (() => void) | undefined;
}

// POST /api/ai/process-feedback on accepted candidates — shows the returned
// insights (score, level, recommendation, per-criterion breakdown).
export function FeedbackDialog({ candidate, vacancyId, open, onOpenChange, onSubmitted }: Props) {
    const t = useTranslations('candidateDetail.feedback');
    const tCommon = useTranslations('common');
    const [feedback, setFeedback] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [insights, setInsights] = React.useState<AiFeedbackAnalysis | null>(null);
    const name = candidateName(candidate);

    React.useEffect(() => {
        if (open) {
            setFeedback('');
            setError(null);
            setInsights(null);
        }
    }, [open]);

    const submit = async () => {
        if (busy || !feedback.trim() || vacancyId == null) return;
        setBusy(true);
        setError(null);
        try {
            const { res, data } = await sendJson('/api/proxy/ai/process-feedback', {
                method: 'POST',
                body: {
                    candidateId: Number(candidateId(candidate)),
                    vacancyId,
                    feedback: feedback.trim()
                }
            });
            if (res.status === 503 || res.status === 502) {
                setError(t('aiUnavailable'));
                return;
            }
            if (!res.ok) {
                setError(t('error'));
                return;
            }
            const parsed = processFeedbackResponseSchema.safeParse(data);
            setInsights(parsed.success ? parsed.data.insights : null);
            toast.success(t('success'));
            onSubmitted?.();
        } catch {
            setError(t('error'));
        } finally {
            setBusy(false);
        }
    };

    const breakdown = insights?.score_breakdown ? Object.entries(insights.score_breakdown) : [];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent closeLabel={tCommon('close')}>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="size-5 text-coral-600 dark:text-coral-400" aria-hidden="true" />
                        {t('title')}
                    </DialogTitle>
                    <DialogDescription>{t('question', { name })}</DialogDescription>
                </DialogHeader>

                {insights ? (
                    <div className="flex flex-col gap-3" aria-live="polite">
                        <h3 className="text-sm font-semibold">{t('insights.title')}</h3>
                        <div className="flex flex-wrap items-center gap-2">
                            {typeof insights.match_score === 'number' && (
                                <Badge variant="info">
                                    {t('insights.matchScore')}: {Math.round(insights.match_score * 100)}%
                                </Badge>
                            )}
                            {insights.match_level && (
                                <Badge variant="neutral">
                                    {t('insights.matchLevel')}: {insights.match_level}
                                </Badge>
                            )}
                        </div>
                        {insights.summary && <p className="text-sm text-muted-foreground">{insights.summary}</p>}
                        {insights.recommendation && (
                            <p className="text-sm">
                                <span className="font-medium">{t('insights.recommendation')}:</span>{' '}
                                {insights.recommendation}
                            </p>
                        )}
                        {breakdown.length > 0 && (
                            <div>
                                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('insights.breakdown')}
                                </p>
                                <ul className="flex flex-col gap-1 text-sm">
                                    {breakdown.map(([key, value]) => (
                                        <li key={key} className="flex items-center justify-between gap-3">
                                            <span className="capitalize">{key.replace(/_/g, ' ')}</span>
                                            <span className="tabular-nums text-muted-foreground">
                                                {Math.round(value * 100)}%
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <DialogFooter>
                            <Button variant="secondary" onClick={() => onOpenChange(false)}>
                                {tCommon('close')}
                            </Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            submit();
                        }}
                    >
                        <FormField label={t('title')} id="feedback-text" required error={error ?? undefined}>
                            <Textarea
                                value={feedback}
                                onChange={(e) => setFeedback(e.target.value)}
                                placeholder={t('placeholder')}
                                rows={5}
                                disabled={busy}
                            />
                        </FormField>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => onOpenChange(false)}
                                disabled={busy}
                            >
                                {tCommon('cancel')}
                            </Button>
                            <Button type="submit" loading={busy} disabled={!feedback.trim() || vacancyId == null}>
                                {busy ? t('processing') : t('submit')}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
