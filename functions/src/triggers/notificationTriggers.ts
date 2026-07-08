import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

const db = admin.firestore();

async function addNotification(
  userId: string,
  notification: { type: string; title: string; body: string; data?: Record<string, any> }
) {
  await db.collection('users').doc(userId).collection('notifications').add({
    userId,
    ...notification,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── video_interviews ────────────────────────────────────────────────────────
// Handles: new request → caregiver, accept → client, decline → other party,
//          cancel → other party (based on cancelledBy / declinedBy field)
export const onVideoInterviewWrite = functions.firestore
  .document('video_interviews/{interviewId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;
    if (!after) return;

    const statusBefore = before?.status;
    const statusAfter  = after.status;

    try {
      // New interview created → notify caregiver
      if (!before && statusAfter === 'requested' && after.caregiverId) {
        const displayTime = new Date(after.scheduledTime).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        await addNotification(after.caregiverId, {
          type: 'interview_request',
          title: 'New Interview Request',
          body: `${after.clientName} requested an interview on ${displayTime}.`,
          data: { interviewId: context.params.interviewId },
        });
        return;
      }

      if (statusBefore === statusAfter) return;

      // Accepted → notify client
      if (statusAfter === 'accepted' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'interview_accepted',
          title: 'Interview Accepted',
          body: `${after.caregiverName} accepted your interview request.`,
          data: { interviewId: context.params.interviewId },
        });
      }

      // Declined — direction depends on who declined
      if (statusAfter === 'declined') {
        if (after.declinedBy === 'client' && after.caregiverId) {
          // Client marked "Not Selected" → notify caregiver
          await addNotification(after.caregiverId, {
            type: 'hire_decision',
            title: 'Interview Update',
            body: `${after.clientName || 'A client'} has decided not to move forward at this time.`,
            data: { interviewId: context.params.interviewId },
          });
        } else if (after.clientId) {
          // Caregiver declined → notify client
          await addNotification(after.clientId, {
            type: 'interview_declined',
            title: 'Interview Declined',
            body: `${after.caregiverName} is unable to make the scheduled interview.`,
            data: { interviewId: context.params.interviewId },
          });
        }
      }

      // Cancelled — direction depends on who cancelled
      if (statusAfter === 'cancelled') {
        if (after.cancelledBy === 'caregiver' && after.clientId) {
          await addNotification(after.clientId, {
            type: 'interview_cancelled',
            title: 'Interview Cancelled',
            body: `${after.caregiverName} cancelled the scheduled interview.`,
            data: { interviewId: context.params.interviewId },
          });
        } else if (after.caregiverId) {
          // Client cancelled (or unknown)
          await addNotification(after.caregiverId, {
            type: 'interview_cancelled',
            title: 'Interview Cancelled',
            body: `${after.clientName || 'A client'} cancelled the scheduled interview.`,
            data: { interviewId: context.params.interviewId },
          });
        }
      }
    } catch (err) {
      console.error('[onVideoInterviewWrite] error:', err);
    }
  });

// ── job_applications ────────────────────────────────────────────────────────
// New application → notify client
export const onJobApplicationCreate = functions.firestore
  .document('job_applications/{applicationId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (!data?.clientId) return;
    try {
      await addNotification(data.clientId, {
        type: 'job_application',
        title: 'New Applicant',
        body: `${data.caregiverName} applied to your post: "${data.jobTitle}".`,
        data: { applicationId: context.params.applicationId, jobId: data.jobId },
      });
    } catch (err) {
      console.error('[onJobApplicationCreate] error:', err);
    }
  });

// ── booking_requests ────────────────────────────────────────────────────────
// New request → notify caregiver
// Declined → notify client
// Cancelled → notify caregiver
// (Accepted is already handled by onBookingAccepted in shiftGenerator.ts)
export const onBookingRequestWrite = functions.firestore
  .document('booking_requests/{bookingId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;
    if (!after) return;

    const statusBefore = before?.status;
    const statusAfter  = after.status;

    try {
      // New booking request created → notify caregiver
      if (!before && statusAfter === 'pending' && after.caregiverId) {
        const isResend = after.isResend === true;
        await addNotification(after.caregiverId, {
          type: 'booking_request',
          title: isResend ? 'Booking Request Resent' : 'New Booking Request',
          body: `${after.clientName || 'A client'} ${isResend ? 'resent their' : 'sent you a'} booking request.`,
          data: { bookingId: context.params.bookingId },
        });
        return;
      }

      if (statusBefore === statusAfter) return;

      // Declined → notify client
      if (statusAfter === 'declined' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'booking_declined',
          title: 'Booking Declined',
          body: `${after.caregiverName || 'Your caregiver'} is unable to accept your booking request.`,
          data: { bookingId: context.params.bookingId },
        });
      }

      // Cancelled → notify caregiver
      if (statusAfter === 'cancelled' && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'booking_cancelled',
          title: 'Booking Cancelled',
          body: `${after.clientName || 'A client'} cancelled their booking${statusBefore === 'accepted' ? '' : ' request'}.`,
          data: { bookingId: context.params.bookingId },
        });
      }
    } catch (err) {
      console.error('[onBookingRequestWrite] error:', err);
    }
  });

