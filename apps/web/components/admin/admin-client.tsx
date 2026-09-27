'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, SearchX, ShieldCheck, Trash2, UserCog, Users } from 'lucide-react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { fetchJson, sendJson, errorMessage } from '@/lib/http';
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
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Role = 'admin' | 'hr';

const accountSchema = z
    .object({
        id: z.union([z.number(), z.string()]).optional(),
        firstName: z.string().optional().default(''),
        lastName: z.string().optional().default(''),
        email: z.string().optional().default(''),
        role: z.string().optional().default('hr'),
        location: z
            .object({
                country: z.string().nullable().optional(),
                city: z.string().nullable().optional()
            })
            .nullable()
            .optional()
    })
    .loose();
type Account = z.infer<typeof accountSchema>;
const accountListSchema = z.array(accountSchema);

interface FormValues {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    role: Role;
    country: string;
    city: string;
}

const EMPTY_FORM: FormValues = {
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    role: 'hr',
    country: '',
    city: ''
};

export function AdminClient({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations('admin');
    const tCommon = useTranslations('common');
    const [hrAccounts, setHrAccounts] = React.useState<Account[]>([]);
    const [adminAccounts, setAdminAccounts] = React.useState<Account[]>([]);
    const [hrState, setHrState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [adminState, setAdminState] = React.useState<'loading' | 'error' | 'done'>('loading');
    const [countries, setCountries] = React.useState<string[]>([]);
    const [createOpen, setCreateOpen] = React.useState(false);
    const [createRole, setCreateRole] = React.useState<Role>('hr');
    const [editing, setEditing] = React.useState<Account | null>(null);
    const [deleting, setDeleting] = React.useState<Account | null>(null);
    const [deleteBusy, setDeleteBusy] = React.useState(false);

    const loadHr = React.useCallback(async () => {
        setHrState('loading');
        try {
            setHrAccounts(await fetchJson('/api/proxy/hr-accounts', accountListSchema));
            setHrState('done');
        } catch {
            setHrState('error');
        }
    }, []);

    const loadAdmins = React.useCallback(async () => {
        setAdminState('loading');
        try {
            setAdminAccounts(await fetchJson('/api/proxy/admin-accounts', accountListSchema));
            setAdminState('done');
        } catch {
            setAdminState('error');
        }
    }, []);

    React.useEffect(() => {
        if (isAdmin) {
            loadHr();
            loadAdmins();
            fetch('/api/countries')
                .then((r) => r.json())
                .then((data: string[]) => setCountries(data))
                .catch(() => {});
        }
    }, [isAdmin, loadHr, loadAdmins]);

    if (!isAdmin) {
        return (
            <div className="flex flex-col gap-6">
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <EmptyState icon={<ShieldCheck />} title={t('forbidden')} />
            </div>
        );
    }

    const openCreate = (role: Role) => {
        setCreateRole(role);
        setCreateOpen(true);
    };

    const openEdit = (account: Account) => {
        setEditing(account);
    };

    const confirmDelete = async () => {
        if (!deleting || deleteBusy) return;
        const id = deleting.id;
        if (id == null) return;
        const endpoint = deleting.role === 'admin' ? 'admin-accounts' : 'hr-accounts';
        setDeleteBusy(true);
        try {
            const { res } = await sendJson(`/api/proxy/${endpoint}/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('delete.success'));
            setDeleting(null);
            loadHr();
            loadAdmins();
        } catch {
            toast.error(t('delete.error'));
        } finally {
            setDeleteBusy(false);
        }
    };

    const renderTable = (
        accounts: Account[],
        state: 'loading' | 'error' | 'done',
        role: Role,
        load: () => void,
        title: string,
        caption: string,
        empty: string,
        error: string
    ) => (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold">{title}</h2>
                <Button size="sm" onClick={() => openCreate(role)}>
                    <Plus aria-hidden="true" />
                    {role === 'admin' ? t('admins.new') : t('hr.new')}
                </Button>
            </div>
            {state === 'loading' ? (
                <div className="flex flex-col gap-2">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-12 rounded-lg" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={error} actionLabel={tCommon('retry')} onAction={load} />
            ) : accounts.length === 0 ? (
                <EmptyState icon={<Users />} title={empty} />
            ) : (
                <div className="rounded-xl border border-border bg-card shadow-sm">
                    <Table>
                        <caption className="sr-only">{caption}</caption>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('table.name')}</TableHead>
                                <TableHead>{t('table.email')}</TableHead>
                                <TableHead>{t('table.location')}</TableHead>
                                <TableHead>{t('table.actions')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {accounts.map((a, i) => (
                                <TableRow key={`${a.id ?? i}`}>
                                    <TableCell className="font-medium">
                                        {`${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || '—'}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">{a.email || '—'}</TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {[a.location?.city, a.location?.country].filter(Boolean).join(', ') || '—'}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-1">
                                            <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                                                {tCommon('edit')}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-danger-600 hover:text-danger-700 dark:text-red-300"
                                                onClick={() => setDeleting(a)}
                                            >
                                                <Trash2 className="size-4" aria-hidden="true" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </section>
    );

    return (
        <div className="flex flex-col gap-8">
            <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
            {renderTable(
                hrAccounts,
                hrState,
                'hr',
                loadHr,
                t('hr.title'),
                t('hr.caption'),
                t('hr.empty'),
                t('hr.error')
            )}
            {renderTable(
                adminAccounts,
                adminState,
                'admin',
                loadAdmins,
                t('admins.title'),
                t('admins.caption'),
                t('admins.empty'),
                t('admins.error')
            )}

            <AccountFormDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                mode="create"
                role={createRole}
                countries={countries}
                onSaved={() => {
                    loadHr();
                    loadAdmins();
                }}
            />
            <AccountFormDialog
                open={editing !== null}
                onOpenChange={(o) => !o && setEditing(null)}
                mode="edit"
                role={(editing?.role as Role) ?? 'hr'}
                {...(editing ? { account: editing } : {})}
                countries={countries}
                onSaved={() => {
                    loadHr();
                    loadAdmins();
                }}
            />

            <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
                <DialogContent closeLabel={tCommon('close')}>
                    <DialogHeader>
                        <DialogTitle>{t('delete.title')}</DialogTitle>
                        <DialogDescription>
                            {deleting
                                ? t('delete.body', {
                                      name: `${deleting.firstName} ${deleting.lastName}`.trim(),
                                      email: deleting.email
                                  })
                                : ''}
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

function AccountFormDialog({
    open,
    onOpenChange,
    mode,
    role,
    account,
    countries,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'edit';
    role: Role;
    account?: Account;
    countries: string[];
    onSaved: () => void;
}) {
    const t = useTranslations('admin');
    const tCommon = useTranslations('common');
    const [cities, setCities] = React.useState<string[]>([]);
    const [submitting, setSubmitting] = React.useState(false);
    const [values, setValues] = React.useState<FormValues>(EMPTY_FORM);

    React.useEffect(() => {
        if (open) {
            if (mode === 'edit' && account) {
                setValues({
                    firstName: account.firstName ?? '',
                    lastName: account.lastName ?? '',
                    email: account.email ?? '',
                    password: '',
                    role: (account.role as Role) ?? role,
                    country: account.location?.country ?? '',
                    city: account.location?.city ?? ''
                });
            } else {
                setValues({ ...EMPTY_FORM, role });
            }
        }
    }, [open, mode, account, role]);

    const endpoint = role === 'admin' ? 'admin-accounts' : 'hr-accounts';

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        try {
            if (mode === 'create') {
                const body: Record<string, unknown> = {
                    firstName: values.firstName,
                    lastName: values.lastName,
                    email: values.email,
                    password: values.password,
                    location: { country: values.country || undefined, city: values.city || undefined }
                };
                const { res, data } = await sendJson(`/api/proxy/${endpoint}`, { method: 'POST', body });
                if (!res.ok) {
                    const msg = errorMessage(data);
                    toast.error(msg ?? t('form.error'));
                    if (res.status === 429) toast.error(t('form.rateLimited'));
                    return;
                }
                toast.success(t('form.created'));
                onOpenChange(false);
                onSaved();
            } else if (account?.id != null) {
                const body: Record<string, unknown> = {
                    firstName: values.firstName,
                    lastName: values.lastName,
                    email: values.email,
                    location: { country: values.country || undefined, city: values.city || undefined }
                };
                if (values.password) body.password = values.password;
                const { res, data } = await sendJson(`/api/proxy/${endpoint}/${account.id}`, {
                    method: 'PUT',
                    body
                });
                if (!res.ok) {
                    toast.error(errorMessage(data) ?? t('form.error'));
                    return;
                }
                toast.success(t('form.updated'));
                onOpenChange(false);
                onSaved();
            }
        } catch {
            toast.error(t('form.error'));
        } finally {
            setSubmitting(false);
        }
    };

    const set = (patch: Partial<FormValues>) => setValues((v) => ({ ...v, ...patch }));

    const onCountryChange = async (country: string) => {
        set({ country, city: '' });
        if (country) {
            try {
                const res = await fetch(`/api/countries/${encodeURIComponent(country)}/states`);
                if (res.ok) {
                    const data = await res.json();
                    setCities(Array.isArray(data) ? data : []);
                }
            } catch {
                setCities([]);
            }
        } else {
            setCities([]);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto" closeLabel={tCommon('close')}>
                <DialogHeader>
                    <DialogTitle>
                        {mode === 'create' ? (role === 'admin' ? t('admins.new') : t('hr.new')) : tCommon('edit')}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('form.firstName')} id="af-first" required>
                            <Input
                                value={values.firstName}
                                onChange={(e) => set({ firstName: e.target.value })}
                                required
                            />
                        </FormField>
                        <FormField label={t('form.lastName')} id="af-last" required>
                            <Input
                                value={values.lastName}
                                onChange={(e) => set({ lastName: e.target.value })}
                                required
                            />
                        </FormField>
                    </div>
                    <FormField label={t('form.email')} id="af-email" required>
                        <Input
                            type="email"
                            value={values.email}
                            onChange={(e) => set({ email: e.target.value })}
                            required
                        />
                    </FormField>
                    <FormField
                        label={mode === 'edit' ? t('form.passwordOptional') : t('form.password')}
                        id="af-pass"
                        required={mode === 'create'}
                    >
                        <Input
                            type="password"
                            value={values.password}
                            onChange={(e) => set({ password: e.target.value })}
                            required={mode === 'create'}
                            minLength={6}
                            autoComplete="new-password"
                        />
                    </FormField>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label={t('form.country')} id="af-country">
                            <Select value={values.country} onChange={(e) => onCountryChange(e.target.value)}>
                                <option value="">{t('form.selectCountry')}</option>
                                {countries.map((c) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </Select>
                        </FormField>
                        <FormField label={t('form.city')} id="af-city">
                            <Select value={values.city} onChange={(e) => set({ city: e.target.value })}>
                                <option value="">{t('form.selectCity')}</option>
                                {cities.map((c) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </Select>
                        </FormField>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={submitting}
                        >
                            {tCommon('cancel')}
                        </Button>
                        <Button type="submit" loading={submitting}>
                            {submitting ? t('form.submitting') : mode === 'create' ? tCommon('create') : t('form.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
