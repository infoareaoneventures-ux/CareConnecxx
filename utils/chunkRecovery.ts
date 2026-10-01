/**
 * Stale-deploy chunk recovery.
 *
 * A tab that loaded the app BEFORE a hosting deploy still holds the old
 * index.html, whose lazy routes point at content-hashed chunks the new deploy
 * purged. The first lazy navigation after the deploy then fails — Firebase's
 * SPA rewrite answers the missing chunk with index.html, so Chrome says
 * "Failed to fetch dynamically imported module" and Safari "Importing a module
 * script failed." The only fix is to reload so the tab picks up the new shell.
 *
 * Two entry points call `attemptChunkRecovery`:
 *   - Vite's `vite:preloadError` window event (index.tsx) — fires the moment a
 *     dynamic import's preload fails, before React even sees an error;
 *   - the ErrorBoundary, for the cases that still surface as a render error.
 *
 * Loop guard: ONE attempt per failing chunk per minute. The old guard was one
 * attempt per tab session, so a tab left open across two deploys in a day hit
 * the fatal "Something went wrong" card on the second one (founder, 2026-09-30).
 * A genuinely broken deploy still can't loop: the same chunk failing again
 * within the window falls through to the error card.
 */

export const RECOVERY_KEY = 'evia_chunk_recovery';
export const RECOVERY_WINDOW_MS = 60_000;

export const isChunkLoadError = (error: unknown): boolean => {
    const err = error as { message?: unknown; name?: unknown } | null | undefined;
    const msg = typeof err?.message === 'string' ? err.message : '';
    return (
        /Importing a module script failed/i.test(msg) ||
        /Failed to fetch dynamically imported module/i.test(msg) ||
        /error loading dynamically imported module/i.test(msg) ||
        /Loading chunk [\w-]+ failed/i.test(msg) ||
        /ChunkLoadError/i.test(msg) ||
        err?.name === 'ChunkLoadError'
    );
};

/** The failing chunk's URL when the message carries one, else the message itself. */
export const chunkKeyFromError = (error: unknown): string => {
    const err = error as { message?: unknown } | null | undefined;
    const msg = typeof err?.message === 'string' ? err.message : '';
    const url = msg.match(/https?:\/\/\S+/);
    return url ? url[0] : msg || 'unknown';
};

type Attempt = { key: string; at: number };

const readAttempt = (): Attempt | null => {
    try {
        const raw = sessionStorage.getItem(RECOVERY_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Attempt>;
        return typeof parsed.key === 'string' && typeof parsed.at === 'number' ? (parsed as Attempt) : null;
    } catch {
        return null;
    }
};

/**
 * Drop SW caches + registrations and reload so the tab fetches the current
 * deploy. Resolves `true` when a reload was issued, `false` when the guard
 * refused (same chunk already retried inside the window, or no storage).
 */
export const attemptChunkRecovery = async (error: unknown, now: number = Date.now()): Promise<boolean> => {
    const key = chunkKeyFromError(error);
    try {
        const last = readAttempt();
        if (last && last.key === key && now - last.at < RECOVERY_WINDOW_MS) return false;
        sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ key, at: now } satisfies Attempt));
    } catch {
        return false;
    }
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
        }
    } catch {
        // Even if cleanup partially fails, a reload is still the best next step.
    }
    window.location.reload();
    return true;
};

/**
 * Hook Vite's preload-error event so a stale chunk reloads the tab before the
 * failure reaches React. `preventDefault` stops Vite from rethrowing when we
 * are handling it; when the guard refuses we let it propagate so the
 * ErrorBoundary shows the card.
 */
export const installChunkRecovery = (): void => {
    if (typeof window === 'undefined') return;
    window.addEventListener('vite:preloadError', (event) => {
        const payload = (event as unknown as { payload?: unknown }).payload;
        const last = readAttempt();
        const key = chunkKeyFromError(payload);
        if (last && last.key === key && Date.now() - last.at < RECOVERY_WINDOW_MS) return;
        event.preventDefault();
        void attemptChunkRecovery(payload);
    });
};
