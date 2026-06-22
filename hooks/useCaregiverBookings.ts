import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';

export interface CaregiverBookingsState {
  bookingRequests: any[];
  pendingAmendments: any[];
  allShifts: any[];
}

/**
 * Encapsulates the real-time Firestore subscriptions for a caregiver's bookings
 * so components don't touch `db` directly (see CLAUDE.md — service/hook layer).
 * Subscribes to booking_requests, shifts, and pending booking_amendments for the
 * given caregiver and keeps their state in sync.
 */
export function useCaregiverBookings(caregiverId: string): CaregiverBookingsState {
  const [bookingRequests, setBookingRequests] = useState<any[]>([]);
  const [pendingAmendments, setPendingAmendments] = useState<any[]>([]);
  const [allShifts, setAllShifts] = useState<any[]>([]);

  useEffect(() => {
    if (!caregiverId || !db) return;
    const unsubs: (() => void)[] = [];

    unsubs.push(db.collection('booking_requests').where('caregiverId', '==', caregiverId)
      .onSnapshot(snap => setBookingRequests(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {}));

    unsubs.push(db.collection('shifts').where('caregiverId', '==', caregiverId)
      .onSnapshot(snap => setAllShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {}));

    unsubs.push(db.collection('booking_amendments').where('caregiverId', '==', caregiverId).where('status', '==', 'pending')
      .onSnapshot(snap => setPendingAmendments(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {}));

    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [caregiverId]);

  return { bookingRequests, pendingAmendments, allShifts };
}
