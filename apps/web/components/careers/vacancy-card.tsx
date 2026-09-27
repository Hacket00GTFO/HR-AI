'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Briefcase, CalendarDays, MapPin, Wifi } from 'lucide-react';
import type { Vacancy } from '@/lib/schemas';
import { formatDate, formatSalary, vacancyId } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function VacancyCard({ vacancy }: { vacancy: Vacancy }) {
    const t = useTranslations('careers.card');
    const tTypes = useTranslations('vacancyType');
    const locale = useLocale();
    const salary = formatSalary(vacancy.salary_range, locale);
    const typeLabel = vacancy.type ? (tTypes.has(vacancy.type) ? tTypes(vacancy.type) : vacancy.type) : null;

    return (
        <article className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
            <div className="h-1.5 w-full bg-gradient-to-r from-navy-800 to-coral-500" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-3 p-5">
                <h2 className="font-display text-xl font-semibold leading-snug">
                    <Link
                        href={`/careers/${vacancyId(vacancy)}`}
                        className="transition-colors hover:text-coral-600 dark:hover:text-coral-400"
                    >
                        {vacancy.title}
                    </Link>
                </h2>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
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
                    {typeLabel && <Badge variant="neutral">{typeLabel}</Badge>}
                    {vacancy.remote_option && (
                        <Badge variant="info">
                            <Wifi className="mr-1 size-3" aria-hidden="true" />
                            {t('remote')}
                        </Badge>
                    )}
                </div>
                {vacancy.description && (
                    <p className="line-clamp-3 text-sm text-muted-foreground">{vacancy.description}</p>
                )}
                {vacancy.skills_required.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {vacancy.skills_required.slice(0, 5).map((s) => (
                            <Badge key={s} variant="coral">
                                {s}
                            </Badge>
                        ))}
                    </div>
                )}
                <div className="mt-auto flex flex-col gap-3 pt-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        {salary && <span className="font-semibold text-foreground">{salary}</span>}
                        {vacancy.application_deadline && (
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                <CalendarDays className="size-4" aria-hidden="true" />
                                {t('deadline', { date: formatDate(vacancy.application_deadline, locale) })}
                            </span>
                        )}
                    </div>
                    <Button asChild className="w-full">
                        <Link href={`/careers/${vacancyId(vacancy)}`}>{t('viewApply')}</Link>
                    </Button>
                </div>
            </div>
        </article>
    );
}
