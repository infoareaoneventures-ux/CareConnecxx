import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

/**
 * When a shift transitions to 'completed' or 'cancelled', check whether
 * any scheduled shifts remain for that booking. If none do, mark the
 * booking_requests doc as 'completed' so client and caregiver UIs
 * correctly move the booking to Past without needing per-component
 * shift cross-references.
 */
export const onShiftStatusChanged = functions.firestore
  .document('shifts/{shiftId}')
  .onUpdate(async (change) => {
    try {
      const before = change.before.data();
      const after  = change.after.data();

      // Only care about transitions into a terminal state
      const terminal = ['completed', 'cancelled'];
      if (!terminal.includes(after.status)) return;
      if (before.status === after.status) return;

      const bookingRequestId: string | undefined = after.bookingRequestId;
      if (!bookingRequestId) return;

      // Check if any scheduled shifts remain for this booking
      const remainingSnap = await db
        .collection('shifts')
        .where('bookingRequestId', '==', bookingRequestId)
        .where('status', '==', 'scheduled')
        .limit(1)
        .get();

      if (!remainingSnap.empty) {
        // Still active shifts — nothing to do
        return;
      }

      // No scheduled shifts left — mark booking as completed
      const bookingRef = db.collection('booking_requests').doc(bookingRequestId);
      const bookingSnap = await bookingRef.get();
      if (!bookingSnap.exists) return;

      const booking = bookingSnap.data()!;
      // Only update if currently accepted (don't overwrite cancelled)
      if (booking.status !== 'accepted') return;

      await bookingRef.update({
        status: 'completed',
        completedAt: new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`[onShiftStatusChanged] booking ${bookingRequestId} marked completed — no scheduled shifts remain`);
    } catch (err) {
      console.error('[onShiftStatusChanged] error:', err);
    }
  });
