import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { writeUserNotification } from '../notifications/userNotification';
import { sendToPhone } from '../linq/client';
import { sendViaInteractionAgent } from '../agents/caraAgent';

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

// Single source of truth for "tell the other party by text" on the
// booking_requests/shifts/booking_amendments pipeline (2026-08-30) — fires
// for a write from EITHER the website or Evia, since this is a plain
// Firestore trigger. Evia's own MCP tools deliberately do NOT also send this
// text themselves (see manage_booking / request_schedule_amendment) — doing
// it here instead of in every caller is what keeps a cancellation made
// through Evia from producing two texts for one event.
// sendViaInteractionAgent (Evia's own voice, DND/opt-out/supervisor-checked)
// with a plain sendToPhone fallback — matches onAppointmentUpdated's own
// send pattern for the legacy collection, rather than a raw unchecked text.
// urgency: 'immediate', canDrop: false — 2026-09-06 fix (second pass): every
// call site below is a one-time transactional business event (new applicant,
// booking request/decline, interview request/decline/cancel, caregiver
// arrived, …), never a "use your judgment" proactive check-in, so it must
// match the canDrop:false pattern every other must-always-deliver send in
// this codebase uses (see checkr.ts's sendBgcheckNoticeToCaregiver,
// appointmentUpdated.ts). The first pass here (canDrop:true, still gated on
// shouldSend's judgment call) was itself the bug it was written to fix: a
// live test found a client-requested interview never reached the caregiver
// at all. Root cause was two-fold — canDrop:true still runs the message
// through shouldSend's "is now a good time?" gate even at 'immediate'
// urgency (only the daily cap is truly bypassed by urgency alone), AND
// sendViaInteractionAgent RESOLVES false (missing agent_sessions doc,
// opted-out, shouldSend said no, dedup) rather than rejecting for every one
// of those cases — so the `.catch(() => sendToPhone(...))` fallback below
// never ran for exactly the caregiver who most needs it: one who has never
// texted Evia yet, and so has no agent_sessions doc at all. Now checks
// session existence explicitly (mirrors sendBgcheckNoticeToCaregiver) so a
// session-less recipient reliably gets the plain sendToPhone text instead of
// being silently dropped by a resolved (not thrown) false.
async function sendTransactionalText(phone: string, message: string, sourceAgent: string): Promise<void> {
  const sessSnap = await db.collection('agent_sessions').doc(phone).get().catch(() => null);
  if (sessSnap?.exists) {
    await sendViaInteractionAgent(phone, {
      content: message, urgency: 'immediate', sourceAgent, canDrop: false,
    }).catch(() => sendToPhone(phone, message)).catch((err) =>
      console.error(`[notificationTriggers] ${sourceAgent} failed:`, err));
    return;
  }
  await sendToPhone(phone, message).catch((err) =>
    console.error(`[notificationTriggers] ${sourceAgent} failed (no agent session):`, err));
}

async function notifyCaregiverByText(caregiverId: string, message: string): Promise<void> {
  const snap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
  const phone = snap?.data()?.phone as string | undefined;
  if (!phone) return;
  await sendTransactionalText(phone, message, 'notification_trigger');
}

