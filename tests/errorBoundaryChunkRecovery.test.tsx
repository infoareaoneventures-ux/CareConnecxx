/**
 * ErrorBoundary chunk-load self-recovery.
 *
 * A stale SW-cached app shell referencing purged hashed chunks surfaces as
 * "Importing a module script failed." (Safari) when a lazy route loads. The
 * boundary must clear SW caches/registrations and reload once — and must NOT
 * loop if the reload doesn't fix it, nor trigger on ordinary render errors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const Thrower = ({ message }: { message: string }) => {
    throw new Error(message);
};

const CHUNK_MSG = 'Importing a module script failed.';

let reloadSpy: ReturnType<typeof vi.fn>;
let cachesDelete: ReturnType<typeof vi.fn>;
let swUnregister: ReturnType<typeof vi.fn>;

beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadSpy },
        writable: true,
        configurable: true,
    });

    cachesDelete = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'caches', {
        value: { keys: vi.fn().mockResolvedValue(['evia-v4']), delete: cachesDelete },
        writable: true,
        configurable: true,
    });

    swUnregister = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window.navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister: swUnregister }]) },
        writable: true,
        configurable: true,
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ErrorBoundary chunk recovery', () => {
    it('clears caches, unregisters SWs, and reloads on a chunk-load error', async () => {
        render(
            <ErrorBoundary>
                <Thrower message={CHUNK_MSG} />
            </ErrorBoundary>
        );

        expect(screen.getByText(/updating to the latest version/i)).toBeTruthy();
        await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
        expect(cachesDelete).toHaveBeenCalledWith('evia-v4');
        expect(swUnregister).toHaveBeenCalled();
        expect(sessionStorage.getItem('evia_chunk_recovery_attempted')).toBe('1');
    });

    it('recovers on Chrome/Firefox dynamic-import failure messages too', async () => {
        render(
            <ErrorBoundary>
                <Thrower message="Failed to fetch dynamically imported module: https://x/assets/a.js" />
            </ErrorBoundary>
        );
        await waitFor(() => expect(reloadSpy).toHaveBeenCalled());
    });

    it('does not reload twice — falls back to the error card after one attempt', async () => {
        sessionStorage.setItem('evia_chunk_recovery_attempted', '1');
        render(
            <ErrorBoundary>
                <Thrower message={CHUNK_MSG} />
            </ErrorBoundary>
        );

        await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeTruthy());
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('shows the normal error card for non-chunk errors without reloading', () => {
        render(
            <ErrorBoundary>
                <Thrower message="Cannot read properties of undefined" />
            </ErrorBoundary>
        );

        expect(screen.getByText(/something went wrong/i)).toBeTruthy();
        expect(reloadSpy).not.toHaveBeenCalled();
    });
});
