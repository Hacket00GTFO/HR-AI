'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2, User } from 'lucide-react';
import { sendJson, errorMessage } from '@/lib/http';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface ProfileData {
    firstName: string;
    lastName: string;
    email: string;
    role: string;
    country: string;
    city: string;
}

interface CompanyData {
    name: string;
    industry: string;
    size: string;
    location: string;
}

const EMPTY_PROFILE: ProfileData = {
    firstName: '',
    lastName: '',
    email: '',
    role: '',
    country: '',
    city: ''
};

const EMPTY_COMPANY: CompanyData = {
    name: '',
    industry: '',
    size: '',
    location: ''
};

export function SettingsClient({ role }: { role?: string | undefined }) {
    const t = useTranslations('settings');
    const tCommon = useTranslations('common');
    const isAdmin = role === 'admin';
    const [profile, setProfile] = React.useState<ProfileData>(EMPTY_PROFILE);
    const [company, setCompany] = React.useState<CompanyData>(EMPTY_COMPANY);
    const [countries, setCountries] = React.useState<string[]>([]);
    const [cities, setCities] = React.useState<string[]>([]);
    const [profileLoading, setProfileLoading] = React.useState(true);
    const [companyLoading, setCompanyLoading] = React.useState(true);
    const [savingProfile, setSavingProfile] = React.useState(false);
    const [savingCompany, setSavingCompany] = React.useState(false);

    React.useEffect(() => {
        // Load profile
        (async () => {
            try {
                const res = await fetch('/api/proxy/user/profile');
                if (!res.ok) throw new Error(String(res.status));
                const data = await res.json();
                setProfile({
                    firstName: data.firstName ?? '',
                    lastName: data.lastName ?? '',
                    email: data.email ?? '',
                    role: data.role ?? '',
                    country: data.location?.country ?? '',
                    city: data.location?.city ?? ''
                });
            } catch {
                toast.error(t('profile.loadError'));
            } finally {
                setProfileLoading(false);
            }
        })();

        // Load company settings — company configuration is platform-level and
        // admin-only (the backend rejects other roles with 403).
        if (isAdmin) {
            (async () => {
                try {
                    const res = await fetch('/api/proxy/settings');
                    if (!res.ok) throw new Error(String(res.status));
                    const data = await res.json();
                    setCompany({
                        name: data.company?.name ?? '',
                        industry: data.company?.industry ?? '',
                        size: String(data.company?.size ?? ''),
                        location: data.company?.location ?? ''
                    });
                } catch {
                    toast.error(t('company.loadError'));
                } finally {
                    setCompanyLoading(false);
                }
            })();
        } else {
            setCompanyLoading(false);
        }

        // Load countries
        fetch('/api/countries')
            .then((r) => r.json())
            .then((data: string[]) => setCountries(data))
            .catch(() => {});
    }, [t, isAdmin]);

    const onCountryChange = async (country: string) => {
        setProfile((p) => ({ ...p, country, city: '' }));
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

    const saveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        if (savingProfile) return;
        setSavingProfile(true);
        try {
            const { res, data } = await sendJson('/api/proxy/user/profile', {
                method: 'PUT',
                body: {
                    firstName: profile.firstName,
                    lastName: profile.lastName,
                    location: { country: profile.country || undefined, city: profile.city || undefined }
                }
            });
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('profile.error'));
                return;
            }
            toast.success(t('profile.saved'));
        } catch {
            toast.error(t('profile.error'));
        } finally {
            setSavingProfile(false);
        }
    };

    const saveCompany = async (e: React.FormEvent) => {
        e.preventDefault();
        if (savingCompany) return;
        setSavingCompany(true);
        try {
            const { res, data } = await sendJson('/api/proxy/settings/company', {
                method: 'POST',
                body: {
                    name: company.name,
                    industry: company.industry,
                    size: company.size,
                    location: company.location
                }
            });
            if (!res.ok) {
                toast.error(errorMessage(data) ?? t('company.error'));
                return;
            }
            toast.success(t('company.saved'));
        } catch {
            toast.error(t('company.error'));
        } finally {
            setSavingCompany(false);
        }
    };

    return (
        <div className="flex flex-col gap-8">
            <h1 className="font-display text-2xl font-bold">{t('title')}</h1>

            {/* Profile */}
            <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                    <User className="size-5 text-muted-foreground" aria-hidden="true" />
                    <h2 className="font-display text-lg font-semibold">{t('profile.title')}</h2>
                </div>
                {profileLoading ? (
                    <div className="flex flex-col gap-3">
                        {[0, 1, 2, 3].map((i) => (
                            <Skeleton key={i} className="h-10 rounded-lg" />
                        ))}
                    </div>
                ) : (
                    <form onSubmit={saveProfile} className="flex flex-col gap-4" noValidate>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField label={t('profile.firstName')} id="sp-first">
                                <Input
                                    value={profile.firstName}
                                    onChange={(e) => setProfile((p) => ({ ...p, firstName: e.target.value }))}
                                />
                            </FormField>
                            <FormField label={t('profile.lastName')} id="sp-last">
                                <Input
                                    value={profile.lastName}
                                    onChange={(e) => setProfile((p) => ({ ...p, lastName: e.target.value }))}
                                />
                            </FormField>
                        </div>
                        <FormField label={t('profile.email')} id="sp-email">
                            <Input type="email" value={profile.email} disabled readOnly />
                        </FormField>
                        <FormField label={t('profile.role')} id="sp-role">
                            <Input value={profile.role} disabled readOnly />
                        </FormField>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <FormField label={t('profile.country')} id="sp-country">
                                <Select value={profile.country} onChange={(e) => onCountryChange(e.target.value)}>
                                    <option value="">{t('profile.selectCountry')}</option>
                                    {countries.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                            <FormField label={t('profile.city')} id="sp-city">
                                <Select
                                    value={profile.city}
                                    onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))}
                                >
                                    <option value="">{t('profile.selectCity')}</option>
                                    {cities.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </Select>
                            </FormField>
                        </div>
                        <div>
                            <Button type="submit" loading={savingProfile}>
                                {savingProfile ? tCommon('saving') : t('profile.save')}
                            </Button>
                        </div>
                    </form>
                )}
            </section>

            {/* Company — admin only */}
            {isAdmin && (
                <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
                    <div className="mb-4 flex items-center gap-2">
                        <Building2 className="size-5 text-muted-foreground" aria-hidden="true" />
                        <h2 className="font-display text-lg font-semibold">{t('company.title')}</h2>
                    </div>
                    {companyLoading ? (
                        <div className="flex flex-col gap-3">
                            {[0, 1, 2, 3].map((i) => (
                                <Skeleton key={i} className="h-10 rounded-lg" />
                            ))}
                        </div>
                    ) : (
                        <form onSubmit={saveCompany} className="flex flex-col gap-4" noValidate>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <FormField label={t('company.name')} id="sc-name">
                                    <Input
                                        value={company.name}
                                        onChange={(e) => setCompany((c) => ({ ...c, name: e.target.value }))}
                                    />
                                </FormField>
                                <FormField label={t('company.industry')} id="sc-industry">
                                    <Input
                                        value={company.industry}
                                        onChange={(e) => setCompany((c) => ({ ...c, industry: e.target.value }))}
                                    />
                                </FormField>
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <FormField label={t('company.size')} id="sc-size">
                                    <Input
                                        value={company.size}
                                        onChange={(e) => setCompany((c) => ({ ...c, size: e.target.value }))}
                                    />
                                </FormField>
                                <FormField label={t('company.location')} id="sc-location">
                                    <Input
                                        value={company.location}
                                        onChange={(e) => setCompany((c) => ({ ...c, location: e.target.value }))}
                                    />
                                </FormField>
                            </div>
                            <div>
                                <Button type="submit" loading={savingCompany}>
                                    {savingCompany ? tCommon('saving') : t('company.save')}
                                </Button>
                            </div>
                        </form>
                    )}
                </section>
            )}

            {/* Notifications placeholder */}
            <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
                <h2 className="mb-2 font-display text-lg font-semibold">{t('notifications.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('notifications.comingSoon')}</p>
            </section>
        </div>
    );
}
