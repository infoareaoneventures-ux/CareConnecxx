// Service Worker for PWA offline support
//
// Caching strategy (2026-07-08 rewrite — DO NOT revert to cache-first for HTML):
// the old version served '/' and '/index.html' cache-first under a never-bumped
// cache name, so after every hosting deploy users kept getting a stale app shell
// pointing at purged hashed chunks. The SPA rewrite then served index.html for
// the missing chunk → Safari's "Importing a module script failed." on lazy
// routes like /bgcheck.
//   - Navigations / HTML: network-first (cache only as offline fallback)
//   - /assets/ (content-hashed, immutable): cache-first
//   - Everything else same-origin: network-first with cache fallback
// The name bump to evia-v4 makes the activate handler purge the poisoned
// careconnex-v3 cache on every existing installation.
const CACHE_NAME = 'evia-v4';
const urlsToCache = [
    '/offline.html',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png'
];

// Install event - cache essential files
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

const cacheResponse = (request, response) => {
    if (!response || response.status !== 200 || response.type !== 'basic') return;
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
};

self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Skip Firebase and external API requests
    if (
        event.request.url.includes('firebaseio.com') ||
        event.request.url.includes('googleapis.com') ||
        event.request.url.includes('stripe.com')
    ) {
        return;
    }

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    const isNavigation =
        event.request.mode === 'navigate' ||
        (event.request.headers.get('accept') || '').includes('text/html');

    // HTML / navigations: network-first so a new deploy is picked up immediately.
    if (isNavigation) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    cacheResponse(event.request, response);
                    return response;
                })
                .catch(() =>
                    caches.match(event.request).then(
                        (cached) => cached || caches.match('/offline.html')
                    )
                )
        );
        return;
    }

    // Content-hashed build assets: immutable, cache-first is safe.
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    cacheResponse(event.request, response);
                    return response;
                });
            })
        );
        return;
    }

    // Everything else (icons, manifest, images): network-first, cache fallback.
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                cacheResponse(event.request, response);
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// Background sync for offline actions
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-appointments') {
        event.waitUntil(syncAppointments());
    }
});

async function syncAppointments() {
    // Sync offline appointments when back online
    console.log('Syncing appointments...');
    // Implementation would go here
}

// Push notifications
self.addEventListener('push', (event) => {
    const options = {
        body: event.data ? event.data.text() : 'New notification',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        vibrate: [200, 100, 200],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            {
                action: 'view',
                title: 'View',
                icon: '/icon-view.png'
            },
            {
                action: 'close',
                title: 'Close',
                icon: '/icon-close.png'
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification('Evia', options)
    );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'view') {
        event.waitUntil(
            clients.openWindow('/')
        );
    }
});
