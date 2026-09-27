import type { MetadataRoute } from 'next';

// PWA manifest — served at /manifest.webmanifest by Next.js.
// Icons: a scalable SVG plus generated PNG fallbacks (see public/icons).
export default function manifest(): MetadataRoute.Manifest {
    return {
        name: 'StraforAI',
        short_name: 'StraforAI',
        description: 'StraforAI — unified hiring intelligence platform',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#1a2530',
        theme_color: '#d14438',
        lang: 'es-MX',
        icons: [
            { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
    };
}
