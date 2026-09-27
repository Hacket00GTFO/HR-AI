'use client';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { fetchJson, sendJson } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { z } from 'zod';

const brandingSchema = z.object({
    id: z.union([z.number(), z.string()]).optional(),
    logo_url: z.string().optional().nullable(),
    primary_color: z.string().optional().default('#FF6B4A'),
    secondary_color: z.string().optional().default('#1A1F36'),
    font_family: z.string().optional().default('Inter'),
    custom_domain: z.string().optional().nullable(),
    custom_css: z.string().optional().nullable()
});
type Branding = z.infer<typeof brandingSchema>;

export function BrandingClient() {
    const t = useTranslations();
    const [config, setConfig] = React.useState<Branding | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);

    const [logoUrl, setLogoUrl] = React.useState('');
    const [primaryColor, setPrimaryColor] = React.useState('#FF6B4A');
    const [secondaryColor, setSecondaryColor] = React.useState('#1A1F36');
    const [fontFamily, setFontFamily] = React.useState('Inter');
    const [customDomain, setCustomDomain] = React.useState('');
    const [customCss, setCustomCss] = React.useState('');

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchJson('/api/proxy/admin/branding', brandingSchema);
            setConfig(data);
            setLogoUrl(data.logo_url ?? '');
            setPrimaryColor(data.primary_color ?? '#FF6B4A');
            setSecondaryColor(data.secondary_color ?? '#1A1F36');
            setFontFamily(data.font_family ?? 'Inter');
            setCustomDomain(data.custom_domain ?? '');
            setCustomCss(data.custom_css ?? '');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load branding');
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    async function save() {
        setSaving(true);
        try {
            const { res } = await sendJson('/api/proxy/admin/branding', {
                method: 'PUT',
                body: {
                    logo_url: logoUrl,
                    primary_color: primaryColor,
                    secondary_color: secondaryColor,
                    font_family: fontFamily,
                    custom_domain: customDomain,
                    custom_css: customCss
                }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('admin.branding.saved'));
            await load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t('admin.branding.saveFailed'));
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-64 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (error) {
        return (
            <EmptyState
                title={t('admin.branding.errorTitle')}
                description={error}
                actionLabel={t('admin.branding.retry')}
                onAction={load}
            />
        );
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t('admin.branding.title')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* Preview */}
                    <div className="space-y-2">
                        <p className="text-sm font-medium text-muted-foreground">{t('admin.branding.preview')}</p>
                        <div
                            className="flex h-24 w-full items-center justify-center rounded-md border"
                            style={{
                                backgroundColor: primaryColor,
                                color: secondaryColor,
                                fontFamily: fontFamily
                            }}
                        >
                            <span className="text-lg font-semibold">{t('admin.branding.previewText')}</span>
                        </div>
                    </div>

                    {/* Logo URL */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">{t('admin.branding.logoUrl')}</label>
                        <Input
                            value={logoUrl}
                            onChange={(e) => setLogoUrl(e.target.value)}
                            placeholder="https://example.com/logo.png"
                        />
                    </div>

                    {/* Primary Color */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">{t('admin.branding.primaryColor')}</label>
                        <div className="flex items-center gap-2">
                            <Input
                                type="color"
                                value={primaryColor}
                                onChange={(e) => setPrimaryColor(e.target.value)}
                                className="h-10 w-16 cursor-pointer p-1"
                            />
                            <Input
                                value={primaryColor}
                                onChange={(e) => setPrimaryColor(e.target.value)}
                                className="flex-1"
                            />
                        </div>
                    </div>

                    {/* Secondary Color */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">{t('admin.branding.secondaryColor')}</label>
                        <div className="flex items-center gap-2">
                            <Input
                                type="color"
                                value={secondaryColor}
                                onChange={(e) => setSecondaryColor(e.target.value)}
                                className="h-10 w-16 cursor-pointer p-1"
                            />
                            <Input
                                value={secondaryColor}
                                onChange={(e) => setSecondaryColor(e.target.value)}
                                className="flex-1"
                            />
                        </div>
                    </div>

                    {/* Font Family */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">{t('admin.branding.fontFamily')}</label>
                        <Input value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} placeholder="Inter" />
                    </div>

                    {/* Custom Domain */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">{t('admin.branding.customDomain')}</label>
                        <Input
                            value={customDomain}
                            onChange={(e) => setCustomDomain(e.target.value)}
                            placeholder="app.example.com"
                        />
                    </div>

                    {/* Custom CSS */}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">{t('admin.branding.customCss')}</label>
                        <textarea
                            value={customCss}
                            onChange={(e) => setCustomCss(e.target.value)}
                            rows={10}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            placeholder="/* Custom CSS */"
                        />
                    </div>

                    {/* Save */}
                    <div className="flex justify-end">
                        <Button variant="primary" onClick={save} disabled={saving}>
                            {saving ? t('admin.branding.saving') : t('admin.branding.save')}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
