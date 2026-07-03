import React, { useEffect, useState } from 'react';

// PWA Install Prompt Component
export const PWAInstallPrompt: React.FC = () => {
    const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
    const [showPrompt, setShowPrompt] = useState(false);

    useEffect(() => {
        const handler = (e: Event) => {
            // Prevent the mini-infobar from appearing
            e.preventDefault();
            // Save the event for later
            setDeferredPrompt(e);
            // Show custom install prompt
            setShowPrompt(true);
        };

        window.addEventListener('beforeinstallprompt', handler);

        return () => window.removeEventListener('beforeinstallprompt', handler);
    }, []);

    const handleInstall = async () => {
        if (!deferredPrompt) return;

        // Show the install prompt
        deferredPrompt.prompt();

        // Wait for the user's response
        const { outcome } = await deferredPrompt.userChoice;

        console.log(`User response: ${outcome}`);

        // Clear the prompt
        setDeferredPrompt(null);
        setShowPrompt(false);
    };

    const handleDismiss = () => {
        setShowPrompt(false);
        // Store dismissal in localStorage
        localStorage.setItem('pwa-prompt-dismissed', Date.now().toString());
    };

    // Don't show if dismissed recently (within 7 days)
    const dismissedAt = localStorage.getItem('pwa-prompt-dismissed');
    if (dismissedAt) {
        const daysSinceDismissal = (Date.now() - parseInt(dismissedAt)) / (1000 * 60 * 60 * 24);
        if (daysSinceDismissal < 7) {
            return null;
        }
    }

    if (!showPrompt) return null;

    return (
        <div className="fixed bottom-20 left-4 right-4 md:left-auto md:right-4 md:w-96 bg-white rounded-2xl shadow-2xl border border-slate-200 p-4 z-50 animate-slide-in">
            <div className="flex items-start space-x-3">
                <div className="bg-teal-100 p-2 rounded-xl flex-shrink-0">
                    <svg className="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                </div>
                <div className="flex-1">
                    <h3 className="font-bold text-slate-900 mb-1">Install Evia</h3>
                    <p className="text-sm text-slate-600 mb-3">
                        Add to your home screen for quick access and offline support
                    </p>
                    <div className="flex space-x-2">
                        <button
                            onClick={handleInstall}
                            className="flex-1 bg-teal-600 text-white px-4 py-2 rounded-lg font-semibold hover:bg-teal-700 transition-colors"
                        >
                            Install
                        </button>
                        <button
                            onClick={handleDismiss}
                            className="px-4 py-2 text-slate-600 hover:text-slate-800 font-medium"
                        >
                            Not now
                        </button>
                    </div>
                </div>
                <button
                    onClick={handleDismiss}
                    className="text-slate-400 hover:text-slate-600"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </div>
    );
};

// Register service worker
export const registerServiceWorker = () => {
    if (!('serviceWorker' in navigator)) return;

    // In development, unregister any cached SW so stale assets don't flash
    if (import.meta.env.DEV) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
            registrations.forEach(r => r.unregister());
        });
        return;
    }

    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/sw.js')
            .then((registration) => {
                console.log('SW registered:', registration);
            })
            .catch((error) => {
                console.log('SW registration failed:', error);
            });

        navigator.serviceWorker
            .register('/firebase-messaging-sw.js')
            .then((registration) => {
                console.log('Firebase Messaging SW registered:', registration);
            })
            .catch((error) => {
                console.log('Firebase Messaging SW registration failed:', error);
            });
    });
};

// Request notification permission
export const requestNotificationPermission = async () => {
    if ('Notification' in window && 'serviceWorker' in navigator) {
        const permission = await Notification.requestPermission();

        if (permission === 'granted') {
            console.log('Notification permission granted');

            // Subscribe to push notifications
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(
                    process.env.VITE_VAPID_PUBLIC_KEY || ''
                )
            });

            // Send subscription to server
            console.log('Push subscription:', subscription);
            return subscription;
        }
    }
    return null;
};

// Helper function for VAPID key
function urlBase64ToUint8Array(base64String: string) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}
