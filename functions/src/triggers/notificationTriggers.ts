import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { sendToPhone } from '../linq/client';
import { sendViaInteractionAgent } from '../agents/caraAgent';
import { formatDateForDisplay, formatHHMMForDisplay } from '../utils/scheduledTime';
import { recordVisitProgress, buildVisitCompletionText, buildFamilyUpdateText, queuedItems } from './familyVisitUpdates';
import { isFirstCompletedVisit, firstVisitReviewPromptLine, firstVisitReviewNotification, setReviewPromptAnchor } from '../agents/reviewPrompt';

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
// this codebase uses (see notifications/caregiverAccountEvents.ts,
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
// session existence explicitly (mirrors caregiverAccountEvents.ts) so a
// session-less recipient reliably gets the plain sendToPhone text instead of
// being silently dropped by a resolved (not thrown) false.
// A notice about ONE record remembers that record on the session, so a bare
// "accept" / "yes confirm" reply resolves to it (2026-09-27 live: the model
// guessed an interview id — wrong interview on one side, NOT_FOUND on the other).
async function stampSession(phone: string, patch: Record<string, unknown> | undefined): Promise<void> {
  if (!patch) return;
  try { await db.collection('agent_sessions').doc(phone).set(patch, { merge: true }); } catch { /* best effort */ }
}
export const noticedInterview = (interviewId: string) => ({ lastNoticedInterviewId: interviewId, lastNoticedInterviewAt: new Date().toISOString() });
// Decision notices park the expected reply (agents/decisionNotices.ts).
import { parkedDecision, parkDecision } from '../agents/decisionNotices';
import { normalizeBookingRequest, requestCardLines, requestDetailsLines, amendmentCardLines } from '../agents/caregiverBookingRequests';

// The caregiver's Requests-tab card, whole, in the notice itself (founder,
// 2026-09-27: "why didn't I get the full details of the booking") — the tab
// shows the card the moment it appears; the text does too. No DETAILS step.
function bookingRequestText(id: string, doc: Record<string, unknown>, lead: string): string {
  const req = normalizeBookingRequest(id, doc);
  const lines = [...requestCardLines(req), ...(() => { const d = requestDetailsLines(req); return d.length ? ["", ...d] : []; })()];
  return `${lead}\n\n${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n\nReply ACCEPT or DECLINE.`;
}

async function sendTransactionalText(phone: string, message: string, sourceAgent: string, stamp?: Record<string, unknown>): Promise<void> {
  const sessSnap = await db.collection('agent_sessions').doc(phone).get().catch(() => null);
  if (sessSnap?.exists) {
    await stampSession(phone, stamp);
    await sendViaInteractionAgent(phone, {
      content: message, urgency: 'immediate', sourceAgent, canDrop: false,
    }).catch(() => sendToPhone(phone, message)).catch((err) =>
      console.error(`[notificationTriggers] ${sourceAgent} failed:`, err));
    return;
  }
  await sendToPhone(phone, message).catch((err) =>
    console.error(`[notificationTriggers] ${sourceAgent} failed (no agent session):`, err));
}

export async function notifyCaregiverByText(caregiverId: string, message: string, stamp?: Record<string, unknown>): Promise<void> {
  const snap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
  const phone = snap?.data()?.phone as string | undefined;
  if (!phone) return;
  await sendTransactionalText(phone, message, 'notification_trigger', stamp);
}

