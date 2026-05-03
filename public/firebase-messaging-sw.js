/// <reference lib="webworker" />

/**
 * Firebase Cloud Messaging Service Worker
 * Handles push notifications when app is in background
 */

// Firebase configuration - hardcoded for service worker
const firebaseConfig = {
  apiKey: "AIzaSyACFOXqqz1Q0PK3_ROJr1lQNncFCoInwy4",
  authDomain: "careconnex-d4c8b.firebaseapp.com",
  projectId: "careconnex-d4c8b",
  storageBucket: "careconnex-d4c8b.firebasestorage.app",
  messagingSenderId: "1098628562416",
  appId: "1:1098628562416:web:49a0de9c3f25c80149cf54",
  measurementId: "G-BVHR08Q5X4"
};

// Import Firebase scripts
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Get messaging instance
const messaging = firebase.messaging();

/**
 * Handle background messages
 */
messaging.onBackgroundMessage((payload) => {
  console.log('[Service Worker] Received background message:', payload);

  const { notification, data } = payload;

  if (!notification) return;

  const notificationTitle = notification.title || 'CareConnex';
  const notificationOptions = {
    body: notification.body,
    icon: notification.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: data?.chatRoomId || 'default',
    requireInteraction: false,
    data: data,
    actions: [
      {
        action: 'open',
        title: 'Open'
      },
      {
        action: 'dismiss',
        title: 'Dismiss'
      }
    ]
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

/**
 * Handle notification click
 */
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification clicked:', event);

  event.notification.close();

  const clickAction = event.notification.data?.click_action || '/';
  const chatRoomId = event.notification.data?.chatRoomId;

  // Handle action buttons
  if (event.action === 'dismiss') {
    return;
  }

  // Open or focus window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          
          // Post message to client about the notification
          client.postMessage({
            type: 'NOTIFICATION_CLICK',
            chatRoomId: chatRoomId,
            clickAction: clickAction
          });
          
          return;
        }
      }

      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(clickAction);
      }
    })
  );
});

/**
 * Handle push event (for custom push payloads)
 */
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push received:', event);

  if (!event.data) return;

  try {
    const payload = event.data.json();
    const { title, body, icon, data } = payload;

    const options = {
      body: body || 'New notification from CareConnex',
      icon: icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: data?.tag || 'default',
      data: data,
      requireInteraction: false
    };

    event.waitUntil(
      self.registration.showNotification(title || 'CareConnex', options)
    );
  } catch (error) {
    console.error('[Service Worker] Error handling push:', error);
  }
});

/**
 * Handle service worker installation
 */
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  self.skipWaiting();
});

/**
 * Handle service worker activation
 */
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(clients.claim());
});

/**
 * Handle messages from main thread
 */
self.addEventListener('message', (event) => {
  console.log('[Service Worker] Message from main thread:', event.data);

  if (event.data?.type === 'GET_FCM_TOKEN') {
    // Handle FCM token request if needed
  }

  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title, options);
  }
});
