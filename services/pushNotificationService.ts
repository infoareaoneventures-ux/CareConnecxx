import { getMessaging, getToken, onMessage, deleteToken } from 'firebase/messaging';
import { doc, updateDoc, arrayUnion, arrayRemove, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';

/**
 * Push Notification Service
 * Handles Firebase Cloud Messaging (FCM) integration
 * 
 * Features:
 * - Request notification permission
 * - Register FCM tokens
 * - Handle foreground messages
 * - Handle background messages (service worker)
 * - Subscribe to topics
 * - Send test notifications
 */

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

class PushNotificationService {
  private messaging: any = null;
  private functions: any = null;
  private currentToken: string | null = null;
  private onMessageCallback: ((payload: any) => void) | null = null;

  constructor() {
    // Initialize messaging only in browser environment
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        this.messaging = getMessaging();
        this.functions = getFunctions();
      } catch (e) {
        console.warn('Push notifications unavailable:', e);
      }
    }
  }

  /**
   * Initialize push notifications
   * Call this when user logs in
   */
  async initialize(userId: string): Promise<boolean> {
    if (!this.messaging) {
      console.log('Push notifications not supported in this environment');
      return false;
    }

    try {
      // Check if permission is already granted
      const permission = await this.requestPermission();
      
      if (permission !== 'granted') {
        console.log('Notification permission not granted');
        return false;
      }

      // Get FCM token
      const token = await this.getFCMToken();
      
      if (!token) {
        console.error('Failed to get FCM token');
        return false;
      }

      // Save token to user document
      await this.saveTokenToUser(userId, token);
      
      // Set up foreground message handler
      this.setupForegroundHandler();
      
      console.log('Push notifications initialized successfully');
      return true;
      
    } catch (error) {
      console.error('Error initializing push notifications:', error);
      return false;
    }
  }

  /**
   * Request notification permission from user
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) {
      console.log('This browser does not support notifications');
      return 'denied';
    }

    // Check current permission
    if (Notification.permission === 'granted') {
      return 'granted';
    }

    if (Notification.permission === 'denied') {
      console.log('Notification permission was previously denied');
      return 'denied';
    }

    // Request permission
    try {
      const permission = await Notification.requestPermission();
      console.log('Notification permission:', permission);
      return permission;
    } catch (error) {
      console.error('Error requesting notification permission:', error);
      return 'denied';
    }
  }

  /**
   * Get FCM token
   */
  private async getFCMToken(): Promise<string | null> {
    if (!this.messaging) return null;

    try {
      // Get token with VAPID key
      const token = await getToken(this.messaging, {
        vapidKey: VAPID_KEY
      });

      if (token) {
        this.currentToken = token;
        console.log('FCM Token obtained');
        return token;
      } else {
        console.log('No registration token available');
        return null;
      }
    } catch (error) {
      console.error('Error getting FCM token:', error);
      return null;
    }
  }

  /**
   * Save FCM token to user's Firestore document
   */
  private async saveTokenToUser(userId: string, token: string): Promise<void> {
    try {
      const userRef = doc(db, 'users', userId);
      
      // Get current tokens
      const userDoc = await getDoc(userRef);
      const currentTokens = userDoc.data()?.fcmTokens || [];
      
      // Only add if not already present
      if (!currentTokens.includes(token)) {
        await updateDoc(userRef, {
          fcmTokens: arrayUnion(token)
        });
        console.log('FCM token saved to user document');
      }
    } catch (error) {
      console.error('Error saving FCM token:', error);
    }
  }

  /**
   * Remove FCM token from user's document (on logout)
   */
  async removeToken(userId: string): Promise<void> {
    if (!this.currentToken) return;

    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, {
        fcmTokens: arrayRemove(this.currentToken)
      });
      
      // Also delete from FCM
      if (this.messaging) {
        await deleteToken(this.messaging);
      }
      
      this.currentToken = null;
      console.log('FCM token removed');
    } catch (error) {
      console.error('Error removing FCM token:', error);
    }
  }

  /**
   * Set up handler for foreground messages
   */
  private setupForegroundHandler(): void {
    if (!this.messaging) return;

    onMessage(this.messaging, (payload) => {
      console.log('Message received in foreground:', payload);
      
      // Show notification even in foreground
      this.showLocalNotification(payload);
      
      // Call custom callback if set
      if (this.onMessageCallback) {
        this.onMessageCallback(payload);
      }
    });
  }

  /**
   * Show local notification (for foreground messages)
   */
  private showLocalNotification(payload: any): void {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const { notification, data } = payload;
    
    if (!notification) return;

    const options: NotificationOptions = {
      body: notification.body,
      icon: notification.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: data?.chatRoomId || 'default',
      requireInteraction: false,
      data: data
    };

    // Play sound (optional)
    this.playNotificationSound();

    // Show notification
    const notif = new Notification(notification.title, options);

    // Handle click
    notif.onclick = () => {
      window.focus();
      notif.close();
      
      // Navigate to appropriate page
      if (data?.click_action) {
        window.location.href = data.click_action;
      }
    };
  }

  /**
   * Play notification sound
   */
  private playNotificationSound(): void {
    try {
      const audio = new Audio('/notification-sound.mp3');
      audio.volume = 0.5;
      audio.play().catch(() => {
        // Audio play failed (user interaction required)
      });
    } catch (error) {
      // Audio not supported
    }
  }

  /**
   * Set callback for message handling
   */
  onMessage(callback: (payload: any) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Subscribe to a topic
   */
  async subscribeToTopic(topic: string): Promise<boolean> {
    if (!this.currentToken) {
      console.error('No FCM token available');
      return false;
    }

    try {
      const subscribeToTopicFn = httpsCallable(this.functions, 'subscribeToTopic');
      await subscribeToTopicFn({ token: this.currentToken, topic });
      console.log(`Subscribed to topic: ${topic}`);
      return true;
    } catch (error) {
      console.error('Error subscribing to topic:', error);
      return false;
    }
  }

  /**
   * Send test notification (for development)
   */
  async sendTestNotification(): Promise<boolean> {
    try {
      const sendTestFn = httpsCallable(this.functions, 'sendAppointmentReminder');
      await sendTestFn({
        title: 'Test Notification',
        body: 'This is a test push notification from CareConnex!',
        appointmentId: 'test'
      });
      console.log('Test notification sent');
      return true;
    } catch (error) {
      console.error('Error sending test notification:', error);
      return false;
    }
  }

  /**
   * Check if push notifications are supported
   */
  isSupported(): boolean {
    return 'Notification' in window && 'serviceWorker' in navigator;
  }

  /**
   * Get current permission status
   */
  getPermissionStatus(): NotificationPermission {
    if (!('Notification' in window)) return 'denied';
    return Notification.permission;
  }
}

// Export singleton instance
export const pushNotificationService = new PushNotificationService();