export async function notifyClientByText(clientId: string, message: string, stamp?: Record<string, unknown>): Promise<void> {
  const snap = await db.collection('users').doc(clientId).get().catch(() => null);
  const phone = snap?.data()?.phone as string | undefined;
  if (!phone) return;
  await sendTransactionalText(phone, message, 'notification_trigger', stamp);
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
        // The Interviews tab card, as one line: family, job, date + time, type,
        // and the family's note (2026-09-27 — the note used to be missing).
        const ivType = after.interviewType === 'in-person' ? 'In Person' : after.interviewType === 'phone' ? 'Phone' : 'Video';
        const forJob = after.jobTitle ? ` for "${after.jobTitle}"` : '';
        const note = typeof after.notes === 'string' && after.notes.trim() ? ` Note: "${after.notes.trim()}"` : '';
        const body = `${after.clientName || 'A family'} requested an interview with you${forJob} on ${displayTime} (${ivType}).${note}`;
        await addNotification(after.caregiverId, {
          type: 'interview_request',
          title: 'New Interview Request',
          body,
          data: { interviewId: context.params.interviewId },
        });
        await notifyCaregiverByText(after.caregiverId, `${body} Reply ACCEPT or DECLINE, or PROPOSE a different time.`, {
          ...noticedInterview(context.params.interviewId),
          ...parkDecision(parkedDecision("interview_request", context.params.interviewId, `an interview request from ${after.clientName || 'a family'}`, "caregiver")),
        });
        return;
      }

      // Rescheduled (proposed) — a NEW or CHANGED reschedulePendingTime.
      // 2026-09-09 (live-caught, second pass): this used to detect a
      // reschedule via a scheduledTime CHANGE — but that meant the write
      // itself changed the confirmed meeting time before the other party
      // ever agreed to it. The site now stores a proposal separately
      // (reschedulePendingTime) and leaves scheduledTime untouched until
      // explicitly accepted, so detect the proposal itself instead. Notify
      // whichever party did NOT make this proposal — rescheduledBy is
      // stamped by whichever side's UI wrote it (PostsPage.tsx /
      // JobBoard.tsx); the site's Reschedule/Propose new time actions are
      // the only writers of this field.
      if (
        after.reschedulePendingTime &&
        before?.reschedulePendingTime !== after.reschedulePendingTime
      ) {
        const { parseScheduledTimeMs } = await import('../utils/scheduledTime');
        const displayTime = new Date(parseScheduledTimeMs(String(after.reschedulePendingTime ?? ''))).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        if (after.rescheduledBy === 'caregiver' && after.clientId) {
          await addNotification(after.clientId, {
            type: 'interview_rescheduled',
            title: 'New Time Proposed',
            body: `${after.caregiverName || 'Your caregiver'} proposed a new time: ${displayTime}. Please confirm.`,
            data: { interviewId: context.params.interviewId },
          });
          // reschedule_interview (mcp/server.ts) already texts this direction
          // itself and stamps rescheduledViaAgent — skip to avoid a double text.
          if (!after.rescheduledViaAgent) {
            await notifyClientByText(after.clientId,
              `${after.caregiverName || 'Your caregiver'} proposed a new interview time: ${displayTime}. Reply CONFIRM, or suggest another time.`,
              { ...noticedInterview(context.params.interviewId),
                ...parkDecision(parkedDecision("interview_proposal", context.params.interviewId, `a new interview time ${after.caregiverName || 'your caregiver'} proposed (${displayTime})`, "client")) });
          }
        } else if (after.caregiverId) {
          await addNotification(after.caregiverId, {
            type: 'interview_rescheduled',
            title: 'New Time Proposed',
            body: `${after.clientName || 'The family'} proposed a new time: ${displayTime}. Please confirm.`,
            data: { interviewId: context.params.interviewId },
          });
          if (!after.rescheduledViaAgent) {
            await notifyCaregiverByText(after.caregiverId,
              `${after.clientName || 'The family'} proposed a new interview time: ${displayTime}. Reply CONFIRM, or PROPOSE another time.`,
              { ...noticedInterview(context.params.interviewId),
                ...parkDecision(parkedDecision("interview_proposal", context.params.interviewId, `a new interview time ${after.clientName || 'the family'} proposed (${displayTime})`, "caregiver")) });
          }
        }
        return;
      }

      // Reschedule ACCEPTED — the pending proposal is gone and the real
      // scheduledTime actually moved: notify whoever originally proposed it
      // (before.rescheduledBy, since rescheduledBy is cleared on accept)
      // that their proposed time is now confirmed.
      if (
        before?.reschedulePendingTime &&
        !after.reschedulePendingTime &&
        after.scheduledTime &&
        before.scheduledTime !== after.scheduledTime
      ) {
        const { parseScheduledTimeMs } = await import('../utils/scheduledTime');
        const displayTime = new Date(parseScheduledTimeMs(String(after.scheduledTime ?? ''))).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
          weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        if (before.rescheduledBy === 'caregiver' && after.caregiverId) {
          await addNotification(after.caregiverId, {
            type: 'interview_rescheduled',
            title: 'Time Confirmed',
            body: `${after.clientName || 'The family'} confirmed the new interview time: ${displayTime}.`,
            data: { interviewId: context.params.interviewId },
          });
          // accept_interview_reschedule (mcp/server.ts) already texts this
          // direction itself and stamps acceptedRescheduleViaAgent — skip to
          // avoid a double text. rescheduledViaAgent itself is already
          // cleared by the accept write, so it can't be checked here.
          if (!after.acceptedRescheduleViaAgent) {
            await notifyCaregiverByText(after.caregiverId,
              `${after.clientName || 'The family'} confirmed the new interview time: ${displayTime}.`);
          }
        } else if (after.clientId) {
          await addNotification(after.clientId, {
            type: 'interview_rescheduled',
            title: 'Time Confirmed',
            body: `${after.caregiverName || 'Your caregiver'} confirmed the new interview time: ${displayTime}.`,
            data: { interviewId: context.params.interviewId },
          });
          if (!after.acceptedRescheduleViaAgent) {
            await notifyClientByText(after.clientId,
              `${after.caregiverName || 'Your caregiver'} confirmed the new interview time: ${displayTime}.`);
          }
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
        // The family's ONE text for this event is the confirmed-time + Meet link
        // message from interviewLinkTrigger.ts (it fires on the same accept and
        // retries until delivered). Texting here too made it two or three.
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
      // The ONE text for this event (same words as the bell). The Apply flow
      // (agents/caregiverJobFlows.ts) deliberately does not send its own, and the second
      // LLM-worded trigger that used to fire on the same create was removed.
      await notifyClientByText(data.clientId,
        `${data.caregiverName || 'A caregiver'} applied to your post: "${data.jobTitle || 'your care request'}". Want me to pull up their profile?`);
    } catch (err) {
      console.error('[onJobApplicationCreate] error:', err);
    }
  });

