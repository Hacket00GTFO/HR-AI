// Shared ESLint 9 flat config for StraforAI.
// CJS services (Express monolith, node-common) lint as CommonJS; browser
// assets under public/ get browser globals; test files get ESM + vitest.
import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/coverage/**',
            '**/.turbo/**',
            '**/secure_uploads/**',
            '**/public/assets/**',
            '**/public/landing/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.{js,cjs}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        }
    },
    {
        // ESM .js files (packages with "type": "module", e.g. eslint-config itself).
        files: ['packages/eslint-config/**/*.js'],
        languageOptions: {
            sourceType: 'module'
        }
    },
    {
        // Static browser assets (apps/api/public/js, landing pages).
        files: ['**/public/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: {
                ...globals.browser
            }
        }
    },
    {
        // Static data tables — duplicate country keys are intentional
        // (later entries win; harmless lookup fallback data).
        files: ['**/data/countries.js'],
        rules: {
            'no-dupe-keys': 'off'
        }
    },
    {
        // Vitest suites use ESM import syntax regardless of package type.
        files: ['**/*.test.{js,mjs,cjs}', '**/tests/**/*.{js,mjs,cjs}'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        }
    }
];
