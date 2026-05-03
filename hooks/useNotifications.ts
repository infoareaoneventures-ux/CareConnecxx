import { useEffect, useState, useCallback } from 'react';
import { db } from '../lib/firebase';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  doc,
  updateDoc,
  addDoc,
  serverTimestamp,
  writeBatch,
  limit
} from 'firebase/firestore';
import { AppNotification } from '../types';

// Hook for real-time notifications
export const useNotifications = (userId: string | null) => {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !db) {
      setLoading(false);
      if (!db) {
        setError('Database not available');
      }
      return;
    }

    setLoading(true);
    setError(null);
    
    const notificationsRef = collection(db, 'notifications');
    const q = query(
      notificationsRef,
      where('userId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const notifs: AppNotification[] = [];
        snapshot.forEach((doc) => {
          notifs.push({ id: doc.id, ...doc.data() } as AppNotification);
        });
        setNotifications(notifs);
        setUnreadCount(notifs.filter(n => !n.isRead).length);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('Notification listener error:', err);
        setError('Failed to load notifications');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  const markAsRead = useCallback(async (notificationId: string) => {
    if (!db) return;
    try {
      await updateDoc(doc(db, 'notifications', notificationId), {
        isRead: true,
        readAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    if (!db || notifications.length === 0) return;
    
    const batch = writeBatch(db);
    notifications
      .filter(n => !n.isRead)
      .forEach(n => {
        batch.update(doc(db, 'notifications', n.id), {
          isRead: true,
          readAt: serverTimestamp()
        });
      });
    
    try {
      await batch.commit();
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
    }
  }, [notifications]);

  const deleteNotification = useCallback(async (notificationId: string) => {
    if (!db) return;
    try {
      // Soft delete by updating status
      await updateDoc(doc(db, 'notifications', notificationId), {
        isDeleted: true,
        deletedAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Error deleting notification:', error);
    }
  }, []);

  return {
    notifications,
    unreadCount,
    loading,
    error,
    markAsRead,
    markAllAsRead,
    deleteNotification
  };
};

// Service for creating notifications
export const notificationAPI = {
  async createNotification(notification: Omit<AppNotification, 'id' | 'createdAt'>): Promise<string> {
    if (!db) throw new Error('Database not initialized');
    
    const docRef = await addDoc(collection(db, 'notifications'), {
      ...notification,
      createdAt: serverTimestamp()
    });
    
    return docRef.id;
  },

  async notifyBookingConfirmed(
    userId: string,
    caregiverName: string,
    appointmentDate: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'Booking Confirmed',
      body: `${caregiverName} has accepted your booking for ${appointmentDate}`,
      type: 'booking',
      isRead: false
    });
  },

  async notifyBookingCancelled(
    userId: string,
    caregiverName: string,
    reason?: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'Booking Cancelled',
      body: `${caregiverName} has cancelled the booking${reason ? `: ${reason}` : ''}`,
      type: 'alert',
      isRead: false
    });
  },

  async notifyNewMessage(
    userId: string,
    senderName: string,
    preview: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: `New message from ${senderName}`,
      body: preview,
      type: 'message',
      isRead: false
    });
  },

  async notifyJobApplication(
    userId: string,
    jobTitle: string,
    caregiverName: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'New Job Application',
      body: `${caregiverName} applied to your job: ${jobTitle}`,
      type: 'booking',
      isRead: false
    });
  },

  async notifyVisitStarted(
    userId: string,
    caregiverName: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'Visit Started',
      body: `${caregiverName} has clocked in and started the visit`,
      type: 'booking',
      isRead: false
    });
  },

  async notifyVisitCompleted(
    userId: string,
    caregiverName: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'Visit Completed',
      body: `${caregiverName} has completed the visit. Please leave a review!`,
      type: 'booking',
      isRead: false
    });
  },

  async notifyReviewReceived(
    userId: string,
    clientName: string,
    rating: number
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'New Review Received',
      body: `${clientName} left you a ${rating}-star review`,
      type: 'system',
      isRead: false
    });
  },

  async notifyEmergencyAlert(
    userId: string,
    alertType: string,
    location?: string
  ): Promise<string> {
    return this.createNotification({
      userId,
      title: 'Emergency Alert',
      body: `Emergency ${alertType} triggered${location ? ` at ${location}` : ''}`,
      type: 'alert',
      isRead: false
    });
  }
};

// Hook for real-time notification badges (lightweight)
export const useUnreadNotificationCount = (userId: string | null) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId || !db) return;

    const notificationsRef = collection(db, 'notifications');
    const q = query(
      notificationsRef,
      where('userId', '==', userId),
      where('isRead', '==', false)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setCount(snapshot.size);
      },
      (error) => {
        console.error('Unread count listener error:', error);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  return count;
};
