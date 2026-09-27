import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __dirname = dirname(fileURLToPath(import.meta.url));

const compat = new FlatCompat({ baseDirectory: __dirname });

// next/core-web-vitals bundles eslint-plugin-jsx-a11y — a11y rules are on.
const eslintConfig = [
    {
        ignores: [
            '**/node_modules/**',
            '**/.next/**',
            '**/out/**',
            '**/coverage/**',
            'next-env.d.ts',
            '**/*.config.{ts,mjs,js}',
            'vitest.setup.ts'
        ]
    },
    ...compat.extends('next/core-web-vitals', 'next/typescript')
];

export default eslintConfig;
