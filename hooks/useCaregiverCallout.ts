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

// Hook to listen for caregiver callout notifications.
//
// State matrix (R33): callers must distinguish a true-empty snapshot ("no
// callout") from an unavailable query. `error` is true only when the listener
// failed (e.g. a missing composite index → failed-precondition). On error we
// keep any prior callout visible as stale rather than falsely clearing it, and
// expose `retry` to re-subscribe. A genuine empty snapshot sets error=false and
// activeCallout=null.
export const useCaregiverCallout = (userId: string | null) => {
  const [activeCallout, setActiveCallout] = useState<CalloutNotification | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setError(false);
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!userId || !db) {
      // No listener → no stale unavailable state (e.g. after sign-out).
      setError(false);
      setActiveCallout(null);
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
        // Successful snapshot — clears any prior unavailable state.
        setError(false);
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
        // Do NOT clear activeCallout — a failed query is not "no callout".
        console.error('Callout listener error:', err);
        setError(true);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId, reloadKey]);

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
    error,       // true = query unavailable (not the same as "no callout")
    retry,
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
    
    const fdb = db;
    if (!fdb) return;

    const fetchAppointment = async () => {
      try {
        const docRef = doc(fdb, 'appointments', appointmentId);
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
