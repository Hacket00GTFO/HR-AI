'use client';

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Briefcase, MapPin, SearchX, Wifi } from 'lucide-react';
import type { Vacancy } from '@/lib/schemas';
import { vacancyListSchema } from '@/lib/schemas';
import { vacancyId } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
    initialVacancies: Vacancy[] | null;
    initialError: boolean;
}

// Public vacancy browser for the candidate portal: client-side search +
// department/location/type filters over the anonymous GET /api/v1/vacancies
// listing (retried via the existing /api/vacancies BFF route on error).
export function CandidateJobsClient({ initialVacancies, initialError }: Props) {
    const t = useTranslations('portal.candidate');
    const tTypes = useTranslations('vacancyType');
    const tCommon = useTranslations('common');

    const [vacancies, setVacancies] = React.useState<Vacancy[]>(initialVacancies ?? []);
    const [error, setError] = React.useState(initialError);
    const [loading, setLoading] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const [department, setDepartment] = React.useState('');
    const [location, setLocation] = React.useState('');
    const [type, setType] = React.useState('');

    const retry = async () => {
        setLoading(true);
        setError(false);
        try {
            const res = await fetch('/api/vacancies', { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(String(res.status));
            const parsed = vacancyListSchema.safeParse(await res.json());
            if (!parsed.success) throw new Error('bad payload');
            setVacancies(parsed.data);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    };

    const options = React.useMemo(() => {
        const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
        return {
            departments: uniq(vacancies.map((v) => v.department)),
            locations: uniq(vacancies.map((v) => v.location)),
            types: uniq(vacancies.map((v) => v.type))
        };
    }, [vacancies]);

    const filtered = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        return vacancies.filter((v) => {
            if (department && v.department !== department) return false;
            if (location && v.location !== location) return false;
            if (type && v.type !== type) return false;
            if (q) {
                const hay =
                    `${v.title} ${v.department} ${v.location} ${v.description} ${v.skills_required.join(' ')}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }, [vacancies, search, department, location, type]);

    const clearFilters = () => {
        setSearch('');
        setDepartment('');
        setLocation('');
        setType('');
    };

    return (
        <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
            <div className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cand-search">{t('filters.search')}</Label>
                    <Input
                        id="cand-search"
                        type="search"
                        value={search}
                        placeholder={t('filters.search')}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cand-department">{t('filters.department')}</Label>
                    <Select id="cand-department" value={department} onChange={(e) => setDepartment(e.target.value)}>
                        <option value="">{t('filters.department')}</option>
                        {options.departments.map((d) => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cand-location">{t('filters.location')}</Label>
                    <Select id="cand-location" value={location} onChange={(e) => setLocation(e.target.value)}>
                        <option value="">{t('filters.location')}</option>
                        {options.locations.map((l) => (
                            <option key={l} value={l}>
                                {l}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cand-type">{t('filters.type')}</Label>
                    <Select id="cand-type" value={type} onChange={(e) => setType(e.target.value)}>
                        <option value="">{t('filters.type')}</option>
                        {options.types.map((ty) => (
                            <option key={ty} value={ty}>
                                {tTypes.has(ty) ? tTypes(ty) : ty}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex items-end pb-1">
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        {t('filters.clear')}
                    </Button>
                </div>
            </div>

            <div className="mt-6">
                {error ? (
                    <EmptyState
                        icon={<SearchX />}
                        title={t('results.error')}
                        actionLabel={tCommon('retry')}
                        onAction={retry}
                    />
                ) : loading ? (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {[0, 1, 2].map((i) => (
                            <Skeleton key={i} className="h-48 rounded-xl" />
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <EmptyState
                        icon={<SearchX />}
                        title={t('results.empty')}
                        description={t('results.emptyHint')}
                        actionLabel={t('filters.clear')}
                        onAction={clearFilters}
                    />
                ) : (
                    <>
                        <p className="mb-4 text-sm text-muted-foreground" role="status">
                            {t('results.count', { count: filtered.length })}
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {filtered.map((v) => (
                                <Card key={vacancyId(v)} className="flex flex-col">
                                    <CardHeader className="pb-3">
                                        <CardTitle className="text-base leading-snug">{v.title}</CardTitle>
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                            {v.department && (
                                                <span className="inline-flex items-center gap-1">
                                                    <Briefcase className="size-3.5" aria-hidden="true" />
                                                    {v.department}
                                                </span>
                                            )}
                                            {v.location && (
                                                <span className="inline-flex items-center gap-1">
                                                    <MapPin className="size-3.5" aria-hidden="true" />
                                                    {v.location}
                                                </span>
                                            )}
                                        </div>
                                    </CardHeader>
                                    <CardContent className="mt-auto flex flex-col gap-3">
                                        <div className="flex flex-wrap gap-1.5">
                                            {v.type && (
                                                <Badge variant="neutral">
                                                    {tTypes.has(v.type) ? tTypes(v.type) : v.type}
                                                </Badge>
                                            )}
                                            {v.remote_option && (
                                                <Badge variant="info">
                                                    <Wifi className="mr-1 size-3" aria-hidden="true" />
                                                    {t('remote')}
                                                </Badge>
                                            )}
                                        </div>
                                        <Button asChild variant="secondary" size="sm" className="w-full">
                                            <Link href={`/portal/candidato/${vacancyId(v)}`}>{t('viewApply')}</Link>
                                        </Button>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
