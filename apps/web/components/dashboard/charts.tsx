'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { DepartmentStat, TrendPoint } from '@/lib/schemas';

// Lightweight dependency-free SVG charts. Decorative SVG + sr-only data table
// keeps them accessible without a charting library.

export function TrendsChart({ data }: { data: TrendPoint[] }) {
    const t = useTranslations('dashboard.trends');
    const locale = useLocale();
    if (data.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;

    const W = 600;
    const H = 180;
    const PAD = 24;
    const max = Math.max(1, ...data.map((d) => Math.max(d.applications, d.interviews)));
    const x = (i: number) => PAD + (i / Math.max(1, data.length - 1)) * (W - PAD * 2);
    const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
    const line = (key: 'applications' | 'interviews') =>
        data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');

    return (
        <div>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="h-44 w-full"
                role="img"
                aria-label={t('title')}
                preserveAspectRatio="none"
            >
                <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-border" strokeWidth="1" />
                <path d={line('applications')} fill="none" className="stroke-coral-600" strokeWidth="2.5" />
                <path
                    d={line('interviews')}
                    fill="none"
                    className="stroke-info-500"
                    strokeWidth="2"
                    strokeDasharray="5 4"
                />
            </svg>
            <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 bg-coral-600" aria-hidden="true" />
                    {t('applications')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-4 bg-info-500" aria-hidden="true" />
                    {t('interviews')}
                </span>
            </div>
            <table className="sr-only">
                <caption>{t('title')}</caption>
                <thead>
                    <tr>
                        <th scope="col">Date</th>
                        <th scope="col">{t('applications')}</th>
                        <th scope="col">{t('interviews')}</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((d) => (
                        <tr key={d.date}>
                            <td>{new Intl.DateTimeFormat(locale).format(new Date(d.date))}</td>
                            <td>{d.applications}</td>
                            <td>{d.interviews}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function DepartmentChart({ data }: { data: DepartmentStat[] }) {
    const t = useTranslations('dashboard.departments');
    const rows = data.filter((d) => d.name);
    if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
    const max = Math.max(1, ...rows.map((d) => d.value));

    return (
        <ul className="flex flex-col gap-3" aria-label={t('title')}>
            {rows.map((d) => (
                <li key={d.name} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-sm text-muted-foreground">{d.name}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded-md bg-muted">
                        <div
                            className="h-full rounded-md bg-navy-800 dark:bg-coral-500"
                            style={{ width: `${(d.value / max) * 100}%` }}
                            role="img"
                            aria-label={`${d.name}: ${d.value}`}
                        />
                    </div>
                    <span className="w-8 text-right text-sm font-medium tabular-nums">{d.value}</span>
                </li>
            ))}
        </ul>
    );
}
