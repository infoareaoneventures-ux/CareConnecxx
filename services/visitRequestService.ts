// Request Visit — the Firestore reads and the ONE write behind the shared
// "+ Request Visit" modal (components/client/RequestVisitModal.tsx), lifted out
// of components/Schedule.tsx on 2026-10-07 so My Calendar and My Bookings share
// them through the services seam. Evia's twin: functions/src/agents/
// visitRequest.ts (listVisitRequestCaregivers / the availability picture) and
// visitRequestFlow.ts (the booking_amendments write on YES) — same rules, same
// doc shape; change both together.
import { db } from '../lib/firebase';
import firebase from 'firebase/compat/app';

export interface RequestVisitBooking {
  bookingId: string;
  jobTitle: string;
  address?: string;
  schedule?: Record<string, Array<{ start: string; end: string }>>;
}
export interface RequestVisitTargets {
  caregivers: { id: string; name: string }[];
  caregiverBookings: Record<string, RequestVisitBooking[]>;
}

const EMPTY_TARGETS: RequestVisitTargets = { caregivers: [], caregiverBookings: {} };

// Who a visit can be added for: accepted booking_requests that still have at
// least one 'scheduled' shift — past bookings (all shifts done) are excluded;
// use Re-book instead. (Schedule.tsx fetchHiredCaregivers, verbatim rule.)
export async function fetchRequestVisitTargets(uid: string): Promise<RequestVisitTargets> {
  try {
    if (!db) return EMPTY_TARGETS;
    const [bookingsSnap, shiftsSnap] = await Promise.all([
      db.collection('booking_requests')
        .where('clientId', '==', uid)
        .where('status', '==', 'accepted')
        .get(),
      db.collection('shifts')
        .where('clientId', '==', uid)
        .where('status', '==', 'scheduled')
        .get(),
    ]);

    // Build set of booking IDs that still have scheduled shifts
    const activeBookingIds = new Set<string>();
    shiftsSnap.docs.forEach(d => {
      const bid = d.data().bookingRequestId;
      if (bid) activeBookingIds.add(bid);
    });

    const seenCg = new Set<string>();
    const cgList: { id: string; name: string }[] = [];
    const bookingMap: Record<string, RequestVisitBooking[]> = {};
    bookingsSnap.forEach(doc => {
      const d = doc.data();
      if (!activeBookingIds.has(doc.id)) return;
      if (!d.caregiverId) return;
      if (!seenCg.has(d.caregiverId)) {
        seenCg.add(d.caregiverId);
        cgList.push({ id: d.caregiverId, name: d.caregiverName || 'Caregiver' });
      }
      if (!bookingMap[d.caregiverId]) bookingMap[d.caregiverId] = [];
      bookingMap[d.caregiverId].push({
        bookingId: doc.id,
        jobTitle: d.jobTitle || d.caregiverName || 'Booking',
        address: d.address || '',
        schedule: d.schedule?.dayShiftTimes || {},
      });
    });
    return { caregivers: cgList, caregiverBookings: bookingMap };
  } catch (e) {
    console.error(e);
    return EMPTY_TARGETS;
  }
}

export interface RequestVisitAvailability {
  /** The caregiver's self-reported weekly availability (publicCaregiverProfiles.weeklyAvailability). */
  weeklyAvailability: Record<string, any[]>;
  /** Every slot the caregiver is booked, any client (caregiver_booked_slots.slots), abbr → minute ranges. */
  bookedSlots: Record<string, Array<{ s: number; e: number }>>;
  /** Day-of-week → time blocks from the caregiver's upcoming scheduled shifts WITH THIS FAMILY. */
  shiftBlocks: Record<string, Array<{ start: string; end: string }>>;
}

// The modal's availability picture for one caregiver. The shifts query carries
// clientId so it satisfies the Firestore rules.
export async function fetchRequestVisitAvailability(clientUid: string, caregiverId: string): Promise<RequestVisitAvailability> {
  const out: RequestVisitAvailability = { weeklyAvailability: {}, bookedSlots: {}, shiftBlocks: {} };
  if (!db) return out;
  const [cgSnap, bookedSnap] = await Promise.all([
    db.collection('publicCaregiverProfiles').doc(caregiverId).get().catch(() => null),
    db.collection('caregiver_booked_slots').doc(caregiverId).get().catch(() => null),
  ]);
  if (cgSnap?.exists) out.weeklyAvailability = (cgSnap.data() as any)?.weeklyAvailability || {};
  if (bookedSnap?.exists) out.bookedSlots = (bookedSnap.data() as any)?.slots || {};

  const _t = new Date();
  const today = `${_t.getFullYear()}-${String(_t.getMonth() + 1).padStart(2, '0')}-${String(_t.getDate()).padStart(2, '0')}`;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  try {
    const snap = await db.collection('shifts')
      .where('clientId', '==', clientUid)
      .where('caregiverId', '==', caregiverId)
      .where('status', '==', 'scheduled')
      .get();
    const blocks: Record<string, Array<{ start: string; end: string }>> = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (!data.date || data.date < today) return;
      const dow = DAY_NAMES[new Date(data.date + 'T12:00:00').getDay()];
      if (!blocks[dow]) blocks[dow] = [];
      if (data.startTime && data.endTime) {
        const already = blocks[dow].some(b => b.start === data.startTime && b.end === data.endTime);
        if (!already) blocks[dow].push({ start: data.startTime, end: data.endTime });
      }
    });
    out.shiftBlocks = blocks;
  } catch {
    out.shiftBlocks = {};
  }
  return out;
}

export interface VisitRequestWrite {
  bookingRequestId: string | null;
  clientId: string;
  clientName: string;
  caregiverId: string;
  caregiverName: string;
  newDays: Record<string, Array<{ start: string; end: string }>>;
  notes: string;
  startDate: string;
  endDate: string | null;
  ongoing: boolean;
}

// The modal's Send Request: one booking_amendments doc (type add_recurring_days,
// status pending) — onBookingAmendmentWrite texts the caregiver, who accepts or
// declines. Evia's visitRequestFlow writes the same shape on YES.
export async function sendVisitRequest(data: VisitRequestWrite): Promise<void> {
  if (!db) throw new Error('Firestore unavailable');
  await db.collection('booking_amendments').add({
    ...data,
    status: 'pending',
    type: 'add_recurring_days',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}
