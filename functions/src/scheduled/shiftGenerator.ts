import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';
import { applyMembershipLapse } from '../billing/membershipLapse';
import { canWork } from '../utils/caregiverCanWork';
import { businessTodayStr, DEFAULT_TZ } from '../utils/scheduledTime';
import { careZoneOf } from '../utils/careTime';

const db = admin.firestore();

// A LOCKED caregiver gets no new visits (caregiver sweep C17, 2026-10-11): the one
// gate rule — membership active per caregiverAccessGate (active / trialing / the
// Stripe retry states / legacy membershipPaid) AND the background check cleared —
// is the same canWork() the lock release reads. Visits already on the calendar
// were released by releaseUpcomingVisitsOnLock; this keeps the daily roll from
// quietly adding new ones for someone families can no longer be served by.
export async function caregiverEligibleForNewVisits(
  caregiverId: string,
  cache: Map<string, boolean> = new Map(),
): Promise<boolean> {
  if (!caregiverId) return false;
  const cached = cache.get(caregiverId);
  if (cached !== undefined) return cached;
  const snap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
  const ok = !!snap?.exists && canWork(snap.data() as Record<string, any>);
  cache.set(caregiverId, ok);
  return ok;
}

const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function normDay(day: string): string {
  // Normalize 'MON' / 'monday' / 'Mon' → 'Mon' to match ALL_DAYS_ORDER
  const d = day.trim();
  return d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase();
}

export function nextOccurrenceOnOrAfter(fromDate: string, dayName: string): string {
  const target = ALL_DAYS_ORDER.indexOf(normDay(dayName));
  if (target === -1) return fromDate;
  const base = new Date(fromDate + 'T12:00:00');
  const diff = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);
  return base.toISOString().split('T')[0];
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

type ShiftBlock = { start: string; end: string };
type DayShiftTimes = Record<string, ShiftBlock[]>;

// An accepted schedule change (booking_amendments) generates with the SAME
// generator — only these inputs differ from a fresh booking: the days are the
// amendment's newDays (not the booking's whole schedule), the visit carries the
// merged schedule, the amendment's own end rule and note, and the page's cap.
export interface GenerateOverrides {
  dayShiftTimes?: DayShiftTimes;
  schedule?: Record<string, unknown> | null;
  /** `null` = ongoing (no end). `undefined` = the booking's own end rule. */
  endDate?: string | null;
  notes?: string;
  caregiverId?: string;
  caregiverName?: string;
  clientId?: string;
  clientName?: string;
  maxShifts?: number;
}

