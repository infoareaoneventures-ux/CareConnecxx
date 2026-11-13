// ESLint (flat config) for the site and the Cloud Functions (2026-11-11, fix plan Wave 4).
//
// Introduced on a large existing codebase, so it is a RATCHET: the rules that catch real bugs (hooks used wrongly,
// unreachable/duplicate code, empty blocks that swallow errors in new code…) are errors; the style-heavy and
// noisy ones are warnings that are fixed area by area. CI fails only on errors, so a new bug cannot slip in while the
// warnings are paid down. Tighten a rule here once its warnings reach zero.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'functions/node_modules/**', 'functions/lib/**', 'coverage/**', 'public/**',
      'third_party/**', 'scripts/**', 'functions/scripts/**', 'e2e/**', 'tests/e2e/**', '**/*.config.{js,cjs,mjs,ts}', 'functions/src/evals/**/*.json',
      '.claude/**', 'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.es2022 } },
    rules: {
      // TypeScript already reports undefined names (and knows the DOM/node globals) — the core rule only adds noise here.
      'no-undef': 'off',
      // Real bugs → errors.
      'react-hooks/rules-of-hooks': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'no-async-promise-executor': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-binary-expression': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // Paid down area by area → warnings (CI does not fail on these yet).
      'react-hooks/exhaustive-deps': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'prefer-spread': 'warn',
      'no-regex-spaces': 'warn',
      'no-useless-catch': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-case-declarations': 'warn',
      'no-control-regex': 'warn',
      'no-misleading-character-class': 'warn',
      'prefer-const': 'warn',
    },
  },
  {
    // Tests may be loose.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**', 'tests/**'],
    rules: { 'no-empty': 'off', '@typescript-eslint/no-unused-vars': 'off', '@typescript-eslint/no-unused-expressions': 'off', 'no-constant-binary-expression': 'off' },
  },
  prettier,
);
