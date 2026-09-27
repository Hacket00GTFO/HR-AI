import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Vacancy } from './schemas';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/** Format a salary range honoring the vacancy's own currency (not always $). */
export function formatSalary(
    range: { min: number | null; max: number | null; currency: string | null } | null | undefined,
    locale: string
): string | null {
    if (!range || (range.min == null && range.max == null)) return null;
    const currency = range.currency || 'USD';
    const fmt = (n: number) =>
        new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
    if (range.min != null && range.max != null) return `${fmt(range.min)} – ${fmt(range.max)}`;
    if (range.min != null) return `${fmt(range.min)}+`;
    return fmt(range.max as number);
}

export function formatDate(iso: string | null | undefined, locale: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function formatRelativeDate(iso: string, locale: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffDays = Math.round((Date.now() - d.getTime()) / 86_400_000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (Math.abs(diffDays) < 1) return rtf.format(0, 'day');
    if (Math.abs(diffDays) < 30) return rtf.format(-diffDays, 'day');
    return formatDate(iso, locale);
}

export function vacancyId(v: Vacancy): string {
    return String(v.id ?? v._id ?? '');
}
