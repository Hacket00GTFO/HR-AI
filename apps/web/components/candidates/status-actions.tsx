'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CalendarCheck, CheckCircle2, ChevronDown, MailOpen, XCircle } from 'lucide-react';
import type { Candidate } from '@/lib/schemas';
import { candidateId, candidateName, mailtoLink, updateCandidateStatus } from '@/lib/candidates';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

type ActionStatus = 'interview' | 'accepted' | 'rejected';

const COMPANY = 'StraforAI';

interface Props {
    candidate: Candidate;
    /** Vacancy context — picks which application to update. */
    vacancyId?: number | null | undefined;
    onChanged?: (() => void) | undefined;
    size?: 'sm' | 'md' | undefined;
}

// Interview / Accept / Reject flow, matching the legacy vacancies.html UX:
// confirm → PUT status → offer a pre-filled mailto draft (client-side only).
export function StatusActions({ candidate, vacancyId, onChanged, size = 'sm' }: Props) {
    const t = useTranslations('candidateDetail.actions');
    const tStatus = useTranslations('status');
    const tCommon = useTranslations('common');
    const tEmails = useTranslations('emails');
    const [pending, setPending] = React.useState<ActionStatus | null>(null);
    const [emailOffer, setEmailOffer] = React.useState<ActionStatus | null>(null);
    const [busy, setBusy] = React.useState(false);

    const name = candidateName(candidate);
    const emailKey: Record<ActionStatus, 'interview' | 'accept' | 'reject'> = {
        interview: 'interview',
        accepted: 'accept',
        rejected: 'reject'
    };

    const confirm = async () => {
        if (!pending || busy) return;
        setBusy(true);
        try {
            await updateCandidateStatus(candidateId(candidate), pending, vacancyId ?? null);
            toast.success(t('success', { status: tStatus(pending) }));
            setPending(null);
            setEmailOffer(pending);
            onChanged?.();
        } catch {
            toast.error(t('error'));
        } finally {
            setBusy(false);
        }
    };

    const email = emailOffer ? emailKey[emailOffer] : null;
    const mailto = email
        ? mailtoLink(
              candidate.email ?? '',
              tEmails(`${email}.subject`, { company: COMPANY }),
              tEmails(`${email}.body`, { name, company: COMPANY })
          )
        : null;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size={size} aria-label={t('label')}>
                        {t('label')}
                        <ChevronDown aria-hidden="true" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setPending('interview')}>
                        <CalendarCheck aria-hidden="true" />
                        {t('interview')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPending('accepted')}>
                        <CheckCircle2 aria-hidden="true" />
                        {t('accept')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setPending('rejected')}>
                        <XCircle aria-hidden="true" />
                        {t('reject')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            {/* Status-change confirmation */}
            <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('confirmTitle')}</DialogTitle>
                        <DialogDescription>
                            {pending ? t('confirmBody', { name, status: tStatus(pending) }) : ''}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                            {tCommon('cancel')}
                        </Button>
                        <Button onClick={confirm} loading={busy}>
                            {pending ? tStatus(pending) : ''}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Optional pre-filled email draft (legacy mailto fallback) */}
            <Dialog open={emailOffer !== null} onOpenChange={(o) => !o && setEmailOffer(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('emailTitle')}</DialogTitle>
                        <DialogDescription>{t('emailBody', { name })}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setEmailOffer(null)}>
                            {t('skipEmail')}
                        </Button>
                        {mailto && (
                            <Button asChild>
                                <a href={mailto} onClick={() => setEmailOffer(null)}>
                                    <MailOpen aria-hidden="true" />
                                    {t('openEmail')}
                                </a>
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
