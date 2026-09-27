// Shared i18n constants — safe to import from client components.
// (i18n/request.ts is server-only because it reads next/headers cookies.)
export const locales = ['es-MX', 'en'] as const;
export type Locale = (typeof locales)[number];
// ES-MX is the product default (Mexican Spanish); EN is the fallback locale.
export const defaultLocale: Locale = 'es-MX';
export const localeCookieName = 'locale';
