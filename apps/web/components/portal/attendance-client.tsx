'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { LogIn, LogOut, MapPin, MapPinOff, SearchX } from 'lucide-react';
import { toast } from 'sonner';
import { fetchJson, sendJson, errorMessage } from '@/lib/http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { attendanceMineResponseSchema, type AttendanceCheckBody, type AttendanceEvent } from './schemas';
import { todayBounds } from './lib';

type LoadState = 'loading' | 'error' | 'done';
type GeoNote = 'none' | 'shared' | 'denied';

async function getPosition(): Promise<GeolocationPosition | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve(pos),
            () => resolve(null),
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 }
        );
    });
}

// Self-service punch (PWA): POST /api/proxy/attendance/check →
// /v1/attendance/check. Geolocation is attached ONLY when the employee ticks
// the explicit consent box AND the browser grants permission; a denied
// permission still records the punch without coordinates (geoNote='denied').
export function AttendanceClient() {
    const t = useTranslations('portal.attendance');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [events, setEvents] = React.useState<AttendanceEvent[]>([]);
    const [state, setState] = React.useState<LoadState>('loading');
    const [consent, setConsent] = React.useState(false);
    const [geoNote, setGeoNote] = React.useState<GeoNote>('none');
    const [submitting, setSubmitting] = React.useState<'check_in' | 'check_out' | null>(null);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const { from, to } = todayBounds();
            const data = await fetchJson(
                `/api/proxy/attendance/mine?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`,
                attendanceMineResponseSchema
            );
            setEvents(data.events);
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const sorted = React.useMemo(() => [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [events]);
    const lastKind = sorted[0]?.kind;
    const openShift = lastKind === 'check_in' || lastKind === 'break_end';

    const punch = async (kind: 'check_in' | 'check_out') => {
        if (submitting) return;
        setSubmitting(kind);
        setGeoNote('none');
        try {
            const body: AttendanceCheckBody = { kind, consent: false };
            if (consent) {
                const pos = await getPosition();
                if (pos) {
                    body.lat = pos.coords.latitude;
                    body.lng = pos.coords.longitude;
                    if (Number.isFinite(pos.coords.accuracy)) {
                        body.accuracy = Math.max(0, Math.round(pos.coords.accuracy));
                    }
                    body.consent = true;
                    setGeoNote('shared');
                } else {
                    // Permission denied / unavailable / timed out — punch anyway,
                    // without coordinates, and tell the employee.
                    setGeoNote('denied');
                }
            }
            const { res, data } = await sendJson('/api/proxy/attendance/check', { method: 'POST', body });
            if (res.status === 409) {
                toast.error(t('openShiftConflict'));
                return;
            }
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('punchError'));
                return;
            }
            toast.success(kind === 'check_in' ? t('checkedInOk') : t('checkedOutOk'));
            await load();
        } catch {
            toast.error(t('punchError'));
        } finally {
            setSubmitting(null);
        }
    };

    const kindLabel = (kind: string) =>
        (['check_in', 'check_out', 'break_start', 'break_end'] as const).includes(kind as never)
            ? t(`kind.${kind}`)
            : kind;

    return (
        <div className="flex flex-col gap-6">
            <header>
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
            </header>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">{t('punchTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <div className="flex items-start gap-3">
                        <input
                            id="geo-consent"
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                            className="mt-0.5 size-4 shrink-0 accent-coral-600"
                        />
                        <div className="flex flex-col gap-0.5">
                            <Label htmlFor="geo-consent" className="font-normal">
                                {t('consentLabel')}
                            </Label>
                            <p className="text-xs text-muted-foreground">{t('consentHint')}</p>
                        </div>
                    </div>

                    {geoNote === 'denied' && (
                        <p
                            role="status"
                            className="flex items-center gap-1.5 text-xs text-warning-700 dark:text-amber-300"
                        >
                            <MapPinOff className="size-3.5" aria-hidden="true" />
                            {t('geoDenied')}
                        </p>
                    )}
                    {geoNote === 'shared' && (
                        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <MapPin className="size-3.5" aria-hidden="true" />
                            {t('geoShared')}
                        </p>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <Button
                            size="lg"
                            onClick={() => punch('check_in')}
                            loading={submitting === 'check_in'}
                            disabled={submitting !== null || openShift}
                        >
                            <LogIn aria-hidden="true" />
                            {t('checkIn')}
                        </Button>
                        <Button
                            size="lg"
                            variant="secondary"
                            onClick={() => punch('check_out')}
                            loading={submitting === 'check_out'}
                            disabled={submitting !== null || !openShift}
                        >
                            <LogOut aria-hidden="true" />
                            {t('checkOut')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <section aria-labelledby="today-punches">
                <h2 id="today-punches" className="mb-3 font-display text-lg font-semibold">
                    {t('todayPunches')}
                </h2>
                {state === 'loading' ? (
                    <div aria-busy="true" className="flex flex-col gap-2">
                        {[0, 1, 2].map((i) => (
                            <Skeleton key={i} className="h-12 rounded-lg" />
                        ))}
                    </div>
                ) : state === 'error' ? (
                    <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
                ) : sorted.length === 0 ? (
                    <EmptyState icon={<SearchX />} title={t('empty')} />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {sorted.map((e) => (
                            <li
                                key={String(e.id)}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                            >
                                <div className="flex items-center gap-2">
                                    <Badge
                                        variant={
                                            e.kind === 'check_in'
                                                ? 'success'
                                                : e.kind === 'check_out'
                                                  ? 'neutral'
                                                  : 'info'
                                        }
                                    >
                                        {kindLabel(e.kind)}
                                    </Badge>
                                    {e.geo && (
                                        <MapPin
                                            className="size-3.5 text-muted-foreground"
                                            aria-label={t('geoPinned')}
                                        />
                                    )}
                                </div>
                                <time
                                    dateTime={e.occurredAt}
                                    className="text-sm font-medium tabular-nums text-muted-foreground"
                                >
                                    {new Intl.DateTimeFormat(locale, {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit'
                                    }).format(new Date(e.occurredAt))}
                                </time>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