// Shared: generate shifts for one booking starting from a given date up to generateTo.
// ONE generator for a fresh booking (onBookingAccepted, generateRollingShifts) AND an
// accepted schedule change (onBookingAmendmentAccepted) — never a second shift shape.
async function generateShiftsForBooking(
  bookingId: string,
  booking: FirebaseFirestore.DocumentData,
  generateFrom: string,
  generateTo: string,
  over: GenerateOverrides = {},
): Promise<number> {
  const dayShiftTimes: DayShiftTimes = over.dayShiftTimes ?? (booking.schedule?.dayShiftTimes || {});
  if (Object.keys(dayShiftTimes).length === 0) return 0;

  const endDate: string | null = over.endDate !== undefined
    ? over.endDate
    : (booking.schedule?.ongoing ? null : (booking.schedule?.endDate || null));

  if (endDate && generateFrom > endDate) return 0;

  const caregiverId: string = over.caregiverId || booking.caregiverId || '';
  let caregiverPhotoURL: string | null = null;
  if (caregiverId) {
    const cgSnap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
    const cgData = cgSnap?.data();
    caregiverPhotoURL = cgData?.profilePhoto || cgData?.photoURL || cgData?.photo || cgData?.imageUrl || null;
  }

  const shiftBase = {
    clientId:             booking.clientId || over.clientId || '',
    clientName:           booking.clientName || over.clientName || '',
    clientPhotoURL:       booking.clientPhotoURL || null,
    caregiverId,
    caregiverName:        booking.caregiverName || over.caregiverName || '',
    caregiverPhotoURL,
    status:               'scheduled',
    address:              booking.address || '',
    careNeeds:            booking.careNeeds || [],
    lifestylePreferences: booking.lifestylePreferences || [],
    rate:                 booking.rate ?? null,
    paymentMethod:        booking.paymentMethod || null,
    notes:                over.notes ?? (booking.notes || ''),
    careRecipients:       booking.careRecipients || [],
    emergencyContact:     booking.emergencyContact || null,
    schedule:             over.schedule !== undefined ? over.schedule : (booking.schedule || null),
    // The care location's zone (2026-11-09, all-U.S.-zones): a visit's date + start/end are wall-clock AT this zone.
    // Every reader that compares a visit with "now" goes through it; a record without one reads as Pacific.
    timeZone:             careZoneOf(booking),
    bookingRequestId:     bookingId,
    jobId:                booking.jobId || null,
    recurringWeekly:      true,
    tasksCompleted:       [],
    createdAt:            admin.firestore.FieldValue.serverTimestamp(),
  };

  const newShifts: Array<{ date: string; start: string; end: string }> = [];
  const maxShifts = over.maxShifts ?? Number.POSITIVE_INFINITY;

  Object.entries(dayShiftTimes).forEach(([day, blocks]) => {
    (blocks as ShiftBlock[])
      .filter(b => b.start && b.end)
      .forEach(b => {
        let dateStr = nextOccurrenceOnOrAfter(generateFrom, day);
        while (dateStr <= generateTo && newShifts.length < maxShifts) {
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

    // A single-shift replacement request (created when a client picks a
    // replacement caregiver after the original one cancelled) that gets
    // declined or cancelled reopens the original shift so the client can try
    // someone else, instead of leaving it silently stuck "waiting to respond".
    if (after?.isShiftReplacement) {
      console.log('onBookingAccepted: replacement request write', {
        bookingId: context.params.bookingId,
        beforeStatus: before?.status ?? null,
        afterStatus: after?.status ?? null,
        replacementForShiftId: after?.replacementForShiftId ?? null,
      });
    }
    if (
      after?.isShiftReplacement && after?.replacementForShiftId &&
      (after.status === 'declined' || after.status === 'cancelled' || after.status === 'expired') &&
      before?.status !== after.status
    ) {
      await db.collection('shifts').doc(after.replacementForShiftId).update({
        status: 'needs_replacement',
        replacementRequestId: admin.firestore.FieldValue.delete(),
        replacementCaregiverName: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).then(() => console.log(`onBookingAccepted: reopened shift ${after.replacementForShiftId} after replacement ${after.status}`))
        .catch((err) => console.error('onBookingAccepted: failed to reopen shift after replacement decline', err));
      return;
    }

    // Only fire when status is 'accepted'
    if (!after || after.status !== 'accepted') return;

    // If already accepted before, only re-generate if no scheduled shifts exist
    if (before?.status === 'accepted') {
      const bookingIdCheck = context.params.bookingId;
      const existingSnap = await db.collection('shifts')
        .where('bookingRequestId', '==', bookingIdCheck)
        .where('status', '==', 'scheduled')
        .limit(1)
        .get();
      if (!existingSnap.empty) return; // has shifts already, skip
      // no shifts found — fall through and regenerate
    }

    const bookingId = context.params.bookingId;
    // "Today" is the care location's date, not UTC's (a 6 PM Eastern booking is already "tomorrow" in UTC).
    const today = businessTodayStr(careZoneOf(after));
    const startDate: string = after.schedule?.startDate || today;
    // Allow up to 2 days in the past to handle UTC vs local timezone differences
    // (e.g. client sets startDate = "today" in PDT but server UTC is already "tomorrow")
    const twoDaysAgo = addDays(today, -2);
    const generateFrom = startDate >= twoDaysAgo ? startDate : today;
    const generateTo   = addDays(generateFrom >= today ? generateFrom : today, 13); // 2 weeks

    try {
      // Remember the care location's zone on the booking (once), so every later reader agrees.
      if (!after.timeZone) await db.collection('booking_requests').doc(bookingId).update({ timeZone: careZoneOf(after) }).catch(() => {});
      const created = await generateShiftsForBooking(bookingId, after, generateFrom, generateTo);
      console.log(`onBookingAccepted: created ${created} shifts for booking ${bookingId}`);

      // This booking is a single-shift replacement for a shift the original
      // caregiver cancelled — now that the new caregiver has accepted and a
      // real shift exists to cover it, the old shift is fully resolved.
      if (after.isShiftReplacement && after.replacementForShiftId) {
        await db.collection('shifts').doc(after.replacementForShiftId).update({
          status: 'cancelled',
          cancelledBy: 'caregiver',
          supersededByBookingId: bookingId,
          replacementRequestId: admin.firestore.FieldValue.delete(),
          replacementCaregiverName: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch((err) => console.error('onBookingAccepted: failed to close out superseded shift', err));
      }

      // Notify the client that the caregiver accepted
      if (after.clientId) {
        await db.collection('users').doc(after.clientId).collection('notifications').add({
          userId:    after.clientId,
          type:      'booking_accepted',
          title:     'Booking Accepted',
          body:      `${after.caregiverName || 'Your care provider'} accepted your booking request.`,
          data:      { bookingId, caregiverId: after.caregiverId },
          isRead:    false,
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

// ── Accepted schedule change → the visits, server-side ───────────────────────
// Until 2026-10-11 the caregiver's Accept on a schedule change
// (CaregiverBookingsPage.handleAcceptAmendment) and Evia's twin
// (caregiverBookingRequests.acceptAmendment) each built the visit documents
// themselves — a browser batch, which is why firestore.rules had to let a
// caregiver create shifts with any status. Now BOTH doors write only the
// acceptance ({status:'accepted', respondedAt}) and this trigger does what the
// page did, with the page's rules: generate from max(startDate, today) for 28
// days (the family's business day, Pacific — live 2026-10-07 a 6 PM accept
// landed "tomorrow" in UTC and every visit slid a week), an ongoing change is
// merged into booking_requests.schedule.dayShiftTimes (a dated one is NOT — the
// daily generator would recreate it forever), a dated change ends on its own
// end date (else the booking's), the request's note travels onto the visits
// (falling back to the booking's), cap 490 — through the ONE generator above,
// behind the C17 gate (a locked caregiver gets no new visits).
export const AMENDMENT_WINDOW_DAYS = 27;   // generateFrom + 27 = 28 days inclusive (the page's window)
export const AMENDMENT_MAX_SHIFTS  = 490;  // the page's batch cap

export async function applyAcceptedAmendment(
  amendmentId: string,
  amendment: FirebaseFirestore.DocumentData,
  now: Date = new Date(),
): Promise<{ created: number; skipped?: 'no_booking' | 'caregiver_not_eligible' }> {
  const bookingRequestId: string = amendment.bookingRequestId || '';
  if (!bookingRequestId) return { created: 0, skipped: 'no_booking' };
  const bookingRef = db.collection('booking_requests').doc(bookingRequestId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) return { created: 0, skipped: 'no_booking' };
  const booking = bookingSnap.data() || {};

  const newDays: DayShiftTimes = amendment.newDays || {};
  const currentDST: DayShiftTimes = booking.schedule?.dayShiftTimes || {};
  const mergedDST: DayShiftTimes = amendment.ongoing
    ? Object.entries(newDays).reduce<DayShiftTimes>((dst, [day, blocks]) => {
        dst[day] = [...(dst[day] ?? []), ...(blocks as ShiftBlock[])];
        return dst;
      }, { ...currentDST })
    : currentDST;
  if (amendment.ongoing) {
    await bookingRef.update({
      'schedule.dayShiftTimes': mergedDST,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const caregiverId: string = amendment.caregiverId || booking.caregiverId || '';
  if (!(await caregiverEligibleForNewVisits(caregiverId))) {
    console.info(`onBookingAmendmentAccepted: caregiver ${caregiverId || '?'} is not eligible (membership/background) — no new visits for amendment ${amendmentId}`);
    return { created: 0, skipped: 'caregiver_not_eligible' };
  }

  const today = businessTodayStr(DEFAULT_TZ, now);
  const generateFrom: string = amendment.startDate && amendment.startDate >= today ? amendment.startDate : today;
  const generateTo = addDays(generateFrom, AMENDMENT_WINDOW_DAYS);
  const endDate: string | null = amendment.ongoing
    ? null
    : (amendment.endDate || (booking.schedule?.ongoing ? null : booking.schedule?.endDate || null));

  const created = await generateShiftsForBooking(bookingRequestId, booking, generateFrom, generateTo, {
    dayShiftTimes: newDays,
    schedule: { ...(booking.schedule || {}), dayShiftTimes: mergedDST },
    endDate,
    notes: amendment.notes || booking.notes || '',
    caregiverId,
    caregiverName: amendment.caregiverName,
    clientId: amendment.clientId,
    clientName: amendment.clientName,
    maxShifts: AMENDMENT_MAX_SHIFTS,
  });
  return { created };
}

/**
 * Firestore trigger: booking_amendments status → 'accepted' (from either door)
 * generates the visits. Runs once per acceptance: the stamp it leaves
 * (shiftsGeneratedAt) makes a redelivered event a no-op, and the rules keep a
 * caregiver's own write to {status, respondedAt} so the stamp can't be forged.
 */
export const onBookingAmendmentAccepted = functions.firestore
  .document('booking_amendments/{amendmentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after  = change.after.data()  || {};
    if (after.status !== 'accepted' || before.status === 'accepted') return;
    if (after.shiftsGeneratedAt) return; // already generated (event redelivery)
    const amendmentId = context.params.amendmentId;
    try {
      const result = await applyAcceptedAmendment(amendmentId, after);
      await change.after.ref.update({
        shiftsGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
        shiftsCreated: result.created,
        ...(result.skipped ? { shiftsSkippedReason: result.skipped } : {}),
      });
      console.log(`onBookingAmendmentAccepted: created ${result.created} shifts for amendment ${amendmentId}${result.skipped ? ` (${result.skipped})` : ''}`);
    } catch (err) {
      console.error(`onBookingAmendmentAccepted: error for amendment ${amendmentId}`, err);
    }
  });

/**
 * A single-shift replacement request is urgent by construction (it only ever
 * gets created for a shift within 24h of starting — see ClientVisitsPage.tsx's
 * handleConfirmReplacement). If the picked caregiver hasn't responded within
 * 30 minutes (REPLACEMENT_EXPIRY_MS, pendingDecisionNudge.ts), expire the
 * request so the client can pick someone else instead of being stuck waiting —
 * onBookingAccepted's reopen branch above handles the 'expired' status the
 * same way it handles a decline, and onBookingRequestWrite
 * (notificationTriggers.ts) tells both sides and takes down the caregiver's
 * parked ACCEPT (sweep B6, 2026-10-11).
 *
 * The same 10-minute sweep runs the caregiver's ONE replacement nudge first
 * (10 minutes before expiry — the hourly nudge job cannot land inside a
 * 30-minute window), so a request is never nudged after it has expired.
 */
export const expireStaleShiftReplacements = functions.pubsub
  .schedule('every 10 minutes')
  .onRun(async () => {
    const { REPLACEMENT_EXPIRY_MS, runPendingDecisionNudges } = await import('./pendingDecisionNudge');
    try {
      const r = await runPendingDecisionNudges(Date.now(), { only: 'replacement' });
      if (r.nudged || r.dropped) console.log('[expireStaleShiftReplacements] replacement nudges', r);
    } catch (err) {
      console.error('expireStaleShiftReplacements: replacement nudge failed', err);
    }
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - REPLACEMENT_EXPIRY_MS);
    const staleSnap = await db.collection('booking_requests')
      .where('isShiftReplacement', '==', true)
      .where('status', '==', 'pending')
      .where('createdAt', '<', cutoff)
      .get();

    for (const doc of staleSnap.docs) {
      await doc.ref.update({
        status: 'expired',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch((err) => console.error('expireStaleShiftReplacements: failed to expire', doc.id, err));
    }
    if (!staleSnap.empty) {
      console.log(`expireStaleShiftReplacements: expired ${staleSnap.size} stale replacement request(s)`);
    }
  });

// ── The next window of visits for a booking (2026-11-09, fix plan Wave 2) ─────────
// "Cancelling one visit ended the whole ongoing booking": the booking was marked completed the moment its
// last SCHEDULED visit reached a terminal state, so an ongoing booking whose generated visits ran out — or
// whose only upcoming visit was cancelled — was closed, and the daily job (which only walks `accepted`
// bookings) never made the next ones. Visits are now created ahead from the LATEST visit of ANY status, so
// a cancelled date is never re-created and an ongoing booking is only ever ended by someone choosing to.
const VISIT_STATUSES = ['scheduled', 'in-progress', 'needs_replacement', 'completed', 'cancelled'] as const;

/** The date (YYYY-MM-DD) of the booking's furthest visit in any state, or null when it has none. */
export async function latestShiftDate(bookingId: string): Promise<string | null> {
  const snaps = await Promise.all(VISIT_STATUSES.map((status) =>
    db.collection('shifts')
      .where('bookingRequestId', '==', bookingId)
      .where('status', '==', status)
      .orderBy('date', 'desc')
      .limit(1)
      .get()));
  let max: string | null = null;
  for (const snap of snaps) {
    if (snap.empty) continue;
    const d = snap.docs[0].data().date as string | undefined;
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

/** The two-week window after the booking's furthest visit (never in the past). */
export function nextVisitWindow(latest: string | null, today: string): { generateFrom: string; generateTo: string; maxShiftDate: string } {
  const maxShiftDate = latest ?? addDays(today, -1);
  const next = addDays(maxShiftDate, 1);
  const generateFrom = next < today ? today : next;
  return { generateFrom, generateTo: addDays(generateFrom, 13), maxShiftDate };
}

/**
 * Create the booking's next two weeks of visits right now (used when its last scheduled visit has just
 * ended or been cancelled). Same gates as the daily job: a frozen family membership or a locked care
 * provider gets none. Returns how many were created; `skipped` says why none could be.
 */
export async function extendBookingShifts(
  bookingId: string,
  booking: FirebaseFirestore.DocumentData,
  now: Date = new Date(),
): Promise<{ created: number; skipped?: 'frozen' | 'caregiver_not_eligible' }> {
  const today = businessTodayStr(careZoneOf(booking), now);
  const bookingRef = db.collection('booking_requests').doc(bookingId);
  const lapse = await applyMembershipLapse(bookingRef, booking, today, new Map());
  if (lapse === 'frozen') return { created: 0, skipped: 'frozen' };
  if (!(await caregiverEligibleForNewVisits(String(booking.caregiverId || '')))) return { created: 0, skipped: 'caregiver_not_eligible' };
  const { generateFrom, generateTo } = nextVisitWindow(await latestShiftDate(bookingId), today);
  return { created: await generateShiftsForBooking(bookingId, booking, generateFrom, generateTo) };
}

/**
 * Daily job: for every accepted booking, ensure there is at least 2 weeks of
 * scheduled shifts ahead. Generates more whenever the furthest scheduled shift
 * falls within 7 days of today.
 * On the first run after a CLEANUP_SHIFTS env flag is set, it will first wipe
 * all scheduled shifts and regenerate from scratch.
 */
export const generateRollingShifts = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const bookingsSnap = await db.collection('booking_requests')
      .where('status', '==', 'accepted')
      .get();

    if (bookingsSnap.empty) {
      console.log('generateRollingShifts: no accepted bookings');
      return;
    }

    const cleanupToday = businessTodayStr(DEFAULT_TZ);
    // ── ONE-TIME CLEANUP: wipe all scheduled shifts and regenerate ──
    // Check a flag doc; if it exists we already cleaned up.
    const flagRef = db.collection('_meta').doc('shiftsCleanedUp');
    const flagSnap = await flagRef.get();
    if (!flagSnap.exists) {
      console.log('generateRollingShifts: running one-time cleanup...');
      const scheduledSnap = await db.collection('shifts').where('status', '==', 'scheduled').get();
      let deleted = 0;
      for (let i = 0; i < scheduledSnap.docs.length; i += 499) {
        const batch = db.batch();
        scheduledSnap.docs.slice(i, i + 499).forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += Math.min(499, scheduledSnap.docs.length - i);
      }
      console.log(`generateRollingShifts: deleted ${deleted} bad shifts`);

      // Regenerate 4 weeks for all accepted bookings immediately
      const generateTo = addDays(cleanupToday, 27);
      let totalCreated = 0;
      for (const bookingDoc of bookingsSnap.docs) {
        try {
          const n = await generateShiftsForBooking(bookingDoc.id, bookingDoc.data(), cleanupToday, generateTo);
          totalCreated += n;
        } catch (err) {
          console.error('cleanup regen error', bookingDoc.id, err);
        }
      }
      await flagRef.set({ cleanedAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`generateRollingShifts: cleanup done — created ${totalCreated} shifts`);
      return;
    }
    // ── END ONE-TIME CLEANUP ──

    let totalCreated = 0;
    // One users read per family per run, shared across their bookings (membership lapse check).
    const membershipCache = new Map<string, Record<string, unknown> | null>();
    // One caregivers read per caregiver per run (eligibility gate, C17).
    const eligibilityCache = new Map<string, boolean>();

    for (const bookingDoc of bookingsSnap.docs) {
      try {
        const booking = bookingDoc.data();
        const bookingId = bookingDoc.id;
        // Each booking's own "today" (its care location's date) — a Chicago booking rolls on Chicago's day.
        const today = businessTodayStr(careZoneOf(booking));
        const threshold = addDays(today, 14);
        const endDate: string | null =
          booking.schedule?.ongoing ? null : (booking.schedule?.endDate || null);

        if (endDate && today > endDate) continue;
        // Family membership lapse (2026-09-17, freeze at the lapse): visits already on the
        // calendar always happen; from the first daily run that sees the membership inactive
        // no new visits are added until they reactivate (billing/membershipLapse.ts).
        const lapse = await applyMembershipLapse(bookingDoc.ref, booking, today, membershipCache);
        if (lapse === 'frozen') continue;
        // Locked caregiver (renewal lock / membership canceled / check not clear): skip + log, never generate.
        if (!(await caregiverEligibleForNewVisits(String(booking.caregiverId || ''), eligibilityCache))) {
          console.info(`generateRollingShifts: caregiver ${booking.caregiverId || '?'} is not eligible (membership/background) — no new visits for booking ${bookingId}`);
          continue;
        }

        // Furthest visit in ANY state (2026-11-09): a cancelled date is still "taken", so it is not re-created.
        const { generateFrom, generateTo, maxShiftDate } = nextVisitWindow(await latestShiftDate(bookingId), today);

        if (maxShiftDate >= threshold) continue;

        const created = await generateShiftsForBooking(bookingId, booking, generateFrom, generateTo);
        totalCreated += created;
      } catch (err) {
        console.error(`generateRollingShifts: error processing booking ${bookingDoc.id}`, err);
      }
    }

    console.log(`generateRollingShifts: created ${totalCreated} shifts`);
  });
