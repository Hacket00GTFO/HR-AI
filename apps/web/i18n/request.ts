import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, localeCookieName, locales, type Locale } from './config';

export { defaultLocale, localeCookieName, locales };
export type { Locale };

// Cookie-based i18n (no [locale] segment): the locale lives in the `locale`
// cookie, written by the locale switcher via a server action. Accept-Language
// could be consulted as a first-visit default — kept simple: default 'es-MX'.
export default getRequestConfig(async () => {
    const store = await cookies();
    const raw = store.get(localeCookieName)?.value;
    const locale: Locale = (locales as readonly string[]).includes(raw ?? '') ? (raw as Locale) : defaultLocale;
    return {
        locale,
        messages: (await import(`../messages/${locale}.json`)).default
    };
});