// Application outcome → notify the caregiver (founder, 2026-09-27: "we do the
// notification. no details though. something simple"). The family's Posts
// page writes `rejected` ("Applicant declined") and `accepted` (when they send
// a booking after the interview); the caregiver's My Applications tab flips
// the badge to "Declined by client" / "Accepted" but nothing told them —
// no bell, no text. One bell entry + one text per outcome, same words as the
// tab's badge, nothing more. A withdraw (the caregiver's own action) is silent.
export const onJobApplicationStatusChange = functions.firestore
  .document('job_applications/{applicationId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();
    if (!after?.caregiverId || before?.status === after.status) return;
    const title = after.jobTitle ? `"${after.jobTitle}"` : 'a job';
    let bell: { type: string; title: string; body: string } | null = null;
    if (after.status === 'accepted') {
      bell = { type: 'job_application_accepted', title: 'Application accepted', body: `Your application for ${title} was accepted.` };
    } else if (after.status === 'rejected') {
      bell = { type: 'job_application_declined', title: 'Application declined', body: `Your application for ${title} was declined by the family.` };
    }
    if (!bell) return;
    try {
      await addNotification(after.caregiverId, { ...bell, data: { applicationId: context.params.applicationId, jobId: after.jobId } });
      await notifyCaregiverByText(after.caregiverId, bell.body);
    } catch (err) {
      console.error('[onJobApplicationStatusChange] error:', err);
    }
  });

