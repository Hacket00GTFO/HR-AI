'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Laptop, Package, SearchX } from 'lucide-react';
import { fetchJson } from '@/lib/http';
import { formatDate } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { assetListResponseSchema, type Asset } from './schemas';
import { assetSince, assetTag, assetType, normalizeAssets } from './lib';

// Activos — my assigned assets (laptop, phone, keys…).
// NOTE: GET /v1/assets is not deployed yet upstream (no gateway route →
// monolith 404). Built against the documented contract { assets: [...] }.
export function AssetsClient() {
    const t = useTranslations('portal.assets');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [assets, setAssets] = React.useState<Asset[]>([]);
    const [state, setState] = React.useState<'loading' | 'error' | 'done'>('loading');

    const load = React.useCallback(async () => {
        setState('loading');
        try {
            const data = await fetchJson('/api/proxy/assets', assetListResponseSchema);
            setAssets(normalizeAssets(data));
            setState('done');
        } catch {
            setState('error');
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    return (
        <div className="flex flex-col gap-6">
            <header>
                <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
            </header>

            {state === 'loading' ? (
                <div aria-busy="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-24 rounded-xl" />
                    ))}
                </div>
            ) : state === 'error' ? (
                <EmptyState icon={<SearchX />} title={t('error')} actionLabel={tCommon('retry')} onAction={load} />
            ) : assets.length === 0 ? (
                <EmptyState icon={<Package />} title={t('empty')} />
            ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {assets.map((a) => (
                        <li key={String(a.id)} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                            <div className="flex items-start gap-3">
                                <span className="rounded-lg bg-muted p-2 text-muted-foreground">
                                    <Laptop className="size-5" aria-hidden="true" />
                                </span>
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold">{a.name || assetTag(a)}</p>
                                    <dl className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                                        <div className="flex gap-1.5">
                                            <dt className="font-medium">{t('tag')}:</dt>
                                            <dd>{assetTag(a)}</dd>
                                        </div>
                                        {assetType(a) && (
                                            <div className="flex gap-1.5">
                                                <dt className="font-medium">{t('type')}:</dt>
                                                <dd>{assetType(a)}</dd>
                                            </div>
                                        )}
                                        {assetSince(a) && (
                                            <div className="flex gap-1.5">
                                                <dt className="font-medium">{t('since')}:</dt>
                                                <dd>{formatDate(assetSince(a), locale)}</dd>
                                            </div>
                                        )}
                                        {a.condition && (
                                            <div className="flex gap-1.5">
                                                <dt className="font-medium">{t('condition')}:</dt>
                                                <dd>{a.condition}</dd>
                                            </div>
                                        )}
                                    </dl>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
