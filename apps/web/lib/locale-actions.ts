'use server';

import { cookies } from 'next/headers';
import { defaultLocale, localeCookieName, locales, type Locale } from '@/i18n/config';

// Cookie-based locale switching — writes the `locale` cookie; the next
// request's getRequestConfig picks it up (i18n/request.ts).
export async function setLocale(locale: string) {
    const next: Locale = (locales as readonly string[]).includes(locale) ? (locale as Locale) : defaultLocale;
    const store = await cookies();
    store.set(localeCookieName, next, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
}
