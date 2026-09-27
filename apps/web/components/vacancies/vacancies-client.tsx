'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ArrowUpDown, Briefcase, Plus, SearchX } from 'lucide-react';
import { vacancyListSchema, type Vacancy } from '@/lib/schemas';
import { fetchJson, sendJson } from '@/lib/http';
import { formatDate, formatSalary, vacancyId } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { VacancyFormDialog } from './vacancy-form-dialog';

interface Filters {
    search: string;
    status: string;
    department: string;
    type: string;
    remoteOnly: boolean;
}

const EMPTY: Filters = { search: '', status: '', department: '', type: '', remoteOnly: false };
const VACANCY_STATUS_FILTERS = ['Active', 'Paused', 'Closed', 'Draft'] as const;
type SortKey = 'title' | 'department' | 'status' | 'deadline';

export function VacanciesClient() {
    const t = useTranslations('vacancies');
    const tTypes = useTranslations('vacancyType');
    const tStatus = useTranslations('status');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [vacancies, setVacancies] = React.useState<Vacancy[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [filters, setFilters] = React.useState<Filters>(EMPTY);
    const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'title', dir: 'asc' });

    const [createOpen, setCreateOpen] = React.useState(false);
    const [editing, setEditing] = React.useState<Vacancy | null>(null);
    const [deleting, setDeleting] = React.useState<Vacancy | null>(null);
    const [deleteBusy, setDeleteBusy] = React.useState(false);

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            setVacancies(await fetchJson('/api/proxy/vacancies', vacancyListSchema));
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    const options = React.useMemo(() => {
        const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();
        return {
            departments: uniq(vacancies.map((v) => v.department)),
            types: uniq(vacancies.map((v) => v.type))
        };
    }, [vacancies]);

    const filtered = React.useMemo(() => {
        const q = filters.search.trim().toLowerCase();
        const rows = vacancies.filter((v) => {
            if (filters.status && v.status !== filters.status) return false;
            if (filters.department && v.department !== filters.department) return false;
            if (filters.type && v.type !== filters.type) return false;
            if (filters.remoteOnly && !v.remote_option) return false;
            if (q) {
                const hay =
                    `${v.title} ${v.department} ${v.location} ${v.description} ${v.skills_required.join(' ')}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
        const val = (v: Vacancy): string | number => {
            switch (sort.key) {
                case 'title':
                    return v.title.toLowerCase();
                case 'department':
                    return v.department.toLowerCase();
                case 'status':
                    return v.status.toLowerCase();
                case 'deadline':
                    return v.application_deadline ? Date.parse(v.application_deadline) || 0 : 0;
            }
        };
        rows.sort((a, b) => {
            const va = val(a);
            const vb = val(b);
            const cmp =
                typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
            return sort.dir === 'asc' ? cmp : -cmp;
        });
        return rows;
    }, [vacancies, filters, sort]);

    const toggleSort = (key: SortKey) =>
        setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

    const confirmDelete = async () => {
        if (!deleting || deleteBusy) return;
        setDeleteBusy(true);
        try {
            const { res } = await sendJson(`/api/proxy/vacancies/${vacancyId(deleting)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('delete.success'));
            setDeleting(null);
            load();
        } catch {
            toast.error(t('delete.error'));
        } finally {
            setDeleteBusy(false);
        }
    };

    const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

    const SortableHead = ({ id, label }: { id: SortKey; label: string }) => (
        <TableHead aria-sort={sort.key === id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
            <button
                type="button"
                onClick={() => toggleSort(id)}
                className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-foreground"
                aria-label={`${label} — ${sort.key === id && sort.dir === 'asc' ? t('table.sortDesc') : t('table.sortAsc')}`}
            >
                {label}
                {sort.key === id ? (
                    sort.dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden="true" />
                    ) : (
                        <ArrowDown className="size-3" aria-hidden="true" />
                    )
                ) : (
                    <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
                )}
            </button>
        </TableHead>
    );

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <Button onClick={() => setCreateOpen(true)}>
                    <Plus aria-hidden="true" />
                    {t('new')}
                </Button>
            </div>

            {/* Filter bar */}
            <div className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="vf-search">{t('filters.search')}</Label>
                    <Input
                        id="vf-search"
                        type="search"
                        value={filters.search}
                        placeholder={t('filters.search')}
                        onChange={(e) => set({ search: e.target.value })}
                    />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="vf-status">{t('filters.status')}</Label>
                    <Select id="vf-status" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
                        <option value="">{t('filters.allStatuses')}</option>
                        {VACANCY_STATUS_FILTERS.map((s) => (
                            <option key={s} value={s}>
                                {tStatus(s.toLowerCase() as 'active' | 'paused' | 'closed' | 'draft')}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="vf-dept">{t('filters.department')}</Label>
                    <Select
                        id="vf-dept"
                        value={filters.department}
                        onChange={(e) => set({ department: e.target.value })}
                    >
                        <option value="">{t('filters.allDepartments')}</option>
                        {options.departments.map((d) => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="vf-type">{t('filters.type')}</Label>
                    <Select id="vf-type" value={filters.type} onChange={(e) => set({ type: e.target.value })}>
                        <option value="">{t('filters.allTypes')}</option>
                        {options.types.map((ty) => (
                            <option key={ty} value={ty}>
                                {tTypes.has(ty) ? tTypes(ty) : ty}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex items-end justify-between gap-3 pb-1">
                    <div className="flex items-center gap-2">
                        <Switch
                            id="vf-remote"
                            checked={filters.remoteOnly}
                            onCheckedChange={(v) => set({ remoteOnly: v })}
                        />
                        <Label htmlFor="vf-remote" className="font-normal">
                            {t('filters.remoteOnly')}
                        </Label>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY)}>
                        {t('filters.clear')}
                    </Button>
                </div>
            </div>

            {/* Results */}
            {state === 'loading' ? (
                <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-2">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-14 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : filtered.length === 0 ? (
                <EmptyState
                    icon={<Briefcase />}
                    title={t('empty')}
                    description={t('emptyHint')}
                    actionLabel={t('filters.clear')}
                    onAction={() => setFilters(EMPTY)}
                />
            ) : (
                <>
                    <p className="text-sm text-muted-foreground" role="status">
                        {t('count', { count: filtered.length })}
                    </p>
                    <div className="rounded-xl border border-border bg-card shadow-sm">
                        <Table>
                            <caption className="sr-only">{t('table.caption')}</caption>
                            <TableHeader>
                                <TableRow>
                                    <SortableHead id="title" label={t('table.title')} />
                                    <SortableHead id="department" label={t('table.department')} />
                                    <TableHead>{t('table.location')}</TableHead>
                                    <TableHead>{t('table.type')}</TableHead>
                                    <SortableHead id="status" label={t('table.status')} />
                                    <SortableHead id="deadline" label={t('table.deadline')} />
                                    <TableHead>{t('table.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map((v) => (
                                    <TableRow key={vacancyId(v)}>
                                        <TableCell>
                                            <Link
                                                href={`/vacancies/${vacancyId(v)}`}
                                                className="font-medium text-foreground underline-offset-4 hover:underline"
                                            >
                                                {v.title}
                                            </Link>
                                            {v.salary_range && (
                                                <p className="mt-0.5 text-xs text-muted-foreground">
                                                    {formatSalary(v.salary_range, locale)}
                                                </p>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">{v.department || '—'}</TableCell>
                                        <TableCell className="text-muted-foreground">{v.location || '—'}</TableCell>
                                        <TableCell className="text-muted-foreground">
                                            {v.type ? (tTypes.has(v.type) ? tTypes(v.type) : v.type) : '—'}
                                        </TableCell>
                                        <TableCell>
                                            <StatusBadge status={v.status || 'Draft'} />
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-muted-foreground">
                                            {v.application_deadline ? formatDate(v.application_deadline, locale) : '—'}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-1">
                                                <Button asChild variant="ghost" size="sm">
                                                    <Link href={`/vacancies/${vacancyId(v)}`}>{t('actions.view')}</Link>
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => setEditing(v)}>
                                                    {t('actions.edit')}
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="text-danger-600 hover:text-danger-700 dark:text-red-300"
                                                    onClick={() => setDeleting(v)}
                                                >
                                                    {t('actions.delete')}
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}

            <VacancyFormDialog open={createOpen} onOpenChange={setCreateOpen} mode="create" onSaved={load} />
            <VacancyFormDialog
                open={editing !== null}
                onOpenChange={(o) => !o && setEditing(null)}
                mode="edit"
                vacancy={editing ?? undefined}
                onSaved={load}
            />

            {/* Delete confirmation — cascade warning (applications are
                soft-deleted with the vacancy). */}
            <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <DialogContent closeLabel={tCommon('close')}>
                    <DialogHeader>
                        <DialogTitle>{t('delete.title')}</DialogTitle>
                        <DialogDescription>
                            {deleting ? t('delete.body', { title: deleting.title }) : ''}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setDeleting(null)} disabled={deleteBusy}>
                            {tCommon('cancel')}
                        </Button>
                        <Button variant="danger" onClick={confirmDelete} loading={deleteBusy}>
                            {deleteBusy ? t('delete.deleting') : t('delete.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
