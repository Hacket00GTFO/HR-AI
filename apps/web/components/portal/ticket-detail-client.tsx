'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, MessageSquare, SearchX, Send } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { sendJson, errorMessage } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { PortalStatusBadge } from './portal-status-badge';
import { ticketDetailResponseSchema, ticketSchema, type Ticket, type TicketComment } from './schemas';
import { ticketTitle } from './lib';

function commentBody(c: TicketComment): string {
    return c.body ?? c.text ?? '';
}

function commentAuthor(c: TicketComment): string | null {
    return c.author ?? c.author_name ?? null;
}

function commentDate(c: TicketComment): string | null {
    return c.created_at ?? c.createdAt ?? null;
}

// Ticket detail + comment thread.
// NOTE: GET /v1/tickets/:id and POST /v1/tickets/:id/comments are assumed
// contracts — the hr-services upstream is not deployed yet. Tolerant parsing:
// accepts {ticket, comments} or a bare ticket object with embedded comments.
export function TicketDetailClient({ ticketId }: { ticketId: string }) {
    const t = useTranslations('portal.tickets');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [ticket, setTicket] = React.useState<Ticket | null>(null);
    const [comments, setComments] = React.useState<TicketComment[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'notfound' | 'done'>('loading');
    const [body, setBody] = React.useState('');
    const [sending, setSending] = React.useState(false);
    const [commentError, setCommentError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const res = await fetch(`/api/proxy/tickets/${encodeURIComponent(ticketId)}`, {
                headers: { Accept: 'application/json' }
            });
            if (res.status === 404) {
                setState('notfound');
                return;
            }
            if (!res.ok) throw new Error(String(res.status));
            const raw: unknown = await res.json();
            const enveloped = ticketDetailResponseSchema.safeParse(raw);
            if (enveloped.success && enveloped.data.ticket) {
                setTicket(enveloped.data.ticket);
                setComments(enveloped.data.comments.length ? enveloped.data.comments : enveloped.data.ticket.comments);
            } else {
                const bare = ticketSchema.safeParse(raw);
                if (!bare.success) throw new Error('bad payload');
                setTicket(bare.data);
                setComments(bare.data.comments);
            }
            setState('done');
        } catch {
            setState('error');
        }
    }, [ticketId]);

    React.useEffect(() => {
        load();
    }, [load]);

    const submitComment = async (e: React.FormEvent) => {
        e.preventDefault();
        const parsed = z.string().trim().min(1).max(2000).safeParse(body);
        if (!parsed.success) {
            setCommentError(t('errors.commentEmpty'));
            return;
        }
        setCommentError(null);
        setSending(true);
        try {
            const { res, data } = await sendJson(`/api/proxy/tickets/${encodeURIComponent(ticketId)}/comments`, {
                method: 'POST',
                body: { body: parsed.data }
            });
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('errors.generic'));
                return;
            }
            setBody('');
            load();
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <Link
                href="/portal/tickets"
                className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {t('backToList')}
            </Link>

            {state === 'loading' ? (
                <div aria-busy="true" className="flex flex-col gap-2">
                    <Skeleton className="h-24 rounded-xl" />
                    <Skeleton className="h-40 rounded-xl" />
                </div>
            ) : state === 'notfound' ? (
                <EmptyState icon={<SearchX />} title={t('notFound')} />
            ) : state === 'error' || !ticket ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : (
                <>
                    <Card>
                        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                            <div className="min-w-0">
                                <CardTitle className="text-lg">{ticketTitle(ticket)}</CardTitle>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {ticket.category}
                                    {(ticket.created_at ?? ticket.createdAt)
                                        ? ` · ${formatDate(ticket.created_at ?? ticket.createdAt, locale)}`
                                        : ''}
                                </p>
                            </div>
                            <PortalStatusBadge status={ticket.status} />
                        </CardHeader>
                        {ticket.description && (
                            <CardContent>
                                <p className="whitespace-pre-line text-sm text-muted-foreground">
                                    {ticket.description}
                                </p>
                            </CardContent>
                        )}
                    </Card>

                    <section aria-labelledby="ticket-comments">
                        <h2
                            id="ticket-comments"
                            className="mb-3 flex items-center gap-2 font-display text-lg font-semibold"
                        >
                            <MessageSquare className="size-4" aria-hidden="true" />
                            {t('comments')}
                        </h2>
                        {comments.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t('noComments')}</p>
                        ) : (
                            <ul className="flex flex-col gap-2">
                                {comments.map((c, i) => (
                                    <li
                                        key={String(c.id ?? i)}
                                        className="rounded-lg border border-border bg-card px-4 py-3"
                                    >
                                        <div className="flex items-baseline justify-between gap-2">
                                            <p className="text-sm font-medium">
                                                {commentAuthor(c) ?? t('commentAuthorFallback')}
                                            </p>
                                            {commentDate(c) && (
                                                <time className="text-xs text-muted-foreground">
                                                    {formatDate(commentDate(c), locale)}
                                                </time>
                                            )}
                                        </div>
                                        <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                                            {commentBody(c)}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}

                        <form onSubmit={submitComment} className="mt-4 flex flex-col gap-3">
                            <FormField label={t('addComment')} id="ticket-comment" error={commentError ?? undefined}>
                                <Textarea
                                    rows={3}
                                    maxLength={2000}
                                    value={body}
                                    onChange={(e) => setBody(e.target.value)}
                                    placeholder={t('commentPlaceholder')}
                                />
                            </FormField>
                            <div>
                                <Button type="submit" size="sm" loading={sending}>
                                    <Send aria-hidden="true" />
                                    {t('sendComment')}
                                </Button>
                            </div>
                        </form>
                    </section>
                </>
            )}
        </div>
    );
}
