import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';

export interface InProgressVisit { id: string; status: string; clientName?: string; date?: string; startTime?: string; endTime?: string }

/**
 * The caregiver's visits that are IN PROGRESS right now (any date — a visit
 * forgotten yesterday still counts), live. One subscription behind the
 * one-visit-at-a-time rule (utils/shiftStart.ts) on every Start Shift button.
 */
export function useInProgressVisits(caregiverId: string | undefined): InProgressVisit[] {
  const [visits, setVisits] = useState<InProgressVisit[]>([]);
  useEffect(() => {
    if (!caregiverId || !db) { setVisits([]); return; }
    const unsub = db.collection('shifts')
      .where('caregiverId', '==', caregiverId)
      .where('status', '==', 'in-progress')
      .onSnapshot(
        snap => setVisits(snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<InProgressVisit, 'id'>) }))),
        () => setVisits([]),
      );
    return unsub;
  }, [caregiverId]);
  return visits;
}
