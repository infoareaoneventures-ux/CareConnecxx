import { useEffect, useState, useCallback } from 'react';
import { db } from '../lib/firebase';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  limit
} from 'firebase/firestore';

export interface CalloutNotification {
  id: string;
  title: string;
  body: string;
  type: 'callout';
  isRead: boolean;
  createdAt: any;
  data?: {
    appointmentId: string;
    backupCaregivers: Array<{
      id: string;
      name: string;
      rating: number;
      hourlyRate: number;
      photoURL?: string;
    }>;
    action: string;
  };
}

// Hook to listen for caregiver callout notifications
export const useCaregiverCallout = (userId: string | null) => {
  const [activeCallout, setActiveCallout] = useState<CalloutNotification | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !db) {
      setLoading(false);
      return;
    }

    setLoading(true);
    
    // Query for unread callout notifications
    const notificationsRef = collection(db, 'users', userId, 'notifications');
    const q = query(
      notificationsRef,
      where('type', '==', 'callout'),
      where('isRead', '==', false),
      orderBy('createdAt', 'desc'),
      limit(1)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        if (!snapshot.empty) {
          const doc = snapshot.docs[0];
          const notification = { 
            id: doc.id, 
            ...doc.data() 
          } as CalloutNotification;
          setActiveCallout(notification);
        } else {
          setActiveCallout(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error('Callout listener error:', err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  const dismissCallout = useCallback(async () => {
    if (!activeCallout || !db) return;
    
    try {
      await updateDoc(
        doc(db, 'users', userId!, 'notifications', activeCallout.id), 
        {
          isRead: true,
          readAt: serverTimestamp()
        }
      );
      setActiveCallout(null);
    } catch (error) {
      console.error('Error dismissing callout:', error);
    }
  }, [activeCallout, userId]);

  return {
    activeCallout,
    loading,
    dismissCallout
  };
};

// Hook to get appointment details for callout
export const useAppointmentForCallout = (appointmentId: string | null) => {
  const [appointment, setAppointment] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!appointmentId || !db) {
      setAppointment(null);
      return;
    }

    setLoading(true);
    
    const fetchAppointment = async () => {
      try {
        const docRef = doc(db, 'appointments', appointmentId);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
          setAppointment({
            id: docSnap.id,
            ...docSnap.data()
          });
        }
      } catch (error) {
        console.error('Error fetching appointment:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAppointment();
  }, [appointmentId]);

  return { appointment, loading };
};

export default useCaregiverCallout;
