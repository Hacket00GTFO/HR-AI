'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { SearchX } from 'lucide-react';
import type { Vacancy } from '@/lib/schemas';
import { vacancyListSchema } from '@/lib/schemas';
import { VacancyCard } from './vacancy-card';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
    initialVacancies: Vacancy[] | null;
    initialError: boolean;
}

interface Filters {
    department: string;
    location: string;
    type: string;
    remoteOnly: boolean;
    search: string;
}

const EMPTY: Filters = { department: '', location: '', type: '', remoteOnly: false, search: '' };

export function CareersBrowser({ initialVacancies, initialError }: Props) {
    const t = useTranslations('careers');
    const tTypes = useTranslations('vacancyType');
    const tCommon = useTranslations('common');
    const [vacancies, setVacancies] = React.useState<Vacancy[]>(initialVacancies ?? []);
    const [error, setError] = React.useState(initialError);
    const [loading, setLoading] = React.useState(false);
    const [filters, setFilters] = React.useState<Filters>(EMPTY);

    const retry = async () => {
        setLoading(true);
        setError(false);
        try {
            const res = await fetch('/api/vacancies');
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
        const q = filters.search.trim().toLowerCase();
        return vacancies.filter((v) => {
            if (filters.department && v.department !== filters.department) return false;
            if (filters.location && v.location !== filters.location) return false;
            if (filters.type && v.type !== filters.type) return false;
            if (filters.remoteOnly && !v.remote_option) return false;
            if (q) {
                const hay =
                    `${v.title} ${v.department} ${v.location} ${v.description} ${v.skills_required.join(' ')}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }, [vacancies, filters]);

    const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

    return (
        <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
            {/* Filter bar */}
            <div className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="filter-department">{t('filters.department')}</Label>
                    <Select
                        id="filter-department"
                        value={filters.department}
                        onChange={(e) => set({ department: e.target.value })}
                    >
                        <option value="">{t('filters.department')}</option>
                        {options.departments.map((d) => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="filter-location">{t('filters.location')}</Label>
                    <Select
                        id="filter-location"
                        value={filters.location}
                        onChange={(e) => set({ location: e.target.value })}
                    >
                        <option value="">{t('filters.location')}</option>
                        {options.locations.map((l) => (
                            <option key={l} value={l}>
                                {l}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="filter-type">{t('filters.type')}</Label>
                    <Select id="filter-type" value={filters.type} onChange={(e) => set({ type: e.target.value })}>
                        <option value="">{t('filters.type')}</option>
                        {options.types.map((ty) => (
                            <option key={ty} value={ty}>
                                {tTypes.has(ty) ? tTypes(ty) : ty}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="filter-search">{t('filters.search')}</Label>
                    <Input
                        id="filter-search"
                        type="search"
                        value={filters.search}
                        placeholder={t('filters.search')}
                        onChange={(e) => set({ search: e.target.value })}
                    />
                </div>
                <div className="flex items-end justify-between gap-3 pb-1">
                    <div className="flex items-center gap-2">
                        <Switch
                            id="filter-remote"
                            checked={filters.remoteOnly}
                            onCheckedChange={(v) => set({ remoteOnly: v })}
                        />
                        <Label htmlFor="filter-remote" className="font-normal">
                            {t('filters.remote')}
                        </Label>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY)}>
                        {t('filters.clear')}
                    </Button>
                </div>
            </div>

            {/* Results */}
            <div className="mt-6">
                {error ? (
                    <EmptyState
                        icon={<SearchX />}
                        title={t('results.error')}
                        actionLabel={tCommon('retry')}
                        onAction={retry}
                    />
                ) : loading ? (
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                        {[0, 1, 2].map((i) => (
                            <Skeleton key={i} className="h-72 rounded-xl" />
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <EmptyState
                        icon={<SearchX />}
                        title={t('results.empty')}
                        description={t('results.emptyHint')}
                        actionLabel={t('filters.clear')}
                        onAction={() => setFilters(EMPTY)}
                    />
                ) : (
                    <>
                        <p className="mb-4 text-sm text-muted-foreground" role="status">
                            {t('results.count', { count: filtered.length })}
                        </p>
                        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                            {filtered.map((v) => (
                                <VacancyCard key={String(v.id)} vacancy={v} />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
