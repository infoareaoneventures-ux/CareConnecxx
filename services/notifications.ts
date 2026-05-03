
export type NotificationEventType = 'gig_alert' | 'booking_update' | 'message';

export interface PushNotification {
  title: string;
  body: string;
  type: NotificationEventType;
}

class NotificationService {
  private permission: NotificationPermission = 'default';
  private listeners: ((notification: PushNotification) => void)[] = [];
  private simulationInterval: any = null;

  constructor() {
    if ('Notification' in window) {
      this.permission = Notification.permission;
    }
  }

  /**
   * Request browser permission for system notifications
   */
  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) {
      console.warn('This browser does not support desktop notification');
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      this.permission = permission;
      return permission === 'granted';
    } catch (error) {
      console.error('Error requesting notification permission:', error);
      return false;
    }
  }

  /**
   * Send a notification (System + In-App Listener)
   */
  trigger(notification: PushNotification) {
    // 1. Notify In-App Listeners (Toasts)
    this.listeners.forEach(listener => listener(notification));

    // 2. Trigger System Notification if granted
    if (this.permission === 'granted') {
      new Notification(notification.title, {
        body: notification.body,
        icon: 'https://cdn-icons-png.flaticon.com/512/2966/2966334.png' // Generic bell icon
      });
    }
  }

  /**
   * Subscribe to incoming notifications
   */
  onNotification(callback: (notification: PushNotification) => void) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  /**
   * Start simulating incoming push events for demo purposes
   */
  startSimulation(userType: 'client' | 'caregiver') {
    if (this.simulationInterval) clearInterval(this.simulationInterval);

    this.simulationInterval = setInterval(() => {
      // 10% chance to trigger a notification every 10 seconds
      if (Math.random() > 0.9) {
        if (userType === 'caregiver') {
          this.trigger({
            title: 'New High-Paying Gig!',
            body: '$35/hr - Overnight care required nearby.',
            type: 'gig_alert'
          });
        } else {
          this.trigger({
            title: 'Booking Confirmed',
            body: 'Sarah Jenkins accepted your request for Tuesday.',
            type: 'booking_update'
          });
        }
      }
    }, 10000);
  }

  stopSimulation() {
    if (this.simulationInterval) clearInterval(this.simulationInterval);
  }
}

export const notificationService = new NotificationService();
