import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { notifyAdminBookingConfirmed } from "../notifications";
import { logBookingCreated } from "../observability/auditLog";
import { closeJobPost } from "../triggers/jobNotifications";
import { generateCaraMessage } from "../utils/caraMessage";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { createShiftOffer } from "./shiftOffer";
import { getAppUrl } from "../config/appUrl";

async function hasConflict(
  caregiverId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  // Checks the caregiver's real, already-confirmed schedule (shifts) rather
  // than appointments — confirmed bookings live in shifts now (see
  // writeConfirmedShifts below); this is also more accurate than checking
  // other in-flight negotiations.
  const snap = await db.collection("shifts")
    .where("caregiverId", "==", caregiverId)
    .where("date", "==", date)
    .where("status", "in", ["scheduled", "in-progress"])
    .get();
  return snap.docs.some((doc) => {
    const d = doc.data();
    return d.startTime < endTime && d.endTime > startTime;
  });
}

const db = admin.firestore();

interface BookingAppointment {
  date:          string;
  startTime:     string;
  endTime:       string;
  durationHours: number;
}

export interface BookingTask {
  type:                  "booking_confirmation" | "cancellation_confirmation" | "rebook_confirmation";
  clientId:              string;
  clientPhone:           string;
  caregiverId:           string;
  caregiverName:         string;
  appointments:          BookingAppointment[];
  totalCost:             number;
  hourlyRate?:           number;
  status:                "awaiting_approval" | "approved" | "declined" | "expired";
  humanApproved:         boolean;
  expiresAt:             string;
  createdAt:             string;
  agentTaskId?:          string;
  bookingRequestId?:     string;
  isEmergencyReplacement?: boolean;
  // Multi-recipient attribution (2026-07-16) — only stamped when the household
  // has 2+ care recipients; absent = the household's sole recipient (fail-soft).
  recipientName?:        string;
  recipientKey?:         string;
  // Job/interview linkage (2026-08-30) — only stamped when this booking follows
  // a job-post application + interview, matching PostsPage.tsx's handleSendBooking
  // (which stamps jobId/jobTitle/interviewId on booking_requests and flips the
  // application to 'accepted'). Absent for a direct/matching-flow booking.
  jobId?:                string;
  jobTitle?:             string;
  interviewId?:          string;
  applicationId?:        string;
}

