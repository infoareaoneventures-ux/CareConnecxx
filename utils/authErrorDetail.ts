import { Sentry } from '../lib/sentry';

// Phone sign-in / signup failures the pages don't map to a friendly line used to show a
// bare "Something went wrong" with the real cause invisible to everyone (live, 2026-11-05:
// both sign-in and signup failed on the founder's phone and nothing recorded why).
// Report the error and return its code so the page can append it to the generic line.
export function reportAuthError(where: string, err: unknown): string {
  const anyErr = err as { code?: unknown; message?: unknown } | null;
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  try { console.error(`[auth] ${where}`, code || anyErr?.message || err); } catch { /* noop */ }
  try {
    const error = err instanceof Error ? err : new Error(String(anyErr?.message ?? err));
    Sentry.captureException(error, { tags: { where, authCode: code || 'none' } });
  } catch { /* Sentry not configured */ }
  return code;
}

/** "Something went wrong. (auth/session-expired)" — the suffix only when a code exists. */
export function withAuthCode(message: string, code: string): string {
  return code ? `${message} (${code})` : message;
}