// ── booking_requests ────────────────────────────────────────────────────────
// New request → notify caregiver
// Accepted → text client (in-app bell is written by onBookingAccepted in
//   shiftGenerator.ts; that trigger never texted, so a website-button accept
//   reached the family's phone nowhere — live-caught 2026-09-14)
// Declined → notify client
// Cancelled → notify caregiver
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
        // agentTaskId only exists on legacy docs from the retired Evia-only
        // booking pipeline (removed 2026-09-17), which texted the caregiver its
        // own YES/NO offer. Every booking created now — website or Evia — is a
        // plain booking_requests doc and gets this one text.
        if (!after.agentTaskId) {
          await notifyCaregiverByText(after.caregiverId,
            bookingRequestText(context.params.bookingId, after as Record<string, unknown>, `${after.clientName || 'A client'} ${isResend ? 'resent their' : 'sent you a'} booking request.`),
            parkDecision(parkedDecision("booking_request", context.params.bookingId, `a booking request from ${after.clientName || 'a family'}`, "caregiver", Date.now(), after.clientName)));
        }
        return;
      }

      if (statusBefore === statusAfter) return;

      // Resent (declined/cancelled → pending again, isResend) → notify the
      // caregiver. 2026-09-16: the site's own Resend button (PostsPage.tsx)
      // updates the existing doc, so it never hit the "new doc" branch above
      // — the caregiver was never told. Same wording as a resent new doc.
      if (statusAfter === 'pending' && after.isResend === true && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'booking_request',
          title: 'Booking Request Resent',
          body: `${after.clientName || 'A client'} resent their booking request.`,
          data: { bookingId: context.params.bookingId },
        });
        if (!after.agentTaskId) {
          await notifyCaregiverByText(after.caregiverId,
            bookingRequestText(context.params.bookingId, after as Record<string, unknown>, `${after.clientName || 'A client'} resent their booking request.`),
            parkDecision(parkedDecision("booking_request", context.params.bookingId, `a booking request from ${after.clientName || 'a family'}`, "caregiver", Date.now(), after.clientName)));
        }
        return;
      }

      // Accepted → text client. An Evia-negotiated booking (agentTaskId set)
      // was accepted through the retired shiftOffer.ts (removed 2026-09-28), which texted the family
      // "Great news — X accepted!" itself — only a website-button accept has
      // nothing else reaching the family's phone.
      if (statusAfter === 'accepted' && after.clientId && !after.agentTaskId) {
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} accepted your booking request — the visits are on your My Bookings page.`);
      }

      // Declined → notify client
      if (statusAfter === 'declined' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'booking_declined',
          title: 'Booking Declined',
          body: `${after.caregiverName || 'Your caregiver'} is unable to accept your booking request.`,
          data: { bookingId: context.params.bookingId },
        });
        // Same reasoning as above — an Evia-negotiated decline already texts
        // the family from the retired shiftOffer.ts (removed 2026-09-28).
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
        // The tab's schedule-change card, whole, in the notice (same rule as booking requests).
        await notifyCaregiverByText(after.caregiverId,
          `${isOneDay
            ? `${after.clientName || 'A family'} would like to add a visit on ${formatDateForDisplay(after.startDate)}.`
            : `${after.clientName || 'A family'} would like to add ${days} to your regular schedule.`}\n\n${
            amendmentCardLines({ ...(after as Record<string, unknown>), id: context.params.amendmentId } as Parameters<typeof amendmentCardLines>[0]).join("\n")
          }\n\nReply ACCEPT or DECLINE.`,
          parkDecision(parkedDecision("amendment", context.params.amendmentId, `a schedule change from ${after.clientName || 'a family'}`, "caregiver", Date.now(), after.clientName)));
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

    const shiftId = context.params.shiftId;

    // In-progress activity — tasks checked off / visit notes added on the
    // caregiver's pages — reaches the family as ONE grouped text per burst
    // (familyVisitUpdates.ts). Status is unchanged on these writes, so this
    // must run before the statusBefore === statusAfter return below.
    if (before?.status === 'in-progress' && after.status === 'in-progress') {
      const handled = await recordVisitProgress(change.after.ref, before, after, notifyClientByText);
      if (handled) return;
    }

    // Rescheduled (proposed) — a NEW or CHANGED reschedulePendingDate, same
    // pattern as video_interviews' reschedulePendingTime (see
    // notificationTriggers.ts's onVideoInterviewWrite): the real date/
    // startTime/endTime never change on this write, so status is untouched
    // and would otherwise be swallowed by the statusBefore===statusAfter
    // check below — these two branches must run before that return.
    if (
      after.reschedulePendingDate &&
      (before?.reschedulePendingDate !== after.reschedulePendingDate ||
       before?.reschedulePendingStartTime !== after.reschedulePendingStartTime ||
       before?.reschedulePendingEndTime !== after.reschedulePendingEndTime)
    ) {
      const displayTime = new Date(after.reschedulePendingDate + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      }) + `, ${formatHHMMForDisplay(after.reschedulePendingStartTime)}${after.reschedulePendingEndTime ? `–${formatHHMMForDisplay(after.reschedulePendingEndTime)}` : ''}`;
      if (after.rescheduledBy === 'caregiver' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'shift_rescheduled',
          title: 'New Time Proposed',
          body: `${after.caregiverName || 'Your caregiver'} proposed moving this visit to ${displayTime}. Please confirm.`,
          data: { shiftId },
        });
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} proposed moving this visit to ${displayTime}. Reply here to confirm or suggest another time.`);
      } else if (after.rescheduledBy === 'client' && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'shift_rescheduled',
          title: 'New Time Proposed',
          body: `${after.clientName || 'The family'} proposed moving this visit to ${displayTime}. Please confirm.`,
          data: { shiftId },
        });
        await notifyCaregiverByText(after.caregiverId,
          `${after.clientName || 'The family'} proposed moving this visit to ${displayTime}. Reply here to confirm or suggest another time.`);
      }
      return;
    }

    // Reschedule ACCEPTED — the pending proposal is gone and the real date/
    // time actually moved: notify whoever originally proposed it (before.
    // rescheduledBy, since rescheduledBy is cleared on accept) that their
    // proposed time is now confirmed.
    if (
      before?.reschedulePendingDate &&
      !after.reschedulePendingDate &&
      (before.date !== after.date || before.startTime !== after.startTime || before.endTime !== after.endTime)
    ) {
      const displayTime = new Date(after.date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      }) + `, ${formatHHMMForDisplay(after.startTime)}${after.endTime ? `–${formatHHMMForDisplay(after.endTime)}` : ''}`;
      if (before.rescheduledBy === 'caregiver' && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'shift_rescheduled',
          title: 'Time Confirmed',
          body: `${after.clientName || 'The family'} confirmed the new visit time: ${displayTime}.`,
          data: { shiftId },
        });
        await notifyCaregiverByText(after.caregiverId,
          `${after.clientName || 'The family'} confirmed the new visit time: ${displayTime}.`);
      } else if (before.rescheduledBy === 'client' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'shift_rescheduled',
          title: 'Time Confirmed',
          body: `${after.caregiverName || 'Your caregiver'} confirmed the new visit time: ${displayTime}.`,
          data: { shiftId },
        });
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} confirmed the new visit time: ${displayTime}.`);
      }
      return;
    }

    // Reschedule DECLINED (or withdrawn) — the pending proposal is gone but
    // the real date/time did NOT change (that's what distinguishes this from
    // the ACCEPTED branch above). Notify whoever originally proposed it
    // (before.rescheduledBy, cleared on this write too) that the original
    // time stands, so they're not left silently wondering why their
    // proposal disappeared.
    if (
      before?.reschedulePendingDate &&
      !after.reschedulePendingDate &&
      before.date === after.date && before.startTime === after.startTime && before.endTime === after.endTime
    ) {
      const displayTime = new Date(after.date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      }) + `, ${formatHHMMForDisplay(after.startTime)}${after.endTime ? `–${formatHHMMForDisplay(after.endTime)}` : ''}`;
      if (before.rescheduledBy === 'caregiver' && after.caregiverId) {
        await addNotification(after.caregiverId, {
          type: 'shift_rescheduled',
          title: 'Time Change Declined',
          body: `${after.clientName || 'The family'} kept the original visit time: ${displayTime}.`,
          data: { shiftId },
        });
        await notifyCaregiverByText(after.caregiverId,
          `${after.clientName || 'The family'} isn't able to move the visit — it's staying at ${displayTime}.`);
      } else if (before.rescheduledBy === 'client' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'shift_rescheduled',
          title: 'Time Change Declined',
          body: `${after.caregiverName || 'Your caregiver'} kept the original visit time: ${displayTime}.`,
          data: { shiftId },
        });
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} isn't able to move the visit — it's staying at ${displayTime}.`);
      }
      return;
    }

    if (before.status === after.status) return;

    const fmtDate = after.date
      ? ` on ${new Date(after.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : '';

    // ── 1. In-app notifications on status change ────────────────────────────
    try {
      // Caregiver started shift → notify client (parity with onAppointmentUpdated's
      // arrival ping — start_shift/complete_shift never message the family
      // themselves, so this trigger is the only place this text comes from).
      // (The "extra visit" branch — a caregiver answering a pending shift —
      // was removed 2026-09-28: nothing creates a pending shift any more;
      // Request Visit writes a booking_amendments doc instead.)
      if (after.status === 'in-progress' && after.clientId) {
        await addNotification(after.clientId, {
          type: 'shift_started',
          title: 'Shift Started',
          body: `${after.caregiverName || 'Your caregiver'} has started your visit.`,
          data: { shiftId: context.params.shiftId },
        });
        // The Start button has no location check on either side — the system knows
        // the visit started, not that anyone arrived (2026-09-17).
        await notifyClientByText(after.clientId, `${after.caregiverName || 'Your caregiver'} started the visit.`);
      } else if (after.status === 'completed' && after.clientId) {
        // Caregiver ended shift → notify client
        await addNotification(after.clientId, {
          type: 'shift_completed',
          title: 'Shift Completed',
          body: `${after.caregiverName || 'Your caregiver'} has completed your visit.`,
          data: { shiftId: context.params.shiftId },
        });
        // The Past Booking card in words (tasks done / not done per recipient,
        // the visit log, the closing note, what happens next). Anything still
        // waiting in the grouped-update window rides along first. (The old
        // "care journal entry will be posted shortly" promised something nothing
        // wrote any more — removed 2026-09-17.)
        const pendingItems = queuedItems(after);
        let completionText = (pendingItems.length ? buildFamilyUpdateText(after.caregiverName, pendingItems) + '\n\n' : '') + buildVisitCompletionText(after);
        // First completed visit with this caregiver and no review yet → the one
        // review prompt (founder, 2026-09-19): dashboard card + bell on the site,
        // one closing line here; a star reply starts reviewFlow.ts. Never again
        // for the same caregiver — the button stays on the profile page.
        if (after.caregiverId && await isFirstCompletedVisit(after.clientId, after.caregiverId, context.params.shiftId).catch(() => false)) {
          completionText += '\n\n' + firstVisitReviewPromptLine(after.caregiverName);
          await addNotification(after.clientId, firstVisitReviewNotification(after.caregiverName, after.caregiverId, context.params.shiftId));
          await setReviewPromptAnchor(after.clientId, after.caregiverId, String(after.caregiverName || '')).catch(() => {});
        }
        await notifyClientByText(after.clientId, completionText);
        if (pendingItems.length || after.familyUpdateQueuedAt) {
          await change.after.ref.update({
            familyUpdateQueue: admin.firestore.FieldValue.delete(),
            familyUpdateQueuedAt: admin.firestore.FieldValue.delete(),
          }).catch(() => {});
        }
      } else if (after.status === 'needs_replacement' && after.clientId) {
        // Caregiver cancelled with < 24h notice (site rule: CaregiverBookingsPage's
        // handleCancelShift / ClientVisitsPage's caregiver-side cancel both set
        // needs_replacement instead of cancelled for an urgent shift) — this is
        // what makes the Find Replacement / Skip buttons appear on the real My
        // Bookings page. Family gets a text pointing at the same replacement
        // flow (get_callout_backups/select_callout_backup) instead of silence.
        const whenText = fmtDate || ' for an upcoming date';
        await addNotification(after.clientId, {
          type: 'shift_needs_replacement',
          title: 'Visit Needs a Replacement',
          body: `${after.caregiverName || 'Your caregiver'} cancelled the visit${whenText} — find a replacement or skip it.`,
          data: { shiftId: context.params.shiftId },
        });
        await notifyClientByText(after.clientId,
          `${after.caregiverName || 'Your caregiver'} cancelled the visit${whenText}. Text me to find a replacement, or to skip that visit.`);
      } else if (after.status === 'cancelled' && after.supersededByBookingId) {
        // The original visit closed out because a REPLACEMENT was accepted
        // (shiftGenerator writes cancelled + supersededByBookingId). The family
        // already got "X accepted your booking request" — a second "cancelled
        // the visit" text here read as a new cancellation (live, 2026-09-28).
      } else if (after.status === 'cancelled' && !after.bulkCancelled) {
        // Cancelled — direction depends on who cancelled. (fmtDate is hoisted
        // above and already includes the " on <date>" prefix, or '' if no date.)
        const whenText = fmtDate || ' for an upcoming date';

        if (after.cancelledBy === 'caregiver' && after.clientId) {
          // Caregiver cancelled, but with enough notice (site rule: > 24h) that
          // no replacement is needed — a plain heads-up, no call to action.
          await addNotification(after.clientId, {
            type: 'shift_cancelled',
            title: 'Shift Cancelled',
            body: `${after.caregiverName || 'Your caregiver'} cancelled the shift${whenText}.`,
            data: { shiftId: context.params.shiftId },
          });
          await notifyClientByText(after.clientId,
            `${after.caregiverName || 'Your caregiver'} cancelled the visit${whenText}.`);
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
