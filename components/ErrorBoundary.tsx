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
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
        Sentry.captureException(error, {
            contexts: { react: { componentStack: errorInfo.componentStack } },
        });
    }

    private handleReload = () => {
        window.location.reload();
    };

    public render() {
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
