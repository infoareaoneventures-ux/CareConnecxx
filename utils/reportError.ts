// ONE way for the site to handle a failure it cannot recover from (2026-11-11, fix plan Wave 4: "errors are often silently
// ignored" — over a hundred places did `.catch(() => {})` or an empty `catch {}`, so a failed money or account action left
// no trace anywhere and Sentry heard about a small fraction of problems).
//
//   • reportError(e, { where })            — report to Sentry (and the console in development); the person sees nothing.
//   • reportError(e, { where, toast })     — the same, and also tell the person (a plain sentence — never the raw error).
//   • .catch(swallow('Payments: load'))    — for a failure that really is best-effort: still reported, never shown.
//
// Expected, harmless failures are not reported (a request cancelled by navigation, permission errors while signing out).
// The same failure from the same place is reported at most once a minute so a failing listener cannot flood Sentry.
import { Sentry } from '../lib/sentry';
import { safeErrorMessage } from './safeErrorMessage';

type ToastFn = (message: string, type: 'success' | 'error' | 'info') => void;

let toastSink: ToastFn | null = null;
/** The app registers its toast function once (the CareConnex provider), so any module can tell the person without a hook. */
export function registerErrorToast(fn: ToastFn | null): void { toastSink = fn; }

const BENIGN: RegExp[] = [/AbortError/i, /\babort(ed)?\b/i, /cancell?ed/i, /ResizeObserver loop/i];
const lastSent = new Map<string, number>();
const REPEAT_MS = 60_000;

export function isBenignError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : typeof error === 'string' ? error : '';
  return BENIGN.some((re) => re.test(msg));
}

export interface ReportOptions {
  /** Where it happened, e.g. "Payments: load history". Shown in Sentry; keep it short and free of personal data. */
  where: string;
  /** If set, the person is also told, in this sentence (the raw error is never shown). */
  toast?: string;
}

export function reportError(error: unknown, opts: ReportOptions, now: number = Date.now()): void {
  if (!isBenignError(error)) {
    const key = `${opts.where}|${error instanceof Error ? error.message : String(error)}`;
    const last = lastSent.get(key);
    if (last === undefined || now - last >= REPEAT_MS) {
      lastSent.set(key, now);
      try { Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { where: opts.where } }); } catch { /* reporting must never throw */ }
      if (import.meta.env?.MODE !== 'production') console.error(`[${opts.where}]`, error);
    }
  }
  if (opts.toast && toastSink) toastSink(opts.toast, 'error');
}

/** For a promise's `.catch`: a best-effort step that must not bother the person but must not vanish either. */
export function swallow(where: string): (error: unknown) => void {
  return (error) => reportError(error, { where });
}

/** A sentence for the person: the error's own words when they were written for people, else the fallback. */
export function userMessage(error: unknown, fallback: string): string {
  return safeErrorMessage(error, fallback);
}

/** For tests only. */
export function __resetReportedErrors(): void { lastSent.clear(); }
