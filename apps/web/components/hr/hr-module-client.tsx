'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Plus, SearchX } from 'lucide-react';
import { sendJson } from '@/lib/http';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface ColumnDef {
    key: string;
    label: string;
    render?: (row: Record<string, unknown>) => React.ReactNode;
}

interface Props {
    /** i18n namespace, e.g. 'hr.employees' */
    namespace: string;
    /** BFF proxy path, e.g. '/api/proxy/hr/employees' */
    endpoint: string;
    columns: ColumnDef[];
    /** Fields to show in the create/edit form */
    formFields?: {
        key: string;
        label: string;
        type?: 'text' | 'number' | 'date' | 'select' | 'textarea';
        options?: string[];
    }[];
}

export function HRModuleClient({ namespace, endpoint, columns, formFields = [] }: Props) {
    const t = useTranslations(namespace);
    const tCommon = useTranslations('common');
    const [rows, setRows] = React.useState<Record<string, unknown>[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [search, setSearch] = React.useState('');
    const [dialogOpen, setDialogOpen] = React.useState(false);
    const [editing, setEditing] = React.useState<Record<string, unknown> | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [formData, setFormData] = React.useState<Record<string, string>>({});

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const qs = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : '';
            const res = await fetch(`${endpoint}${qs}`, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setRows(Array.isArray(data) ? data : []);
            setState('done');
        } catch {
            setState('error');
        }
    }, [endpoint, search]);

    React.useEffect(() => {
        load();
    }, [load]);

    const openCreate = () => {
        setEditing(null);
        setFormData({});
        setDialogOpen(true);
    };

    const openEdit = (row: Record<string, unknown>) => {
        setEditing(row);
        const fd: Record<string, string> = {};
        for (const f of formFields) {
            const val = row[f.key];
            fd[f.key] = val != null ? String(val) : '';
        }
        setFormData(fd);
        setDialogOpen(true);
    };

    const save = async () => {
        setSaving(true);
        try {
            const body: Record<string, unknown> = {};
            for (const f of formFields) {
                const v = formData[f.key];
                if (v !== undefined && v !== '') {
                    body[f.key] = f.type === 'number' ? Number(v) : v;
                }
            }
            const { res } = editing
                ? await sendJson(`${endpoint}/${editing.id}`, { method: 'PUT', body })
                : await sendJson(endpoint, { method: 'POST', body });
            if (!res.ok) throw new Error(String(res.status));
            setDialogOpen(false);
            load();
        } catch {
            /* toast */
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: unknown) => {
        try {
            const { res } = await sendJson(`${endpoint}/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(String(res.status));
            load();
        } catch {
            /* toast */
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                {formFields.length > 0 && (
                    <Button onClick={openCreate}>
                        <Plus aria-hidden="true" />
                        {t('add')}
                    </Button>
                )}
            </div>

            <div className="flex flex-col gap-1.5">
                <Label htmlFor="hr-search">{tCommon('search')}</Label>
                <Input
                    id="hr-search"
                    type="search"
                    value={search}
                    placeholder={tCommon('search')}
                    onChange={(e) => setSearch(e.target.value)}
                    className="max-w-sm"
                />
            </div>

            {state === 'loading' ? (
                <div aria-busy="true" className="flex flex-col gap-2">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-14 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : rows.length === 0 ? (
                <EmptyState icon={<SearchX />} title={t('empty')} />
            ) : (
                <div className="rounded-xl border border-border bg-card shadow-sm">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {columns.map((c) => (
                                    <TableHead key={c.key}>{c.label}</TableHead>
                                ))}
                                {formFields.length > 0 && <TableHead>{tCommon('actions')}</TableHead>}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row, i) => (
                                <TableRow key={String(row.id ?? i)}>
                                    {columns.map((c) => (
                                        <TableCell key={c.key}>
                                            {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                                        </TableCell>
                                    ))}
                                    {formFields.length > 0 && (
                                        <TableCell>
                                            <div className="flex gap-2">
                                                <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                                                    {tCommon('edit')}
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => remove(row.id)}
                                                    className="text-destructive"
                                                >
                                                    {tCommon('delete')}
                                                </Button>
                                            </div>
                                        </TableCell>
                                    )}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {dialogOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 p-4">
                    <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg">
                        <h2 className="mb-4 font-display text-lg font-semibold">
                            {editing ? tCommon('edit') : t('add')}
                        </h2>
                        <div className="flex flex-col gap-3">
                            {formFields.map((f) => (
                                <div key={f.key} className="flex flex-col gap-1.5">
                                    <Label htmlFor={`ff-${f.key}`}>{f.label}</Label>
                                    {f.type === 'textarea' ? (
                                        <textarea
                                            id={`ff-${f.key}`}
                                            className="rounded-md border border-border bg-input p-2 text-sm"
                                            rows={3}
                                            value={formData[f.key] ?? ''}
                                            onChange={(e) => setFormData((d) => ({ ...d, [f.key]: e.target.value }))}
                                        />
                                    ) : f.type === 'select' ? (
                                        <select
                                            id={`ff-${f.key}`}
                                            className="rounded-md border border-border bg-input p-2 text-sm"
                                            value={formData[f.key] ?? ''}
                                            onChange={(e) => setFormData((d) => ({ ...d, [f.key]: e.target.value }))}
                                        >
                                            <option value="">—</option>
                                            {(f.options ?? []).map((o) => (
                                                <option key={o} value={o}>
                                                    {o}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <Input
                                            id={`ff-${f.key}`}
                                            type={f.type ?? 'text'}
                                            value={formData[f.key] ?? ''}
                                            onChange={(e) => setFormData((d) => ({ ...d, [f.key]: e.target.value }))}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="mt-6 flex justify-end gap-2">
                            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
                                {tCommon('cancel')}
                            </Button>
                            <Button onClick={save} loading={saving}>
                                {tCommon('save')}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
