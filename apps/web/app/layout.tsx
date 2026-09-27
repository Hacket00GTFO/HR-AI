import type { Metadata, Viewport } from 'next';
import { Inter, Poppins } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const poppins = Poppins({
    subsets: ['latin'],
    weight: ['500', '600', '700'],
    variable: '--font-poppins',
    display: 'swap'
});

export const metadata: Metadata = {
    title: { default: 'StraforAI', template: '%s · StraforAI' },
    description: 'StraforAI — unified hiring intelligence platform',
    applicationName: 'StraforAI',
    appleWebApp: { capable: true, title: 'StraforAI', statusBarStyle: 'default' },
    // /manifest.webmanifest is emitted by app/manifest.ts.
    icons: { icon: '/favicon.svg', apple: '/icons/apple-touch-icon.png' }
};

// PWA: theme color tracks the active color scheme (bg tokens in globals.css).
export const viewport: Viewport = {
    themeColor: [
        { media: '(prefers-color-scheme: light)', color: '#f5f7fa' },
        { media: '(prefers-color-scheme: dark)', color: '#1a2530' }
    ]
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const locale = await getLocale();
    const messages = await getMessages();
    return (
        // suppressHydrationWarning: next-themes flips .dark on <html> before paint.
        <html lang={locale} className={`${inter.variable} ${poppins.variable}`} suppressHydrationWarning>
            <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
                {/* next-themes injects its own blocking inline script that sets
                    the .dark class before first paint — no theme FOUC. */}
                <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
                    <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
                </ThemeProvider>
                <Toaster richColors position="top-right" />
            </body>
        </html>
    );
}
