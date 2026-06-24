// Test-only stub for the `openai` package. The real SDK lives in
// functions/node_modules and is ESM-with-exports-map, which Vitest (run from the
// repo root) cannot resolve. Backend tests that pull a module which transitively
// imports `openai` (e.g. utils/openaiClient via onboardingConversation) fully
// mock that wrapper with vi.mock, so the real client class is never used — this
// stub exists only to satisfy Vite's static import-graph transform.
export default class OpenAI {
  constructor(..._args: unknown[]) { /* no-op */ }
  chat = { completions: { create: async () => ({ choices: [] }) } };
}