// ── booking_amendments ──────────────────────────────────────────────────────
// New amendment → notify caregiver
// Accepted → notify client
// Declined → notify client
// Cancelled → notify caregiver
export const onBookingAmendmentWrite = functions.firestore
  .document('booking_amendments/{amendmentId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after  = change.after.exists  ? change.after.data()  : null;
    if (!after) return;

    const statusBefore = before?.status;
    const statusAfter  = after.status;

    try {
      // New amendment created → notify caregiver
      if (!before && after.caregiverId) {
        const days = Object.keys(after.newDays || {}).join(', ');
        const isOneDay = !after.ongoing && after.startDate && after.endDate && after.startDate === after.endDate;
        await addNotification(after.caregiverId, {
          type: 'amendment_request',
          title: isOneDay ? 'Extra Visit Requested' : 'Schedule Change Requested',
          body: isOneDay
            ? `${after.clientName || 'Your client'} requested an extra visit on ${new Date(after.startDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`
            : `${after.clientName || 'Your client'} wants to add ${days} to your regular schedule.`,
          data: { amendmentId: context.params.amendmentId },
        });
        return;
      }

      if (statusBefore === statusAfter) return;

      // Accepted → notify client
      if (statusAfter === 'accepted' && after.clientId) {
        const days = Object.keys(after.newDays || {}).join(', ');
        await addNotification(after.clientId, {
          type: 'amendment_accepted',
          title: 'Schedule Change Accepted',
          body: `${after.caregiverName} accepted your request to add ${days} to your regular schedule.`,
          data: { amendmentId: context.params.amendmentId },
        });
      }

      // Declined → notify client
      if (statusAfter === 'declined' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'amendment_declined',
          title: 'Schedule Change Declined',
          body: `${after.caregiverName || 'Your caregiver'} is unable to accept your schedule change request.`,
          data: { amendmentId: context.params.amendmentId },
        });
      }

      // Cancelled → notify caregiver
      if (statusAfter === 'cancelled' && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'amendment_cancelled',
          title: 'Change Request Cancelled',
          body: `${after.clientName || 'A client'} cancelled their change request.`,
          data: { amendmentId: context.params.amendmentId },
        });
      }
    } catch (err) {
      console.error('[onBookingAmendmentWrite] error:', err);
    }
  });

// ── shifts ──────────────────────────────────────────────────────────────────
// in-progress → notify client (caregiver started shift)
// completed   → notify client (caregiver ended shift)
// cancelled by client → notify caregiver (individual shift only;
//   bulk booking cancellations handled by onBookingRequestWrite)
// MERGED handler (bug-audit §7.1): this is the SINGLE onShiftStatusChanged for
// shifts/{shiftId} onUpdate. It previously collided with an identically-named
// export in shiftStatusTrigger.ts — index.ts re-exported that one explicitly, so
// ES-module rules dropped THIS one and in-app shift notifications never deployed.
// Both concerns now live here: (1) in-app shift_started/_completed/_cancelled
// notifications, and (2) marking a booking_requests doc completed once its last
// scheduled shift reaches a terminal state. Each concern has its own try/catch so
// one failing never suppresses the other.
export const onShiftStatusChanged = functions.firestore
  .document('shifts/{shiftId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    if (before.status === after.status) return;

    // ── 1. In-app notifications on status change ────────────────────────────
    try {
      // Caregiver started shift → notify client
      if (after.status === 'in-progress' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'shift_started',
          title: 'Shift Started',
          body: `${after.caregiverName || 'Your caregiver'} has started your visit.`,
          data: { shiftId: context.params.shiftId },
        });
      } else if (after.status === 'completed' && after.clientId) {
        // Caregiver ended shift → notify client
        await addNotification(after.clientId, {
          type: 'shift_completed',
          title: 'Shift Completed',
          body: `${after.caregiverName || 'Your caregiver'} has completed your visit.`,
          data: { shiftId: context.params.shiftId },
        });
      } else if (after.status === 'cancelled' && !after.bulkCancelled) {
        // Cancelled — direction depends on who cancelled
        const fmtDate = after.date
          ? new Date(after.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
          : 'an upcoming date';

        if (after.cancelledBy === 'caregiver' && after.clientId) {
          // Caregiver cancelled → notify client
          await addNotification(after.clientId, {
            type: 'shift_cancelled',
            title: 'Shift Cancelled',
            body: `${after.caregiverName || 'Your caregiver'} cancelled the shift on ${fmtDate}.`,
            data: { shiftId: context.params.shiftId },
          });
        } else if (after.caregiverId) {
          // Client cancelled → notify caregiver
          await addNotification(after.caregiverId, {
            type: 'shift_cancelled',
            title: 'Shift Cancelled',
            body: `${after.clientName || 'A client'} cancelled the shift on ${fmtDate}.`,
            data: { shiftId: context.params.shiftId },
          });
        }
      }
    } catch (err) {
      console.error('[onShiftStatusChanged] notification error:', err);
    }

    // ── 2. Booking completion: when the last scheduled shift for a booking
    //      reaches a terminal state, mark the booking completed so the client
    //      and caregiver UIs move it to Past (formerly shiftStatusTrigger.ts) ──
    try {
      const terminal = ['completed', 'cancelled'];
      if (!terminal.includes(after.status)) return;

      const bookingRequestId: string | undefined = after.bookingRequestId;
      if (!bookingRequestId) return;

      const remainingSnap = await db
        .collection('shifts')
        .where('bookingRequestId', '==', bookingRequestId)
        .where('status', '==', 'scheduled')
        .limit(1)
        .get();
      if (!remainingSnap.empty) return; // still active shifts — nothing to do

      const bookingRef = db.collection('booking_requests').doc(bookingRequestId);
      const bookingSnap = await bookingRef.get();
      if (!bookingSnap.exists) return;
      if (bookingSnap.data()!.status !== 'accepted') return; // don't overwrite cancelled

      await bookingRef.update({
        status: 'completed',
        completedAt: new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[onShiftStatusChanged] booking ${bookingRequestId} marked completed — no scheduled shifts remain`);
    } catch (err) {
      console.error('[onShiftStatusChanged] booking-completion error:', err);
    }
  });
