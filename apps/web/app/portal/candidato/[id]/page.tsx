import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeft, Briefcase, CalendarDays, MapPin, SearchX, Wifi } from 'lucide-react';
import { fetchVacancies } from '@/lib/data';
import { formatDate, formatSalary, vacancyId } from '@/lib/utils';
import { CandidateHeader } from '@/components/portal/candidate-header';
import { CandidateApplyForm } from '@/components/portal/candidate-apply-form';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
    const { id } = await params;
    const { data } = await fetchVacancies();
    const vacancy = data?.find((v) => vacancyId(v) === id);
    return { title: vacancy?.title ?? 'Vacancy' };
}

// Public vacancy detail + application form for the candidate portal.
// There is no anonymous GET /v1/vacancies/:id upstream (detail is HR-gated),
// so — like app/careers/[id]/page.tsx — we resolve the vacancy from the
// public list response.
export default async function CandidateVacancyPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const t = await getTranslations('portal.candidate.detail');
    const tCard = await getTranslations('portal.candidate');
    const tTypes = await getTranslations('vacancyType');
    const locale = await getLocale();
    const { data } = await fetchVacancies();
    const vacancy = data?.find((v) => vacancyId(v) === id);

    return (
        <div className="min-h-dvh">
            <CandidateHeader />
            <main id="main" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
                <Link
                    href="/portal/candidato"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    {t('backToJobs')}
                </Link>

                {!vacancy ? (
                    <EmptyState icon={<SearchX />} title={t('notFound')} className="mt-8" />
                ) : (
                    <div className="mt-6 grid gap-8 lg:grid-cols-[1.4fr_1fr]">
                        <article className="flex flex-col gap-6">
                            <header className="flex flex-col gap-3">
                                <h1 className="font-display text-3xl font-bold">{vacancy.title}</h1>
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
                                    {vacancy.remote_option && (
                                        <Badge variant="info">
                                            <Wifi className="mr-1 size-3" aria-hidden="true" />
                                            {tCard('remote')}
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                                    {formatSalary(vacancy.salary_range, locale) && (
                                        <span className="font-semibold">
                                            {formatSalary(vacancy.salary_range, locale)}
                                        </span>
                                    )}
                                    {vacancy.experience_level && (
                                        <span className="text-muted-foreground">{vacancy.experience_level}</span>
                                    )}
                                    {vacancy.application_deadline && (
                                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                            <CalendarDays className="size-4" aria-hidden="true" />
                                            {t('deadline', {
                                                date: formatDate(vacancy.application_deadline, locale)
                                            })}
                                        </span>
                                    )}
                                </div>
                            </header>

                            {vacancy.description && (
                                <section>
                                    <h2 className="font-display text-lg font-semibold">{t('description')}</h2>
                                    <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                                        {vacancy.description}
                                    </p>
                                </section>
                            )}
                            {vacancy.responsibilities && (
                                <section>
                                    <h2 className="font-display text-lg font-semibold">{t('responsibilities')}</h2>
                                    <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                                        {vacancy.responsibilities}
                                    </p>
                                </section>
                            )}
                            {vacancy.requirements && (
                                <section>
                                    <h2 className="font-display text-lg font-semibold">{t('requirements')}</h2>
                                    <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                                        {vacancy.requirements}
                                    </p>
                                </section>
                            )}
                            {vacancy.benefits.length > 0 && (
                                <section>
                                    <h2 className="font-display text-lg font-semibold">{t('benefits')}</h2>
                                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                                        {vacancy.benefits.map((b) => (
                                            <li key={b}>{b}</li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                            {vacancy.skills_required.length > 0 && (
                                <section>
                                    <h2 className="font-display text-lg font-semibold">{t('skills')}</h2>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {vacancy.skills_required.map((s) => (
                                            <Badge key={s} variant="coral">
                                                {s}
                                            </Badge>
                                        ))}
                                    </div>
                                </section>
                            )}
                        </article>

                        <div className="lg:sticky lg:top-24 lg:self-start">
                            <CandidateApplyForm
                                vacancyId={Number(vacancy.id ?? vacancy._id)}
                                vacancyTitle={vacancy.title}
                            />
                        </div>
                    </div>
                )}
            </main>
            <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted-foreground">
                StraforAI © {new Date().getFullYear()}
            </footer>
        </div>
    );
}
