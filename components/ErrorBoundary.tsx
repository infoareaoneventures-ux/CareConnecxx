import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from './ui/Button';
import { Sentry } from '../lib/sentry';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    recovering: boolean;
}

// Lazy-route chunk fetches fail with these messages when a cached app shell
// references hashed assets purged by a newer deploy (the SPA rewrite returns
// index.html for the missing chunk, so Safari says "Importing a module script
// failed" instead of 404).
const isChunkLoadError = (error: Error | null): boolean => {
    const msg = error?.message ?? '';
    return (
        /Importing a module script failed/i.test(msg) ||
        /Failed to fetch dynamically imported module/i.test(msg) ||
        /error loading dynamically imported module/i.test(msg) ||
        /ChunkLoadError/i.test(msg) ||
        error?.name === 'ChunkLoadError'
    );
};

const RECOVERY_FLAG = 'evia_chunk_recovery_attempted';

// Drop every SW cache + registration so the reload fetches the current deploy,
// then reload. Guarded to one attempt per tab session so a genuinely broken
// deploy can't cause a reload loop.
const attemptChunkRecovery = async (): Promise<boolean> => {
    try {
        if (sessionStorage.getItem(RECOVERY_FLAG)) return false;
        sessionStorage.setItem(RECOVERY_FLAG, '1');
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

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
        recovering: false,
    };

    public static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
        Sentry.captureException(error, {
            contexts: { react: { componentStack: errorInfo.componentStack } },
        });
        if (isChunkLoadError(error)) {
            this.setState({ recovering: true });
            attemptChunkRecovery().then((reloading) => {
                if (!reloading) this.setState({ recovering: false });
            });
        }
    }

    private handleReload = () => {
        window.location.reload();
    };

    public render() {
        if (this.state.recovering) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                    <div className="text-center">
                        <RefreshCw className="w-8 h-8 text-slate-400 animate-spin mx-auto mb-4" />
                        <p className="text-slate-500">Updating to the latest version…</p>
                    </div>
                </div>
            );
        }

        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                    <div className="bg-white rounded-3xl shadow-xl p-8 max-w-md w-full text-center border border-slate-200">
                        <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
                            <AlertCircle size={32} />
                        </div>

                        <h1 className="text-2xl font-bold text-slate-900 mb-2">Something went wrong</h1>
                        <p className="text-slate-500 mb-6">
                            We encountered an unexpected error. Our team has been notified.
                        </p>

                        <div className="bg-slate-100 rounded-xl p-4 mb-6 text-left overflow-auto max-h-40">
                            <code className="text-xs text-slate-700 font-mono">
                                {this.state.error?.message || 'Unknown error occurred'}
                            </code>
                        </div>

                        <Button fullWidth onClick={this.handleReload} variant="primary">
                            <RefreshCw className="w-4 h-4 mr-2" /> Reload Application
                        </Button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
