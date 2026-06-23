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
  const snap = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date", "==", date)
    .where("status", "in", ["confirmed", "in-progress", "pending_caregiver_confirmation"])
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

interface BookingTask {
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
  isEmergencyReplacement?: boolean;
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

      // Set an active goal so Cara carries booking context through the re-match.
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

  // Idempotency guard: if Cloud Functions retries this invocation after a partial commit,
  // agentTaskId is already on every appointment written in the first attempt — skip if found.
  // Appointments are written pending_caregiver_confirmation, so reset the task to that state.
  const existingAppts = await db.collection("appointments")
    .where("agentTaskId", "==", taskId)
    .limit(1)
    .get();
  if (!existingAppts.empty) {
    await taskRef.update({ status: "pending_caregiver_confirmation", humanApproved: true }).catch(() => {});
    return;
  }

  // Write each appointment — this is the ONLY place appointments are written by the agent.
  // Family approval does NOT confirm the visit: the caregiver must accept the shift offer
  // first (see shiftOffer.ts), so everything is written pending_caregiver_confirmation.
  const batch = db.batch();
  const apptRefs: admin.firestore.DocumentReference[] = [];

  for (const appt of task.appointments) {
    const ref = db.collection("appointments").doc();
    apptRefs.push(ref);
    batch.set(ref, {
      clientId:           task.clientId,
      caregiverId:        task.caregiverId,
      caregiverName:      task.caregiverName,
      date:               appt.date,
      startTime:          appt.startTime,
      endTime:            appt.endTime,
      durationHours:      appt.durationHours,
      status:             "pending_caregiver_confirmation",
      caregiverConfirmed: false,
      createdByAgent:     true,
      agentTaskId:        taskId,
      humanApproved:      true,
      approvedAt:         now,
      createdAt:          now,
    });
  }

  batch.update(taskRef, { status: "pending_caregiver_confirmation", humanApproved: true, approvedAt: now });
  await batch.commit();

  // Send the caregiver a YES/NO shift offer. Confirmation, family notification,
  // and payment setup all happen in finalizeAcceptedBooking() once they accept.
  const [caregiverSnapForOffer, clientSnapForOffer] = await Promise.all([
    db.collection("caregivers").doc(task.caregiverId).get(),
    db.collection("users").doc(task.clientId).get(),
  ]);
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
    const confirmBatch = db.batch();
    for (const ref of apptRefs) confirmBatch.update(ref, { status: "confirmed" });
    confirmBatch.update(taskRef, { status: "approved" });
    await confirmBatch.commit();
    await finalizeAcceptedBooking(taskId, clientPhone);
    return;
  }

  const offerSeniorName = clientSnapForOffer.data()?.seniorName
    ?? (clientSnapForOffer.data()?.senior as { name?: string } | undefined)?.name
    ?? null;
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
    appointmentIds: apptRefs.map((r) => r.id),
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
        context:  "A family just had last-minute care coverage sorted out after an emergency replacement situation. Send a brief, heartfelt message acknowledging how stressful last-minute care can be and that this is exactly what Cara is here for.",
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
  });
  return ref.id;
}