// Writes the real, per-date `shifts` docs once a booking is truly confirmed —
// called from executeBookings' no-caregiver-phone fallback (immediately) and
// from shiftOffer.ts's onOfferAccepted (once the caregiver replies YES).
// Matches the exact shape the website's own safety-net writer produces
// (Schedule.tsx's generateMissingShifts) rather than trusting the site's
// weekly-pattern generator, which can't safely represent Evia's often-
// irregular date lists.
export async function writeConfirmedShifts(
  bookingRequestId: string,
  task: BookingTask,
  clientName: string,
  seniorName: string | null,
  address: string | null,
): Promise<void> {
  const cgSnap = await db.collection("caregivers").doc(task.caregiverId).get();
  const cgData = cgSnap.data() ?? {};
  const caregiverPhotoURL = (cgData.profilePhoto ?? cgData.photoURL ?? cgData.photo ?? null) as string | null;

  const batch = db.batch();
  for (const appt of task.appointments) {
    const ref = db.collection("shifts").doc();
    batch.set(ref, {
      clientId:            task.clientId,
      clientName,
      caregiverId:         task.caregiverId,
      caregiverName:       task.caregiverName,
      caregiverPhotoURL,
      status:              "scheduled",
      address:             address ?? "",
      rate:                task.hourlyRate ?? null,
      paymentMethod:       "credit",
      notes:               "",
      careRecipients:      seniorName ? [{ name: seniorName }] : [],
      ...(task.recipientKey ? { recipientKey: task.recipientKey } : {}),
      bookingRequestId,
      recurringWeekly:     false,
      tasksCompleted:      [],
      date:                appt.date,
      startTime:           appt.startTime,
      endTime:             appt.endTime,
      createdAt:           admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

export async function executeBookings(taskId: string, clientPhone: string): Promise<void> {
  const taskRef = db.collection("agent_tasks").doc(taskId);

  // Atomically claim the task — prevents duplicate execution from concurrent YES replies.
  // Transitions: awaiting_approval → processing (success) | expired (timed out) | no-op (already claimed).
  // We return from the transaction (instead of assigning to outer let-variables)
  // so TS narrows the result correctly downstream.
  const txResult = await db.runTransaction(async (t): Promise<{ task: BookingTask; didExpire: boolean } | null> => {
    const snap = await t.get(taskRef);
    if (!snap.exists) throw new Error(`agent_tasks/${taskId} not found`);
    const data = snap.data() as BookingTask;

    if (data.status !== "awaiting_approval") return null; // Already claimed or processed — no-op

    if (new Date(data.expiresAt) < new Date()) {
      t.update(taskRef, { status: "expired" });
      return { task: data, didExpire: true };
    }

    t.update(taskRef, { status: "processing" });
    return { task: data, didExpire: false };
  });

  if (!txResult) return; // Already processed by a concurrent caller
  const { task, didExpire } = txResult;

  if (didExpire) {
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (sessionSnap.exists) {
      const timeoutMsg = await generateCaraMessage({
        audience: "family",
        context:  `The booking for ${task.caregiverName} has timed out. Bookings expire after 2 hours to keep availability current. Offer to restart it and tell them to reply YES to pick up where they left off.`,
        fallback: `The booking for ${task.caregiverName} timed out. Those expire after 2 hours to keep availability current.\n\nWant me to start it again? Reply YES and I'll pull up where we left off.`,
        maxTokens: 80,
      });
      await sendMessage(sessionSnap.data()!.chatId, timeoutMsg);
    }
    return;
  }

  const now = new Date().toISOString();

  // Check for scheduling conflicts before writing anything
  for (const appt of task.appointments) {
    if (await hasConflict(task.caregiverId, appt.date, appt.startTime, appt.endTime)) {
      await taskRef.update({ status: "conflict_detected" });

      await db.collection("admin_alerts").add({
        type:          "booking_conflict",
        caregiverId:   task.caregiverId,
        caregiverName: task.caregiverName,
        clientPhone,
        date:          appt.date,
        startTime:     appt.startTime,
        endTime:       appt.endTime,
        createdAt:     now,
        resolved:      false,
      });

      // Mark this caregiver as rejected so matching skips them in the retry
      await db.collection("agent_sessions").doc(clientPhone).update({
        rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(task.caregiverId),
      }).catch(() => {});

      // Set an active goal so Evia carries booking context through the re-match.
      // If this fails, reset the task to awaiting_approval so the family can retry.
      const { setActiveGoal } = await import("./qaAgent");
      const goalSet = await setActiveGoal(
        clientPhone,
        "booking",
        `Rebook after conflict with ${task.caregiverName} on ${appt.date}`,
        { originalDate: appt.date, startTime: appt.startTime, endTime: appt.endTime, durationHours: appt.durationHours }
      ).then(() => true).catch((err) => {
        console.error("bookingExecutor: setActiveGoal failed", err);
        return false;
      });
      if (!goalSet) {
        await taskRef.update({ status: "awaiting_approval" }).catch(() => {});
        return;
      }

      const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
      if (sessionSnap.exists) {
        const sessionData = sessionSnap.data()!;
        const conflictMsg = await generateCaraMessage({
          audience: "family",
          context:  `${task.caregiverName} has a scheduling conflict and already has a visit at that time on ${appt.date}. Let the family know and tell them you're finding someone else for that date.`,
          fallback: `${task.caregiverName} already has a visit at that time — finding someone else for ${appt.date}.`,
          maxTokens: 80,
        });
        await sendMessage(sessionData.chatId, conflictMsg);
        // Auto-retry matching immediately — family sees results without replying
        const { runMatchingForClient } = await import("./matchingAgent");
        await runMatchingForClient(clientPhone, sessionData.chatId, sessionData, sessionData).catch((err) =>
          console.error("bookingExecutor: conflict re-match failed", err)
        );
      }
      return;
    }
  }

  // Idempotency guard: if this invocation is retried after a partial commit,
  // a booking_requests doc is already linked via agentTaskId on the first
  // attempt — skip if found. Reset the task to the matching in-flight status.
  const existingBookingReq = await db.collection("booking_requests")
    .where("agentTaskId", "==", taskId)
    .limit(1)
    .get();
  if (!existingBookingReq.empty) {
    await taskRef.update({ status: "pending_caregiver_confirmation", humanApproved: true }).catch(() => {});
    return;
  }

  // Fetched before the write so the booking_requests doc carries the display
  // names the webapp and notification triggers read (clientName/seniorName).
  const [caregiverSnapForOffer, clientSnapForOffer] = await Promise.all([
    db.collection("caregivers").doc(task.caregiverId).get(),
    db.collection("users").doc(task.clientId).get(),
  ]);
  const offerClientName = (clientSnapForOffer.data()?.name as string | undefined) || undefined;
  const offerClientData = clientSnapForOffer.data() ?? {};
  const offerAddress = [offerClientData.street, offerClientData.city, offerClientData.state, offerClientData.zipCode]
    .filter(Boolean).join(", ") || null;
  // Hoisted above the write so the booking_requests doc carries the recipient
  // display name (task.recipientName from a multi-recipient booking wins;
  // else the primary).
  const offerSeniorName = task.recipientName
    ?? clientSnapForOffer.data()?.seniorName
    ?? (clientSnapForOffer.data()?.senior as { name?: string } | undefined)?.name
    ?? null;

  // Write ONE booking_requests doc — the site's own real booking shape
  // (matches PostsPage.tsx's handleSendBooking), not a per-date appointments
  // doc. `schedule` is deliberately left empty: Evia's dates are often
  // irregular and don't fit the site's weekly dayShiftTimes pattern, and the
  // site's own shift-generator no-ops safely on an empty schedule — the real
  // shifts docs get written directly by writeConfirmedShifts() once the
  // caregiver actually confirms (see shiftOffer.ts's onOfferAccepted), or
  // immediately below for the no-phone fallback. Family approval does NOT
  // confirm the visit: the caregiver must accept the shift offer first, so
  // this is written status:'pending' — the exact status a website-sent
  // booking starts at too.
  const bookingRequestRef = db.collection("booking_requests").doc();
  const batch = db.batch();
  batch.set(bookingRequestRef, {
    clientId:      task.clientId,
    clientName:    offerClientName ?? "",
    caregiverId:   task.caregiverId,
    caregiverName: task.caregiverName,
    ...(offerAddress ? { address: offerAddress } : {}),
    ...(offerSeniorName ? { seniorName: offerSeniorName } : {}),
    ...(task.recipientKey ? { recipientKey: task.recipientKey } : {}),
    ...(task.jobId ? { jobId: task.jobId } : {}),
    ...(task.jobTitle ? { jobTitle: task.jobTitle } : {}),
    ...(task.interviewId ? { interviewId: task.interviewId } : {}),
    rate:          task.hourlyRate ?? null,
    paymentMethod: "credit",
    notes:         "",
    status:        "pending",
    isResend:      false,
    agentTaskId:   taskId,
    createdAt:     now,
  });
  batch.update(taskRef, { status: "pending_caregiver_confirmation", humanApproved: true, approvedAt: now, bookingRequestId: bookingRequestRef.id });
  await batch.commit();

  // Matches handleSendBooking's immediate side effect on the website: sending
  // the booking marks the caregiver's application accepted right away, not
  // once they later confirm the visit itself.
  if (task.applicationId) {
    await db.collection("job_applications").doc(task.applicationId).update({
      status:     "accepted",
      acceptedAt: now,
    }).catch(() => {});
  }

  // Send the caregiver a YES/NO shift offer. Confirmation, family notification,
  // and payment setup all happen in finalizeAcceptedBooking() once they accept.
  const offerCgPhone = caregiverSnapForOffer.data()?.phone as string | undefined;

  if (!offerCgPhone) {
    // Can't reach the caregiver over SMS — fall back to immediate confirmation
    // (legacy behavior) and flag for admin follow-up so a human verifies coverage.
    await db.collection("admin_alerts").add({
      type:          "shift_offer_undeliverable",
      caregiverId:   task.caregiverId,
      caregiverName: task.caregiverName,
      clientPhone,
      agentTaskId:   taskId,
      createdAt:     now,
      resolved:      false,
    }).catch(() => {});
    await bookingRequestRef.update({ status: "accepted" });
    await writeConfirmedShifts(bookingRequestRef.id, task, offerClientName ?? "", offerSeniorName, offerAddress);
    await taskRef.update({ status: "approved" });
    await finalizeAcceptedBooking(taskId, clientPhone);
    return;
  }

  const offerFirstAppt = task.appointments[0];
  const offerVisitPay  = ((caregiverSnapForOffer.data()?.hourlyRate ?? 20) * offerFirstAppt.durationHours).toFixed(2);
  const offerClientLabel = offerSeniorName ? `with ${offerSeniorName}` : "with a client";
  const offerLines = task.appointments.map((a) => `${a.date} · ${a.startTime}–${a.endTime}`).join("\n");
  const offerSummary = `New booking ${offerClientLabel}: ${task.appointments.length} visit${task.appointments.length === 1 ? "" : "s"} starting ${offerFirstAppt.date} at ${offerFirstAppt.startTime}, $${offerVisitPay} per visit`;

  await createShiftOffer({
    kind:           "booking",
    caregiverId:    task.caregiverId,
    caregiverName:  task.caregiverName,
    caregiverPhone: offerCgPhone,
    clientId:       task.clientId,
    clientPhone,
    // No appointment doc refs exist yet — the "booking" kind resolves via
    // agentTaskId instead (agent_tasks carries bookingRequestId + the real
    // appointments[] dates; writeConfirmedShifts() reads both once accepted).
    appointmentIds: [],
    agentTaskId:    taskId,
    summary:        offerSummary,
    offerMessage:
      `New booking request ${offerClientLabel}!\n\n` +
      `${offerLines}\n\n` +
      `$${offerVisitPay} per visit, paid automatically after each one.`,
  });

  // Tell the family the request is out — NOT confirmed yet.
  const waitingSessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
  if (waitingSessionSnap.exists) {
    const waitingMsg = await generateCaraMessage({
      audience: "family",
      context:  `You just sent ${task.caregiverName} the booking request. Tell the family you've asked ${task.caregiverName} to confirm and you'll text the moment they accept (usually fast). Do NOT say the booking is confirmed yet.`,
      fallback: `I've sent the request to ${task.caregiverName} — I'll text you the moment they confirm (usually pretty quick).`,
      maxTokens: 80,
    });
    await sendMessage(waitingSessionSnap.data()!.chatId, waitingMsg);
  }
  return;
}

// ── Post-acceptance finalization ───────────────────────────────────────────────
// Runs AFTER the caregiver accepts the shift offer (shiftOffer.ts) — or, when the
// caregiver has no phone on file, immediately as a legacy fallback. Owns the
// family confirmation message, recurring-care offer, payment setup nudge, job
// post closure, audit logging, and admin notification.

export async function finalizeAcceptedBooking(taskId: string, clientPhone: string): Promise<void> {
  const taskSnap = await db.collection("agent_tasks").doc(taskId).get();
  if (!taskSnap.exists) {
    console.error(`finalizeAcceptedBooking: agent_tasks/${taskId} not found`);
    return;
  }
  const task = taskSnap.data() as BookingTask;

  await closeJobPost(task.clientId).catch((err) =>
    console.error("[executeBookings] closeJobPost failed:", err)
  );

  logBookingCreated(
    task.clientId,
    task.caregiverId,
    task.appointments.map((a) => a.date)
  ).catch(() => {});

  notifyAdminBookingConfirmed({
    taskId:           taskId,
    caregiverName:    task.caregiverName,
    clientPhone:      clientPhone,
    appointmentCount: task.appointments.length,
    totalCost:        task.totalCost,
  }).catch((err) => console.error("notifyAdminBookingConfirmed error:", err));

  // This caregiver is now on the family's care team — register their name so the
  // persona-shift detector treats future mentions as a known caregiver, not a
  // different care recipient.
  const { addKnownNames } = await import("../utils/knownNames");
  await addKnownNames(clientPhone, [task.caregiverName]);

  const appUrl = getAppUrl();

  // Confirm to family
  const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
  if (sessionSnap.exists) {
    const lines = task.appointments.map((a) =>
      `${a.date} · ${a.startTime}–${a.endTime} · ${task.caregiverName}`
    ).join("\n");

    const bookingConfirmOpener = await generateCaraMessage({
      audience: "family",
      context:  `${task.caregiverName} just accepted the booking — ${task.appointments.length} ${task.appointments.length === 1 ? "visit" : "visits"} confirmed for a total of $${task.totalCost.toFixed(2)}. Write a warm 1-sentence opening celebrating that the booking is confirmed.`,
      fallback: "All booked! Here's your confirmed schedule:",
      maxTokens: 80,
    });
    await sendMessage(sessionSnap.data()!.chatId,
      `${bookingConfirmOpener}\n\n` +
      `${lines}\n\n` +
      `I'll text you when ${task.caregiverName} arrives for the first visit.\n` +
      `View your schedule: ${appUrl}/client/calendar\n\n` +
      `Any questions? Just text me.`
    );

    // The hire/booking goal is complete — close it explicitly so a durable
    // "find a caregiver" goal doesn't linger and resurface stale context.
    await import("./qaAgent")
      .then((m) => m.clearActiveGoal(clientPhone))
      .catch(() => {});

    // Ask about recurring care — only for single-visit (one-time) bookings
    if (task.appointments.length === 1) {
      const firstAppt = task.appointments[0];
      const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(firstAppt.date).getDay()];
      const schedDesc = `${dayOfWeek}s ${firstAppt.startTime}–${firstAppt.endTime}`;

      // Write session flag BEFORE sending the message to avoid a race where a fast
      // YES reply arrives before the Firestore write lands.
      await db.collection("agent_sessions").doc(clientPhone).update({
        awaitingRecurringConfirmation: true,
        awaitingRecurringConfirmationSetAt: new Date().toISOString(),
        pendingRecurringSchedule: {
          caregiverId:   task.caregiverId,
          caregiverName: task.caregiverName,
          ...(task.recipientName ? { seniorName: task.recipientName } : {}),
          ...(task.recipientKey  ? { recipientKey: task.recipientKey } : {}),
          ...(task.bookingRequestId ? { bookingRequestId: task.bookingRequestId } : {}),
          days:          [dayOfWeek],
          startTime:     firstAppt.startTime,
          endTime:       firstAppt.endTime,
          durationHours: firstAppt.durationHours,
          hourlyRate:    (() => {
            const totalHours = task.appointments.reduce((s, a) => s + a.durationHours, 0);
            return totalHours > 0 ? (task.hourlyRate ?? task.totalCost / totalHours) : 20;
          })(),
        },
      }).catch(() => {});

      const recurringOfferMsg = await generateCaraMessage({
        audience: "family",
        context:  `The family just booked a single visit with ${task.caregiverName} on ${schedDesc}. Offer to set it up as a weekly recurring schedule — same time every week — and explain you'll handle the bookings automatically. Tell them to reply YES to set it up, or NO to keep it one visit at a time.`,
        fallback: `Want me to set this up as a weekly recurring schedule — ${schedDesc} every week with ${task.caregiverName}? I'll handle the bookings automatically.\n\nReply YES to set it up, or NO to keep it one visit at a time.`,
        maxTokens: 80,
      });
      await sendMessage(sessionSnap.data()!.chatId, recurringOfferMsg);
    }

    // Post-crisis emotional anchoring — only for emergency replacements
    if (task.isEmergencyReplacement) {
      // Clear the active task roster entry — replacement is resolved
      await db.collection("agent_tasks_active").doc(clientPhone).delete().catch(() => {});

      await new Promise(r => setTimeout(r, 3000));
      const emergencyAnchorMsg = await generateCaraMessage({
        audience: "family",
        context:  "A family just had last-minute care coverage sorted out after an emergency replacement situation. Send a brief, heartfelt message acknowledging how stressful last-minute care can be and that this is exactly what Evia is here for.",
        fallback: "Last-minute coverage is one of the hardest parts of care. That's exactly what I'm here for.",
        maxTokens: 80,
      });
      await sendMessage(sessionSnap.data()!.chatId, emergencyAnchorMsg);
    }

    // Check if client has a payment method — if not, send a Stripe setup link
    try {
      const Stripe = (await import("stripe")).default;
      const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
      const clientSnap   = await db.collection("users").doc(task.clientId ?? "").get();
      const stripeCustomerId = clientSnap.data()?.stripeCustomerId as string | undefined;

      let hasPaymentMethod = false;
      if (stripeCustomerId) {
        const customer = await stripeClient.customers.retrieve(stripeCustomerId) as any;
        hasPaymentMethod = !!(
          customer.invoice_settings?.default_payment_method ||
          customer.default_source
        );
      }

      if (!hasPaymentMethod) {
        const { generateToken } = await import("./tokenService");
        const token    = generateToken({ phone: clientPhone, task: "payment" });
        const setupUrl = `${appUrl}/done?task=payment&t=${token}`;
        await sendMessage(sessionSnap.data()!.chatId,
          `One more thing — to pay ${task.caregiverName} after each visit, ` +
          `add a card on file (takes 30 seconds): ${setupUrl}`
        );
        // Mark the task so it can be auto-retried when the card is added
        await db.collection("agent_tasks").doc(taskId).update({
          status:           "pending_payment_setup",
          stripeCustomerId: stripeCustomerId ?? null,
          paymentSetupSentAt: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (err) {
      console.error("bookingExecutor payment method check error:", err);
    }
  }

  // Caregiver acknowledgment is handled by shiftOffer.ts at acceptance time —
  // no caregiver notification here.
}

// ── Create a booking task (called from webhooks/agents) ───────────────────────

export async function createBookingTask(params: {
  clientPhone:            string;
  clientId:               string;
  caregiverId:            string;
  caregiverName:          string;
  appointments:           BookingAppointment[];
  hourlyRate:             number;
  isEmergencyReplacement?: boolean;
  recipientName?:         string;
  recipientKey?:          string;
  jobId?:                 string;
  jobTitle?:              string;
  interviewId?:           string;
  applicationId?:         string;
}): Promise<string> {
  // Canonical eligibility gate — only profile_complete + approved caregivers
  // are bookable (covers pending/failed background checks, adverse actions,
  // and incomplete onboarding). See utils/caregiverEligibility.ts.
  const cgSnap = await db.collection("caregivers").doc(params.caregiverId).get();
  if (!isCaregiverBookable(cgSnap.data())) {
    const submittedAt = cgSnap.data()?.backgroundCheckData?.submittedAt as string | undefined;
    const daysInReview = submittedAt
      ? Math.ceil((Date.now() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const sessionSnap = await db.collection("agent_sessions").doc(params.clientPhone).get();
    const chatId      = sessionSnap.data()?.chatId as string | undefined;
    if (chatId) {
      const reviewDaysLabel = daysInReview > 0
        ? `${daysInReview} day${daysInReview !== 1 ? "s" : ""} in review`
        : "just submitted";
      const bgCheckMsg = await generateCaraMessage({
        audience: "family",
        context:  `The family tried to book ${params.caregiverName} but their background check is still in progress (${reviewDaysLabel}). Explain the situation warmly, promise to notify them the moment it clears, and offer to find another available caregiver in the meantime.`,
        fallback: `${params.caregiverName}'s background check is still in progress (${reviewDaysLabel}).\n\nI'll notify you the moment it clears so you can book. Want me to find another available caregiver in the meantime?`,
        maxTokens: 80,
      });
      await sendMessage(chatId, bgCheckMsg);
    }
    return ""; // Early return — no booking written
  }

  const totalCost = params.appointments.reduce(
    (sum, a) => sum + params.hourlyRate * a.durationHours, 0
  );

  const now = new Date();
  const ref = await db.collection("agent_tasks").add({
    type:                  "booking_confirmation",
    clientPhone:           params.clientPhone,
    clientId:              params.clientId,
    caregiverId:           params.caregiverId,
    caregiverName:         params.caregiverName,
    appointments:          params.appointments,
    totalCost,
    status:                "awaiting_approval",
    humanApproved:         false,
    expiresAt:             new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    createdAt:             now.toISOString(),
    ...(params.isEmergencyReplacement && { isEmergencyReplacement: true }),
    ...(params.recipientName ? { recipientName: params.recipientName } : {}),
    ...(params.recipientKey  ? { recipientKey:  params.recipientKey }  : {}),
    ...(params.jobId         ? { jobId:         params.jobId }         : {}),
    ...(params.jobTitle      ? { jobTitle:      params.jobTitle }      : {}),
    ...(params.interviewId   ? { interviewId:   params.interviewId }   : {}),
    ...(params.applicationId ? { applicationId: params.applicationId } : {}),
  });
  return ref.id;
}