async function notifyClientByText(clientId: string, message: string): Promise<void> {
  const snap = await db.collection('users').doc(clientId).get().catch(() => null);
  const phone = snap?.data()?.phone as string | undefined;
  if (!phone) return;
  await sendTransactionalText(phone, message, 'notification_trigger');
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
      // New interview created → notify caregiver. Parse scheduledTime tz-aware
      // and render in PT — Z-form values rendered without a timeZone showed the
      // UTC clock (7-8h wrong) in the notification.
      if (!before && statusAfter === 'requested' && after.caregiverId) {
        const { parseScheduledTimeMs } = await import('../utils/scheduledTime');
        const displayTime = new Date(parseScheduledTimeMs(String(after.scheduledTime ?? ''))).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        await addNotification(after.caregiverId, {
          type: 'interview_request',
          title: 'New Interview Request',
          body: `${after.clientName} requested an interview on ${displayTime}.`,
          data: { interviewId: context.params.interviewId },
        });
        await notifyCaregiverByText(after.caregiverId,
          `${after.clientName || 'A family'} requested an interview with you on ${displayTime}. Reply here to accept or propose a different time.`);
        return;
      }

      // Rescheduled — an EXISTING interview's time changed while awaiting
      // response, whether or not the status label itself changed (a
      // still-requested interview rescheduled before the other side ever
      // responded is a real reschedule too, and would otherwise be
      // swallowed by the statusBefore===statusAfter check below). Notify
      // whichever party did NOT make this change — rescheduledBy is
      // stamped by whichever side's UI wrote it (PostsPage.tsx /
      // JobBoard.tsx); the site's Reschedule/Propose new time actions are
      // the only writers of this field.
      if (
        before &&
        statusAfter === 'requested' &&
        after.scheduledTime &&
        before.scheduledTime !== after.scheduledTime
      ) {
        const { parseScheduledTimeMs } = await import('../utils/scheduledTime');
        const displayTime = new Date(parseScheduledTimeMs(String(after.scheduledTime ?? ''))).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        if (after.rescheduledBy === 'caregiver' && after.clientId) {
          await addNotification(after.clientId, {
            type: 'interview_rescheduled',
            title: 'Interview Time Changed',
            body: `${after.caregiverName || 'Your caregiver'} proposed a new time: ${displayTime}. Please confirm.`,
            data: { interviewId: context.params.interviewId },
          });
          await notifyClientByText(after.clientId,
            `${after.caregiverName || 'Your caregiver'} proposed a new interview time: ${displayTime}. Reply here to confirm or suggest another time.`);
        } else if (after.caregiverId) {
          await addNotification(after.caregiverId, {
            type: 'interview_rescheduled',
            title: 'Interview Time Changed',
            body: `${after.clientName || 'The family'} changed the interview time to ${displayTime}. Please confirm.`,
            data: { interviewId: context.params.interviewId },
          });
          await notifyCaregiverByText(after.caregiverId,
            `${after.clientName || 'The family'} changed the interview time to ${displayTime}. Reply here to confirm or suggest another time.`);
        }
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
          // "Not Selected" fires from both the website button and Evia's
          // submit_interview_feedback (fitLevel:'no') — neither path texts the
          // caregiver today, unlike the 'strong' path (which does), so a
          // caregiver waiting to hear back had nothing but a bell icon.
          // Found 2026-09-06, same gap class as the decline-direction fix above.
          await notifyCaregiverByText(after.caregiverId, `${after.clientName || 'The family'} has decided not to move forward at this time.`);
        } else if (after.clientId) {
          // Caregiver declined → notify client
          await addNotification(after.clientId, {
            type: 'interview_declined',
            title: 'Interview Declined',
            body: `${after.caregiverName} is unable to make the scheduled interview.`,
            data: { interviewId: context.params.interviewId },
          });
          // respond_to_interview_request (mcp/server.ts) already texts this
          // direction itself and stamps respondedViaAgent — skip to avoid a
          // double text. A website-button decline has nothing else telling
          // the client by phone, unlike accept (interviewLinkTrigger) and
          // cancel (below) — found 2026-09-06, this SMS never existed.
          if (!after.respondedViaAgent) {
            await notifyClientByText(after.clientId, `${after.caregiverName || 'Your caregiver'} isn't able to make the scheduled interview.`);
          }
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
          // cancel_interview (mcp/server.ts) already texts this direction
          // itself and stamps cancelledViaAgent — skip to avoid a double text.
          if (!after.cancelledViaAgent) {
            await notifyClientByText(after.clientId, `${after.caregiverName || 'Your caregiver'} cancelled the scheduled interview.`);
          }
        } else if (after.caregiverId) {
          // Client cancelled (or unknown)
          await addNotification(after.caregiverId, {
            type: 'interview_cancelled',
            title: 'Interview Cancelled',
            body: `${after.clientName || 'A client'} cancelled the scheduled interview.`,
            data: { interviewId: context.params.interviewId },
          });
          if (!after.cancelledViaAgent) {
            await notifyCaregiverByText(after.caregiverId, `${after.clientName || 'A client'} cancelled the scheduled interview.`);
          }
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
      // Single source of truth for this text — apply_to_job (mcp/server.ts)
      // deliberately does not also send it, to avoid a double text when a
      // caregiver applies through Evia.
      await notifyClientByText(data.clientId, "A caregiver applied to your job post. Text 'show applications' to review.");
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
        // Evia-negotiated bookings (agentTaskId set) already get a richer
        // YES/NO shift-offer text from createShiftOffer — sending this generic
        // one too would double-text. Only a pure website-created booking (no
        // agentTaskId) has nothing else telling the caregiver by phone.
        if (!after.agentTaskId) {
          await notifyCaregiverByText(after.caregiverId,
            `${after.clientName || 'A client'} ${isResend ? 'resent their' : 'sent you a'} booking request. Check the app to respond.`);
        }
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
        // Same reasoning as above — an Evia-negotiated decline already texts
        // the family from shiftOffer.ts's onOfferNotAccepted.
        if (!after.agentTaskId) {
          await notifyClientByText(after.clientId,
            `${after.caregiverName || 'Your caregiver'} isn't able to accept that booking request.`);
        }
      }

      // Cancelled → notify caregiver
      if (statusAfter === 'cancelled' && after.caregiverId) {
        const noun = statusBefore === 'accepted' ? 'booking' : 'booking request';
        await addNotification(after.caregiverId, {
          type: 'booking_cancelled',
          title: 'Booking Cancelled',
          body: `${after.clientName || 'A client'} cancelled their ${noun}.`,
          data: { bookingId: context.params.bookingId },
        });
        await notifyCaregiverByText(after.caregiverId,
          `${after.clientName || 'A client'} cancelled their ${noun}. Sorry for the inconvenience.`);
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
        // Single source of truth for this text — request_schedule_amendment
        // (mcp/server.ts) deliberately does not also send it, to avoid a
        // double text when a family requests this through Evia.
        await notifyCaregiverByText(after.caregiverId, isOneDay
          ? `${after.clientName || 'A family'} would like to add a visit on ${after.startDate}. Reply here to accept or decline.`
          : `${after.clientName || 'A family'} would like to add ${days} to your regular schedule. Reply here to accept or decline.`);
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
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} accepted your request to add ${days} to the schedule.`);
      }

      // Declined → notify client
      if (statusAfter === 'declined' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'amendment_declined',
          title: 'Schedule Change Declined',
          body: `${after.caregiverName || 'Your caregiver'} is unable to accept your schedule change request.`,
          data: { amendmentId: context.params.amendmentId },
        });
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} isn't able to accept that schedule change request.`);
      }

      // Cancelled → notify caregiver
      if (statusAfter === 'cancelled' && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'amendment_cancelled',
          title: 'Change Request Cancelled',
          body: `${after.clientName || 'A client'} cancelled their change request.`,
          data: { amendmentId: context.params.amendmentId },
        });
        await notifyCaregiverByText(after.caregiverId,
          `${after.clientName || 'A client'} withdrew that schedule-change request — no need to respond.`);
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

    const shiftId = context.params.shiftId;
    const fmtDate = after.date
      ? ` on ${new Date(after.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : '';

    // ── 1. In-app notifications on status change ────────────────────────────
    try {
      // Extra visit = a client-requested pending shift. The caregiver's response
      // (accept → scheduled, decline → cancelled) must notify the CLIENT.
      // Previously decline set status:'cancelled' with no cancelledBy and fell
      // through to the generic branch below, notifying the caregiver (wrong
      // party). Keyed on observable doc state — NOT createdBy, which no shift
      // writer sets: the only actor on a pending shift is the caregiver
      // (CaregiverBookingsPage Accept/Decline), so pending → scheduled, and
      // pending → cancelled without a cancelledBy attribution, are both
      // caregiver responses. Idempotent via the trigger eventId.
      if (before.status === 'pending' && after.clientId &&
          (after.status === 'scheduled' ||
           (after.status === 'cancelled' && !after.cancelledBy && !after.bulkCancelled))) {
        const accepted = after.status === 'scheduled';
        await writeUserNotification({
          sourcePath: `shifts/${shiftId}`,
          eventId: context.eventId,
          recipientId: after.clientId,
          transitionType: accepted ? 'extra_visit_accepted' : 'extra_visit_declined',
          type: accepted ? 'shift_accepted' : 'shift_declined',
          title: accepted ? 'Extra Visit Confirmed' : 'Extra Visit Declined',
          body: accepted
            ? `${after.caregiverName || 'Your caregiver'} confirmed your extra visit${fmtDate}.`
            : `${after.caregiverName || 'Your caregiver'} can't make the extra visit${fmtDate}.`,
          data: { shiftId },
        });
        await notifyClientByText(after.clientId, accepted
          ? `${after.caregiverName || 'Your caregiver'} confirmed your extra visit${fmtDate}.`
          : `${after.caregiverName || 'Your caregiver'} can't make the extra visit${fmtDate}.`);
      // Caregiver started shift → notify client (parity with onAppointmentUpdated's
      // arrival ping — start_shift/complete_shift never message the family
      // themselves, so this trigger is the only place this text comes from).
      } else if (after.status === 'in-progress' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'shift_started',
          title: 'Shift Started',
          body: `${after.caregiverName || 'Your caregiver'} has started your visit.`,
          data: { shiftId: context.params.shiftId },
        });
        await notifyClientByText(after.clientId, `${after.caregiverName || 'Your caregiver'} has arrived and started the visit.`);
      } else if (after.status === 'completed' && after.clientId) {
        // Caregiver ended shift → notify client
        await addNotification(after.clientId, {
          type: 'shift_completed',
          title: 'Shift Completed',
          body: `${after.caregiverName || 'Your caregiver'} has completed your visit.`,
          data: { shiftId: context.params.shiftId },
        });
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'}'s visit is complete. A care journal entry will be posted shortly.`);
      } else if (after.status === 'cancelled' && !after.bulkCancelled) {
        // Cancelled — direction depends on who cancelled. (fmtDate is hoisted
        // above and already includes the " on <date>" prefix, or '' if no date.)
        const whenText = fmtDate || ' for an upcoming date';

        if (after.cancelledBy === 'caregiver' && after.clientId) {
          // Caregiver cancelled → notify client
          await addNotification(after.clientId, {
            type: 'shift_cancelled',
            title: 'Shift Cancelled',
            body: `${after.caregiverName || 'Your caregiver'} cancelled the shift${whenText}.`,
            data: { shiftId: context.params.shiftId },
          });
        } else if (after.caregiverId) {
          // Client cancelled → notify caregiver
          await addNotification(after.caregiverId, {
            type: 'shift_cancelled',
            title: 'Shift Cancelled',
            body: `${after.clientName || 'A client'} cancelled the shift${whenText}.`,
            data: { shiftId: context.params.shiftId },
          });
          await notifyCaregiverByText(after.caregiverId,
            `${after.clientName || 'A client'} cancelled the visit${whenText}. Sorry for the inconvenience.`);
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
