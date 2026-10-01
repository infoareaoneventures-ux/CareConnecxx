import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { preloadCriticalResources, reportWebVitals } from './utils/performance';
import { initSentry } from './lib/sentry';
import { installChunkRecovery } from './utils/chunkRecovery';

initSentry();

// A tab opened before the latest deploy reloads itself the moment one of its
// stale lazy-route chunks fails to load (instead of showing the error card).
installChunkRecovery();

// Preload critical resources before React renders
preloadCriticalResources();

// Report Core Web Vitals in production
if (import.meta.env.PROD) {
  reportWebVitals();
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);