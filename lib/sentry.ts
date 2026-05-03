import * as Sentry from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN;

export function initSentry() {
  if (!DSN) return;
  if (import.meta.env.MODE !== 'production') return;

  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_VERSION,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    beforeSend(event) {
      const url = event.request?.url;
      if (url && /[?&](secret|token|apikey|api_key)=/.test(url)) {
        if (event.request) event.request.url = url.replace(/([?&](?:secret|token|apikey|api_key)=)[^&]*/g, '$1[REDACTED]');
      }
      return event;
    },
  });
}

export function setSentryUser(user: { uid: string; email?: string | null } | null) {
  if (!DSN) return;
  if (user) {
    Sentry.setUser({ id: user.uid, email: user.email || undefined });
  } else {
    Sentry.setUser(null);
  }
}

export { Sentry };
