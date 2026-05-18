import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function nextOccurrenceOnOrAfter(fromDate: string, dayName: string): string {
  const target = ALL_DAYS_ORDER.indexOf(dayName);
  if (target === -1) return fromDate;
  const base = new Date(fromDate + 'T12:00:00');
  const diff = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);
  return base.toISOString().split('T')[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Shared: generate shifts for one booking starting from a given date up to generateTo.
async function generateShiftsForBooking(
  bookingId: string,
  booking: FirebaseFirestore.DocumentData,
  generateFrom: string,
  generateTo: string,
): Promise<number> {
  const dayShiftTimes: Record<string, Array<{ start: string; end: string }>> =
    booking.schedule?.dayShiftTimes || {};
  if (Object.keys(dayShiftTimes).length === 0) return 0;

  const endDate: string | null =
    booking.schedule?.ongoing ? null : (booking.schedule?.endDate || null);

  if (endDate && generateFrom > endDate) return 0;

  const caregiverId: string = booking.caregiverId || '';
  let caregiverPhotoURL: string | null = null;
  if (caregiverId) {
    const cgSnap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
    const cgData = cgSnap?.data();
    caregiverPhotoURL = cgData?.profilePhoto || cgData?.photoURL || cgData?.photo || null;
  }

  const shiftBase = {
    clientId:             booking.clientId || '',
    clientName:           booking.clientName || '',
    clientPhotoURL:       booking.clientPhotoURL || null,
    caregiverId,
    caregiverName:        booking.caregiverName || '',
    caregiverPhotoURL,
    status:               'scheduled',
    address:              booking.address || '',
    lifestylePreferences: booking.lifestylePreferences || [],
    rate:                 booking.rate ?? null,
    paymentMethod:        booking.paymentMethod || null,
    notes:                booking.notes || '',
    careRecipients:       booking.careRecipients || [],
    emergencyContact:     booking.emergencyContact || null,
    schedule:             booking.schedule || null,
    bookingRequestId:     bookingId,
    jobId:                booking.jobId || null,
    recurringWeekly:      true,
    tasksCompleted:       [],
    createdAt:            admin.firestore.FieldValue.serverTimestamp(),
  };

  const newShifts: Array<{ date: string; start: string; end: string }> = [];

  Object.entries(dayShiftTimes).forEach(([day, blocks]) => {
    (blocks as Array<{ start: string; end: string }>)
      .filter(b => b.start && b.end)
      .forEach(b => {
        let dateStr = nextOccurrenceOnOrAfter(generateFrom, day);
        while (dateStr <= generateTo) {
          if (endDate && dateStr > endDate) break;
          newShifts.push({ date: dateStr, start: b.start, end: b.end });
          dateStr = addDays(dateStr, 7);
        }
      });
  });

  if (newShifts.length === 0) return 0;

  for (let i = 0; i < newShifts.length; i += 499) {
    const chunk = newShifts.slice(i, i + 499);
    const batch = db.batch();
    chunk.forEach(({ date, start, end }) => {
      batch.set(db.collection('shifts').doc(), {
        ...shiftBase,
        date,
        startTime: start,
        endTime:   end,
      });
    });
    await batch.commit();
  }

  return newShifts.length;
}

/**
 * Firestore trigger: when a booking_request is accepted, immediately generate
 * the first 2 weeks of shifts without waiting for the daily job.
 */
export const onBookingAccepted = functions.firestore
  .document('booking_requests/{bookingId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;

    // Only fire when status transitions to 'accepted'
    if (!after || after.status !== 'accepted') return;
    if (before?.status === 'accepted') return; // already accepted, no-op

    const bookingId = context.params.bookingId;
    const today = new Date().toISOString().split('T')[0];
    const startDate: string = after.schedule?.startDate || today;
    const generateFrom = startDate >= today ? startDate : today;
    const generateTo   = addDays(generateFrom, 13); // 2 weeks

    try {
      const created = await generateShiftsForBooking(bookingId, after, generateFrom, generateTo);
      console.log(`onBookingAccepted: created ${created} shifts for booking ${bookingId}`);

      // Notify the client that the caregiver accepted
      if (after.clientId) {
        await db.collection('users').doc(after.clientId).collection('notifications').add({
          userId:    after.clientId,
          type:      'booking_accepted',
          title:     'Booking Accepted',
          message:   `${after.caregiverName || 'Your caregiver'} accepted your booking request.`,
          data:      { bookingId, caregiverId: after.caregiverId },
          read:      false,
          isRead:    false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Auto-close job post if enough caregivers have now accepted
      if (after.jobId) {
        const [jobSnap, acceptedSnap] = await Promise.all([
          db.collection('job_posts').doc(after.jobId).get(),
          db.collection('booking_requests')
            .where('jobId', '==', after.jobId)
            .where('status', '==', 'accepted')
            .get(),
        ]);
        const caregiversNeeded = jobSnap.data()?.caregiversNeeded || 1;
        if (jobSnap.exists && acceptedSnap.size >= caregiversNeeded) {
          await db.collection('job_posts').doc(after.jobId).update({
            status: 'filled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (err) {
      console.error(`onBookingAccepted: error for booking ${bookingId}`, err);
    }
  });

/**
 * Daily job: for every accepted booking, ensure there is at least 2 weeks of
 * scheduled shifts ahead. Generates more whenever the furthest scheduled shift
 * falls within 7 days of today.
 */
export const generateRollingShifts = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const today = new Date().toISOString().split('T')[0];
    const threshold = addDays(today, 14);

    const bookingsSnap = await db.collection('booking_requests')
      .where('status', '==', 'accepted')
      .get();

    if (bookingsSnap.empty) {
      console.log('generateRollingShifts: no accepted bookings');
      return;
    }

    let totalCreated = 0;

    for (const bookingDoc of bookingsSnap.docs) {
      try {
        const booking = bookingDoc.data();
        const bookingId = bookingDoc.id;
        const endDate: string | null =
          booking.schedule?.ongoing ? null : (booking.schedule?.endDate || null);

        if (endDate && today > endDate) continue;

        const latestShiftSnap = await db.collection('shifts')
          .where('bookingRequestId', '==', bookingId)
          .where('status', '==', 'scheduled')
          .orderBy('date', 'desc')
          .limit(1)
          .get();

        const maxShiftDate: string = latestShiftSnap.empty
          ? addDays(today, -1)
          : (latestShiftSnap.docs[0].data().date as string);

        if (maxShiftDate >= threshold) continue;

        const generateFrom = addDays(maxShiftDate, 1);
        const generateTo   = addDays(maxShiftDate, 14);

        const created = await generateShiftsForBooking(bookingId, booking, generateFrom, generateTo);
        totalCreated += created;
      } catch (err) {
        console.error(`generateRollingShifts: error processing booking ${bookingDoc.id}`, err);
      }
    }

    console.log(`generateRollingShifts: created ${totalCreated} shifts`);
  });
