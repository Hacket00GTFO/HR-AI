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
import { Badge } from '@/components/ui/badge';
import { z } from 'zod';

const templateSchema = z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    subject: z.string(),
    html_body: z.string(),
    text_body: z.string().optional().nullable(),
    variables: z.array(z.string()).or(z.record(z.string(), z.unknown())).optional().default([]),
    locale: z.string().optional().default('en'),
    version: z.number().optional().default(1),
    updated_at: z.string().optional()
});
type Template = z.infer<typeof templateSchema>;

export function EmailTemplateEditorClient() {
    const t = useTranslations('admin.emailTemplates');
    const tCommon = useTranslations('common');
    const [templates, setTemplates] = React.useState<Template[]>([]);
    const [selected, setSelected] = React.useState<Template | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);
    const [editingSubject, setEditingSubject] = React.useState('');
    const [editingHtml, setEditingHtml] = React.useState('');
    const [editingText, setEditingText] = React.useState('');
    const [saving, setSaving] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const data = await fetchJson('/api/proxy/admin/email-templates', templateSchema.array());
            setTemplates(data);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    function selectTemplate(tpl: Template) {
        setSelected(tpl);
        setEditingSubject(tpl.subject ?? '');
        setEditingHtml(tpl.html_body ?? '');
        setEditingText(tpl.text_body ?? '');
    }

    async function save() {
        if (!selected) return;
        setSaving(true);
        try {
            const { res } = await sendJson(`/api/proxy/admin/email-templates/${encodeURIComponent(selected.name)}`, {
                method: 'PUT',
                body: {
                    subject: editingSubject,
                    html_body: editingHtml,
                    text_body: editingText
                }
            });
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('saveSuccess'));
            await load();
        } catch {
            toast.error(t('error'));
        } finally {
            setSaving(false);
        }
    }

    async function preview() {
        if (!selected) return;
        try {
            const { res, data } = await sendJson(
                `/api/proxy/admin/email-templates/${encodeURIComponent(selected.name)}/preview`,
                {
                    method: 'POST',
                    body: { data: {} }
                }
            );
            if (!res.ok) throw new Error(String(res.status));
            const html =
                typeof data === 'string'
                    ? data
                    : ((data as { html?: string; rendered?: string })?.html ??
                      (data as { rendered?: string })?.rendered ??
                      '');
            if (html) {
                const w = window.open('', '_blank');
                if (w) {
                    w.document.write(html);
                    w.document.close();
                } else {
                    toast.success(t('previewSuccess'));
                }
            } else {
                toast.success(t('previewSuccess'));
            }
        } catch {
            toast.error(t('error'));
        }
    }

    async function testSend() {
        if (!selected) return;
        try {
            const { res } = await sendJson(
                `/api/proxy/admin/email-templates/${encodeURIComponent(selected.name)}/test-send`,
                {
                    method: 'POST',
                    body: { to: 'test@example.com' }
                }
            );
            if (!res.ok) throw new Error(String(res.status));
            toast.success(t('testSendSuccess'));
        } catch {
            toast.error(t('error'));
        }
    }

    function getVariableList(tpl: Template): string[] {
        const vars = tpl.variables;
        if (!vars) return [];
        if (Array.isArray(vars)) return vars as string[];
        return Object.keys(vars as Record<string, unknown>);
    }

    if (loading) {
        return (
            <div className="flex flex-col gap-6">
                <Skeleton className="h-10 w-64 rounded-xl" />
                <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
                    <Skeleton className="h-64 rounded-xl" />
                    <Skeleton className="h-96 rounded-xl" />
                </div>
            </div>
        );
    }

    if (error) {
        return <EmptyState title={t('error')} actionLabel={tCommon('retry')} onAction={load} />;
    }

    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-bold">{t('title')}</h1>

            <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
                {/* Left: template list */}
                <Card>
                    <CardHeader>
                        <CardTitle>{t('templates')}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1 p-2">
                        {templates.length === 0 ? (
                            <EmptyState title={t('noTemplates')} />
                        ) : (
                            templates.map((tpl, i) => (
                                <button
                                    key={`${tpl.id ?? i}`}
                                    type="button"
                                    onClick={() => selectTemplate(tpl)}
                                    className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                                        selected?.name === tpl.name ? 'bg-accent font-medium' : ''
                                    }`}
                                >
                                    <span className="truncate">{tpl.name}</span>
                                    <Badge variant="info">{tpl.locale}</Badge>
                                </button>
                            ))
                        )}
                    </CardContent>
                </Card>

                {/* Right: editor panel */}
                {selected ? (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>{selected.name}</span>
                                <Badge variant="neutral">{selected.locale}</Badge>
                                <Badge variant="default">v{selected.version}</Badge>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium">{t('subject')}</label>
                                <Input
                                    value={editingSubject}
                                    onChange={(e) => setEditingSubject(e.target.value)}
                                    placeholder={t('subject')}
                                />
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium">{t('htmlBody')}</label>
                                <textarea
                                    value={editingHtml}
                                    onChange={(e) => setEditingHtml(e.target.value)}
                                    rows={15}
                                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                />
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium">{t('textBody')}</label>
                                <textarea
                                    value={editingText}
                                    onChange={(e) => setEditingText(e.target.value)}
                                    rows={5}
                                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                />
                            </div>

                            {getVariableList(selected).length > 0 && (
                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium">{t('variables')}</label>
                                    <div className="flex flex-wrap gap-2">
                                        {getVariableList(selected).map((v) => (
                                            <Badge key={v} variant="coral">
                                                {v}
                                            </Badge>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {selected.updated_at && (
                                <p className="text-xs text-muted-foreground">
                                    {t('updatedAt')}: {new Date(selected.updated_at).toLocaleString()}
                                </p>
                            )}

                            <div className="flex flex-wrap gap-2">
                                <Button onClick={save} disabled={saving}>
                                    {saving ? t('saving') : t('save')}
                                </Button>
                                <Button variant="secondary" onClick={preview}>
                                    {t('preview')}
                                </Button>
                                <Button variant="ghost" onClick={testSend}>
                                    {t('testSend')}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <EmptyState title={t('selectTemplate')} description={t('selectTemplateDescription')} />
                )}
            </div>
        </div>
    );
}
