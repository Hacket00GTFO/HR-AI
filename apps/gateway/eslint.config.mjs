import strafor from '@strafor/eslint-config';
import tseslint from 'typescript-eslint';

export default [
    ...strafor,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
        }
    }
];
