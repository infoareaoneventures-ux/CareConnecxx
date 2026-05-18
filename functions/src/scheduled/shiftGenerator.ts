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

/**
 * Daily job: for every accepted booking, ensure there is at least 1 week of
 * scheduled shifts ahead. Generates exactly 1 more week whenever the furthest
 * scheduled shift falls within 7 days of today. Stops at endDate for
 * fixed-term bookings; runs indefinitely for ongoing ones.
 */
export const generateRollingShifts = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const today = new Date().toISOString().split('T')[0];
    const threshold = addDays(today, 14); // trigger when less than 2 weeks ahead

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

        const dayShiftTimes: Record<string, Array<{ start: string; end: string }>> =
          booking.schedule?.dayShiftTimes || {};
        if (Object.keys(dayShiftTimes).length === 0) continue;

        const endDate: string | null =
          booking.schedule?.ongoing ? null : (booking.schedule?.endDate || null);

        // Skip if booking period has already ended
        if (endDate && today > endDate) continue;

        // Find the furthest future scheduled shift for this booking
        const latestShiftSnap = await db.collection('shifts')
          .where('bookingRequestId', '==', bookingId)
          .where('status', '==', 'scheduled')
          .orderBy('date', 'desc')
          .limit(1)
          .get();

        const maxShiftDate: string = latestShiftSnap.empty
          ? addDays(today, -1)  // no future shifts → start from today
          : (latestShiftSnap.docs[0].data().date as string);

        // Only act if we're within the 7-day threshold
        if (maxShiftDate >= threshold) continue;

        const generateFrom = addDays(maxShiftDate, 1);
        const generateTo   = addDays(maxShiftDate, 14);

        // Fetch caregiver photo
        const caregiverId: string = booking.caregiverId || '';
        let caregiverPhotoURL: string | null = null;
        if (caregiverId) {
          const cgSnap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
          const cgData = cgSnap?.data();
          caregiverPhotoURL = cgData?.profilePhoto || cgData?.photoURL || cgData?.photo || null;
        }

        const shiftBase = {
          clientId:            booking.clientId || '',
          clientName:          booking.clientName || '',
          clientPhotoURL:      booking.clientPhotoURL || null,
          caregiverId,
          caregiverName:       booking.caregiverName || '',
          caregiverPhotoURL,
          status:              'scheduled',
          address:             booking.address || '',
          lifestylePreferences: booking.lifestylePreferences || [],
          rate:                booking.rate ?? null,
          paymentMethod:       booking.paymentMethod || null,
          notes:               booking.notes || '',
          careRecipients:      booking.careRecipients || [],
          emergencyContact:    booking.emergencyContact || null,
          schedule:            booking.schedule || null,
          bookingRequestId:    bookingId,
          jobId:               booking.jobId || null,
          recurringWeekly:     true,
          tasksCompleted:      [],
          createdAt:           admin.firestore.FieldValue.serverTimestamp(),
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

        if (newShifts.length === 0) continue;

        // Firestore batch limit is 500 writes
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

        totalCreated += newShifts.length;
      } catch (err) {
        console.error(`generateRollingShifts: error processing booking ${bookingDoc.id}`, err);
      }
    }

    console.log(`generateRollingShifts: created ${totalCreated} shifts across ${bookingsSnap.size} accepted bookings`);
  });
