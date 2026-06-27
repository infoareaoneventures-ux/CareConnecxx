/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            // Backend-only npm packages live under functions/node_modules and are
            // not installed at the repo root where Vitest runs. Vite's static
            // import-graph transform must resolve every bare specifier in a
            // module's tree even when a test mocks the wrapper that uses it, so
            // these otherwise-unresolvable packages are aliased to no-op stubs.
            // Backend tests that need real behavior mock the package explicitly;
            // frontend code never imports any of these.
            openai: fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/openai.ts', import.meta.url)),
            'firebase-functions/v1': fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/firebaseFunctions.ts', import.meta.url)),
            'firebase-functions': fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/firebaseFunctions.ts', import.meta.url)),
            resend: fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/emptyModule.ts', import.meta.url)),
            '@getzep/zep-cloud': fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/emptyModule.ts', import.meta.url)),
            telegraf: fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/emptyModule.ts', import.meta.url)),
            '@anthropic-ai/sdk': fileURLToPath(new URL('./functions/src/agents/__tests__/__stubs__/emptyModule.ts', import.meta.url)),
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: [],
        exclude: ['**/node_modules/**', '**/e2e/**', '**/*.spec.ts', '.claude/**', '**/third_party/**', '**/functions/lib/**'],
    },
} as any);
