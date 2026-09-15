import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { notifyAdminBookingConfirmed } from "../notifications";
import { logBookingCreated } from "../observability/auditLog";
import { closeJobPost } from "../triggers/jobNotifications";
import { generateCaraMessage } from "../utils/caraMessage";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { createShiftOffer } from "./shiftOffer";
import { getAppUrl } from "../config/appUrl";
import { formatDateForDisplay, formatHHMMForDisplay } from "../utils/scheduledTime";
import { bookingTimeToMinutes } from "./bookingResolution";
import { nextOccurrenceOnOrAfter } from "../scheduled/shiftGenerator";

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

// Matches the website's own recurring-shift shape (see shiftGenerator.ts's
// onBookingAccepted, which reads booking_requests.schedule.dayShiftTimes/
// ongoing/endDate to generate real shifts) — Evia's recurring bookings plug
// into the exact same generator instead of a parallel mechanism.
//
// 2026-09-14 (live-caught): dayShiftTimes MUST be an array of blocks per day
// (the site supports multiple time blocks on the same day, e.g. a morning
// and an evening visit) — this was previously typed and written as a single
// {start,end} object per day. shiftGenerator.ts's generateShiftsForBooking
// calls `.filter()`/`.forEach()` directly on each day's value, which silently
// no-ops (or throws) on a plain object instead of an array — meaning every
// Evia-originated recurring/ongoing booking never actually generated real
// `shifts` docs at all, and the client's own booking card (which does the
// same `dst[d]?.length` array check) rendered a blank schedule line.
export interface BookingSchedule {
  dayShiftTimes: Record<string, Array<{ start: string; end: string }>>;
  ongoing:       boolean;
  startDate?:    string;
  endDate?:      string;
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
  // Website "Send Booking Request" modal parity fields (2026-09-13) — see
  // createBookingTask's matching params for what stamps these.
  schedule?:             BookingSchedule;
  careLocation?:         string;
  message?:              string;
  careRecipients?:       Array<Record<string, unknown>>;
  careNeeds?:            string[];
  lifestylePreferences?: string[];
  emergencyContact?:     { name: string; phone: string; relationship?: string };
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

// The caregiver's shift-offer text (below, in the phone-reachable branch)
// needs ONE representative visit to quote a date/time/pay for — historically
// always task.appointments[0]. bookingFlow.ts (2026-09-14) no longer ever
// populates appointments — every booking, one-time or ongoing, goes through
// task.schedule instead, matching the site's own single schedule shape. This
// derives the same "first visit" shape from schedule.dayShiftTimes/startDate
// using the exact day-resolution logic shiftGenerator.ts itself uses, so the
// quoted date is guaranteed to be the same one the real shift eventually
// generates as. Falls back to appointments[0] for any other caller (e.g.
// request_booking) that still passes a literal appointments array.
function deriveFirstOccurrence(
  task: BookingTask,
): { date: string; startTime: string; endTime: string; durationHours: number } | null {
  if (task.appointments.length > 0) {
    const a = task.appointments[0];
    return { date: a.date, startTime: a.startTime, endTime: a.endTime, durationHours: a.durationHours };
  }
  const dayShiftTimes = task.schedule?.dayShiftTimes ?? {};
  const anchor = task.schedule?.startDate ?? new Date().toISOString().split("T")[0];
  let best: { date: string; startTime: string; endTime: string; durationHours: number } | null = null;
  for (const [day, blocks] of Object.entries(dayShiftTimes)) {
    const t = blocks?.[0];
    if (!t?.start || !t?.end) continue;
    const date = nextOccurrenceOnOrAfter(anchor, day);
    const s = bookingTimeToMinutes(t.start);
    const e = bookingTimeToMinutes(t.end);
    if (s === null || e === null) continue;
    const candidate = { date, startTime: t.start, endTime: t.end, durationHours: (e - s) / 60 };
    if (!best || candidate.date < best.date) best = candidate;
  }
  return best;
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
        `Rebook after conflict with ${task.caregiverName} on ${formatDateForDisplay(appt.date)}`,
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
          context:  `${task.caregiverName} has a scheduling conflict and already has a visit at that time on ${formatDateForDisplay(appt.date)}. Let the family know and tell them you're finding someone else for that date.`,
          fallback: `${task.caregiverName} already has a visit at that time — finding someone else for ${formatDateForDisplay(appt.date)}.`,
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
  const offerClientData = clientSnapForOffer.data() ?? {};
  // 2026-09-13 (live-caught): users/{uid} docs for an Evia-onboarded client
  // never have a top-level `name` field at all — onboarding only ever
  // writes firstName(/lastName). Reading `.name` unconditionally silently
  // produced an empty clientName on every SMS-originated booking, which the
  // caregiver's own booking card then rendered as a bare "Client" fallback
  // instead of the family's real name — something a website-originated
  // booking (built from Firebase Auth's displayName) never hits.
  const offerClientName =
    [offerClientData.firstName, offerClientData.lastName].filter(Boolean).join(" ")
    || (offerClientData.name as string | undefined)
    || undefined;
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
  // doc. For a one-off/short booking (no task.schedule), `schedule` is
  // deliberately left empty: those dates are often irregular and don't fit
  // the site's weekly dayShiftTimes pattern, and the site's own shift-
  // generator no-ops safely on an empty schedule — the real shifts docs get
  // written directly by writeConfirmedShifts() once the caregiver actually
  // confirms (see shiftOffer.ts's onOfferAccepted), or immediately below for
  // the no-phone fallback. For a recurring/ongoing booking (request_booking's
  // recurring:true path), task.schedule IS the real weekly shape and plugs
  // straight into the same shiftGenerator.ts trigger the website's own
  // recurring bookings use — no separate mechanism. Family approval does NOT
  // confirm the visit: the caregiver must accept the shift offer first, so
  // this is written status:'pending' — the exact status a website-sent
  // booking starts at too.
  const bookingRequestRef = db.collection("booking_requests").doc();
  const batch = db.batch();
  const bookingAddress = (task.careLocation as string | undefined) || offerAddress;
  batch.set(bookingRequestRef, {
    clientId:      task.clientId,
    clientName:    offerClientName ?? "",
    ...(offerClientData.photoURL ? { clientPhotoURL: offerClientData.photoURL } : {}),
    caregiverId:   task.caregiverId,
    caregiverName: task.caregiverName,
    ...(caregiverSnapForOffer.data()?.photo ? { caregiverPhotoURL: caregiverSnapForOffer.data()?.photo } : {}),
    ...(bookingAddress ? { address: bookingAddress } : {}),
    ...(offerSeniorName ? { seniorName: offerSeniorName } : {}),
    ...(task.recipientKey ? { recipientKey: task.recipientKey } : {}),
    ...(task.careRecipients ? { careRecipients: task.careRecipients } : {}),
    ...(task.careNeeds ? { careNeeds: task.careNeeds } : {}),
    ...(task.lifestylePreferences ? { lifestylePreferences: task.lifestylePreferences } : {}),
    ...(task.emergencyContact ? { emergencyContact: task.emergencyContact } : {}),
    ...(task.schedule ? { schedule: task.schedule } : {}),
    ...(task.jobId ? { jobId: task.jobId } : {}),
    ...(task.jobTitle ? { jobTitle: task.jobTitle } : {}),
    ...(task.interviewId ? { interviewId: task.interviewId } : {}),
    rate:          task.hourlyRate ?? null,
    paymentMethod: "credit",
    notes:         (task.message as string | undefined) || "",
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
    // 2026-09-13 (live-caught): SMS is only EVIA's OWN notification channel —
    // it was never the only way a caregiver can respond. The site's own
    // Requests tab already shows this booking (the batch.set above already
    // wrote it as status:"pending") regardless of whether Evia can text
    // them, and they can Accept/Decline there the exact same way as any
    // other caregiver. Auto-accepting on their behalf just because SMS
    // delivery isn't possible was a real site-parity violation — no booking
    // on the site is ever silently confirmed without the caregiver's own
    // Accept, phone on file or not. Just flag it so a human follows up on
    // reaching them some other way (call, email); the request itself stays
    // exactly as pending as every other one.
    await db.collection("admin_alerts").add({
      type:          "shift_offer_undeliverable",
      caregiverId:   task.caregiverId,
      caregiverName: task.caregiverName,
      clientPhone,
      agentTaskId:   taskId,
      createdAt:     now,
      resolved:      false,
    }).catch(() => {});

    // Family still deserves the same honest "it's out, not confirmed yet"
    // update the phone-reachable path sends below — the booking really is
    // pending on the site regardless of whether Evia could text the
    // caregiver about it.
    const undeliverableSessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (undeliverableSessionSnap.exists) {
      const undeliverableMsg = await generateCaraMessage({
        audience: "family",
        context:  `You just sent ${task.caregiverName} the booking request. Tell the family you've asked ${task.caregiverName} to confirm and you'll let them know once they respond. Do NOT say the booking is confirmed yet.`,
        fallback: `I've sent the request to ${task.caregiverName} — I'll let you know as soon as they respond.`,
        maxTokens: 80,
      });
      await sendMessage(undeliverableSessionSnap.data()!.chatId, undeliverableMsg);
    }
    return;
  }

  const offerFirstAppt = deriveFirstOccurrence(task);
  // Prefer the rate the family actually agreed to for THIS booking over the
  // caregiver's own generic listed rate — those can differ (negotiated up
  // or down from what's on their profile), and quoting the wrong one here
  // means the caregiver sees a different number than what gets billed.
  const offerVisitPay  = ((task.hourlyRate ?? caregiverSnapForOffer.data()?.hourlyRate ?? 20) * (offerFirstAppt?.durationHours ?? 0)).toFixed(2);
  const offerClientLabel = offerSeniorName ? `with ${offerSeniorName}` : "with a client";
  // task.appointments carries literal per-date visits (any caller still
  // using that shape, e.g. request_booking); bookingFlow.ts (2026-09-14)
  // always uses task.schedule instead — describe the weekly pattern itself
  // rather than any specific dates, since the real dates are generated
  // ongoing by shiftGenerator.ts, not fixed up front.
  const offerLines = task.appointments.length > 0
    ? task.appointments.map((a) => `${formatDateForDisplay(a.date)} · ${formatHHMMForDisplay(a.startTime)}–${formatHHMMForDisplay(a.endTime)}`).join("\n")
    : Object.entries(task.schedule?.dayShiftTimes ?? {})
        .map(([day, blocks]) => `${day} · ${blocks.map((t) => `${formatHHMMForDisplay(t.start)}–${formatHHMMForDisplay(t.end)}`).join(", ")}`)
        .join("\n") + (task.schedule?.startDate ? `\nStarting ${formatDateForDisplay(task.schedule.startDate)}` : "");
  const offerFirstApptDate = offerFirstAppt?.date ? formatDateForDisplay(offerFirstAppt.date) : "";
  const offerScheduleStartDate = task.schedule?.startDate
    ? formatDateForDisplay(task.schedule.startDate)
    : offerFirstApptDate;
  const offerSummary = task.appointments.length > 0
    ? `New booking ${offerClientLabel}: ${task.appointments.length} visit${task.appointments.length === 1 ? "" : "s"} starting ${offerFirstApptDate} at ${formatHHMMForDisplay(offerFirstAppt?.startTime ?? "")}, $${offerVisitPay} per visit`
    : `New booking ${offerClientLabel}: ${Object.keys(task.schedule?.dayShiftTimes ?? {}).join(", ")}, starting ${offerScheduleStartDate}, $${offerVisitPay} per visit`;

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
      `${formatDateForDisplay(a.date)} · ${formatHHMMForDisplay(a.startTime)}–${formatHHMMForDisplay(a.endTime)} · ${task.caregiverName}`
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
      // T12:00 — a bare "YYYY-MM-DD" parses as UTC midnight, which is still the
      // PREVIOUS weekday in Pacific after 5pm; this day is persisted into
      // pendingRecurringSchedule.days, so the recurring booking landed a day early.
      const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${firstAppt.date}T12:00:00`).getDay()];
      const schedDesc = `${dayOfWeek}s ${formatHHMMForDisplay(firstAppt.startTime)}–${formatHHMMForDisplay(firstAppt.endTime)}`;

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
  // Recurring/ongoing arrangements (matches the website's own recurring
  // booking shape) — appointments is empty for these; totalCostOverride
  // supplies the weekly estimate since totalCost's usual appointments.reduce
  // has nothing to sum over.
  schedule?:              BookingSchedule;
  totalCostOverride?:     number;
  // Website "Send Booking Request" modal parity fields — all optional,
  // all pass straight through to the final booking_requests write in
  // executeBookings below.
  careLocation?:          string;
  message?:               string;
  careRecipients?:        Array<Record<string, unknown>>;
  careNeeds?:             string[];
  lifestylePreferences?:  string[];
  emergencyContact?:      { name: string; phone: string; relationship?: string };
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

  const totalCost = params.totalCostOverride ?? params.appointments.reduce(
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
    // 2026-09-13 (live-caught): never written before, despite BookingTask
    // declaring it and executeBookings reading task.hourlyRate straight into
    // the booking_requests doc's `rate` field — every booking created this
    // way wrote rate:null regardless of what the family actually agreed to.
    hourlyRate:            params.hourlyRate,
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
    ...(params.schedule         ? { schedule: params.schedule }                 : {}),
    ...(params.careLocation     ? { careLocation: params.careLocation }         : {}),
    ...(params.message          ? { message: params.message }                  : {}),
    ...(params.careRecipients   ? { careRecipients: params.careRecipients }     : {}),
    ...(params.careNeeds            ? { careNeeds: params.careNeeds }                       : {}),
    ...(params.lifestylePreferences ? { lifestylePreferences: params.lifestylePreferences } : {}),
    ...(params.emergencyContact ? { emergencyContact: params.emergencyContact } : {}),
  });
  return ref.id;
}
