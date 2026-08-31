// Shift-offer state machine — the "no silent auto-booking" contract.
//
// Any change that puts a caregiver on a shift (new booking, client-requested
// swap, shift time change) must be ACCEPTED by that caregiver over Evia SMS
// before the appointment reflects it. This module owns the offer lifecycle:
//
//   createShiftOffer()      → writes shift_offers doc, texts the caregiver a
//                             YES/NO offer, flags their agent_session
//   handleShiftOfferReply() → routes the caregiver's reply (YES / NO / question)
//   expireShiftOffers()     → scheduled sweep for unanswered offers
//
// Offer docs are single-fire: status transitions happen inside a transaction
// (pending → accepted | declined | expired) so a duplicate webhook delivery or
// a concurrent expiry sweep can never double-execute.

import * as admin from "firebase-admin";
import { sendMessage, getOrCreateSession } from "../linq/client";
import { classifyApproval } from "./approvalHandler";
import { generateCaraMessage } from "../utils/caraMessage";
import type { BookingTask } from "./bookingExecutor";

const db = admin.firestore();

export type ShiftOfferKind = "booking" | "swap" | "time_change";
export type ShiftOfferStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

// Centralized in config/slaConstants (U14). Imported locally (used in
// createShiftOffer below) AND re-exported so existing importers
// (`import { SHIFT_OFFER_TTL_MS } from "./shiftOffer"`) are unchanged.
// NOTE: a bare `export { X } from "..."` re-export does NOT create a local
// binding, so the local usage would throw ReferenceError — import + export.
import { SHIFT_OFFER_TTL_MS } from "../config/slaConstants";
export { SHIFT_OFFER_TTL_MS };

export interface ShiftOffer {
  kind:            ShiftOfferKind;
  status:          ShiftOfferStatus;
  caregiverId:     string;
  caregiverName:   string;
  caregiverPhone:  string;
  clientId:        string;
  clientPhone:     string;
  appointmentIds:  string[];
  agentTaskId?:    string;
  // kind-specific extras:
  //   swap        → { date, previousCaregiverId, previousCaregiverName }
  //   time_change → { newDate, newStartTime, newEndTime, previousDate, previousStartTime, previousEndTime }
  payload?:        Record<string, unknown>;
  summary:         string; // plain-English description, reused as the approval-classifier preview
  createdAt:       string;
  expiresAt:       string;
  resolvedAt?:     string;
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createShiftOffer(params: {
  kind:           ShiftOfferKind;
  caregiverId:    string;
  caregiverName:  string;
  caregiverPhone: string;
  clientId:       string;
  clientPhone:    string;
  appointmentIds: string[];
  agentTaskId?:   string;
  payload?:       Record<string, unknown>;
  summary:        string;
  offerMessage:   string; // full text sent to the caregiver (YES/NO instruction appended)
}): Promise<string> {
  const now = new Date();
  const offer: ShiftOffer = {
    kind:           params.kind,
    status:         "pending",
    caregiverId:    params.caregiverId,
    caregiverName:  params.caregiverName,
    caregiverPhone: params.caregiverPhone,
    clientId:       params.clientId,
    clientPhone:    params.clientPhone,
    appointmentIds: params.appointmentIds,
    ...(params.agentTaskId ? { agentTaskId: params.agentTaskId } : {}),
    ...(params.payload ? { payload: params.payload } : {}),
    summary:        params.summary,
    createdAt:      now.toISOString(),
    expiresAt:      new Date(now.getTime() + SHIFT_OFFER_TTL_MS).toISOString(),
  };
  const ref = await db.collection("shift_offers").add(offer);

  // Flag the caregiver's session so the webhook intercepts their next reply.
  const cgSession = await getOrCreateSession(params.caregiverPhone, { caregiverId: params.caregiverId });
  await db.collection("agent_sessions").doc(params.caregiverPhone).update({
    pendingShiftOfferId:    ref.id,
    pendingShiftOfferSetAt: now.toISOString(),
  }).catch(() => {});

  await sendMessage(cgSession.chatId,
    `${params.offerMessage}\n\nReply YES to accept or NO to decline. This offer expires in 2 hours.`
  );
  return ref.id;
}

// ── Single-fire claim ─────────────────────────────────────────────────────────

// Atomically transition pending → `to`. Returns the offer data when this caller
// won the claim, or null when the offer was already resolved (someone else won).
async function claimOffer(offerId: string, to: Exclude<ShiftOfferStatus, "pending">): Promise<ShiftOffer | null> {
  const ref = db.collection("shift_offers").doc(offerId);
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as ShiftOffer;
    if (data.status !== "pending") return null;
    t.update(ref, { status: to, resolvedAt: new Date().toISOString() });
    return data;
  });
}

async function clearOfferFlag(caregiverPhone: string): Promise<void> {
  await db.collection("agent_sessions").doc(caregiverPhone).update({
    pendingShiftOfferId:    admin.firestore.FieldValue.delete(),
    pendingShiftOfferSetAt: admin.firestore.FieldValue.delete(),
  }).catch(() => {});
}

async function clientChatId(clientPhone: string): Promise<string | undefined> {
  const snap = await db.collection("agent_sessions").doc(clientPhone).get();
  return snap.data()?.chatId as string | undefined;
}

// ── Reply routing ─────────────────────────────────────────────────────────────

// Called from the Linq webhook when a caregiver with session.pendingShiftOfferId
// sends a message. "handled" → stop processing; "fallthrough" → the reply was a
// question (or the flag was stale), let the normal QA path answer it.
export async function handleShiftOfferReply(params: {
  phone:  string; // caregiver phone
  chatId: string; // caregiver chat
  text:   string;
}): Promise<"handled" | "fallthrough"> {
  const { phone, chatId, text } = params;

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  const offerId = sessionSnap.data()?.pendingShiftOfferId as string | undefined;
  if (!offerId) return "fallthrough";

  const offerSnap = await db.collection("shift_offers").doc(offerId).get();
  if (!offerSnap.exists || (offerSnap.data() as ShiftOffer).status !== "pending") {
    // Stale flag — the offer was resolved elsewhere (expiry sweep, admin).
    await clearOfferFlag(phone);
    return "fallthrough";
  }
  const offer = offerSnap.data() as ShiftOffer;

  // Expired but the sweep hasn't run yet — resolve it now.
  if (new Date(offer.expiresAt) < new Date()) {
    const claimed = await claimOffer(offerId, "expired");
    await clearOfferFlag(phone);
    if (claimed) {
      await onOfferNotAccepted(offerId, claimed, "expired");
      await sendMessage(chatId,
        "That offer expired a little while ago, so I've let the family know and I'm lining up alternatives. " +
        "No action needed — I'll text you the next opportunity."
      ).catch(() => {});
    }
    return "handled";
  }

  const decision = await classifyApproval(text, offer.summary);

  if (decision === "QUESTION") {
    // Keep the offer pending; the QA agent answers and the flag stays set.
    return "fallthrough";
  }

  if (decision === "NO") {
    const claimed = await claimOffer(offerId, "declined");
    await clearOfferFlag(phone);
    if (claimed) {
      await onOfferNotAccepted(offerId, claimed, "declined");
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: (sessionSnap.data()?.preferredLanguage as string) === "es" ? "es" : "en",
        context: "The caregiver just declined a shift offer. Warmly thank them for letting you know quickly and let them know you'll find another match for the family. Short and gracious.",
        fallback: "No problem — thanks for letting me know quickly. I'll find another match.",
        maxTokens: 70,
      })).catch(() => {});
    }
    return "handled";
  }

  // decision === "YES"
  const claimed = await claimOffer(offerId, "accepted");
  await clearOfferFlag(phone);
  if (!claimed) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "caregiver",
      language: (sessionSnap.data()?.preferredLanguage as string) === "es" ? "es" : "en",
      context: "The caregiver tried to accept a shift offer, but it was already claimed/closed out by the time their reply came in. Warmly let them know, and reassure them you'll text them the next opening. Keep it upbeat.",
      fallback: "Looks like that offer was already closed out — I'll text you the next one!",
      maxTokens: 70,
    })).catch(() => {});
    return "handled";
  }
  await onOfferAccepted(offerId, claimed, chatId);
  return "handled";
}

// ── Agent-loop accept/decline (U2) ──────────────────────────────────────────────
//
// These let the MCP tool loop resolve the caregiver's CURRENT pending shift offer
// directly, reusing the exact claim + side-effect path as handleShiftOfferReply.
// Ownership is implicit and safe: the target offer is read from the caregiver's
// own session (keyed by phone), never from a model-supplied id — so there is no
// IDOR surface. The agent has already determined intent, so no classifyApproval.

export type ShiftResolution =
  | { status: "accepted" | "declined" }
  | { status: "no_pending_offer" | "not_pending" | "already_closed" };

async function resolveCaregiverPendingOffer(
  phone: string, chatId: string, decision: "accepted" | "declined",
): Promise<ShiftResolution> {
  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  const offerId = sessionSnap.data()?.pendingShiftOfferId as string | undefined;
  if (!offerId) return { status: "no_pending_offer" };

  const offerSnap = await db.collection("shift_offers").doc(offerId).get();
  if (!offerSnap.exists || (offerSnap.data() as ShiftOffer).status !== "pending") {
    await clearOfferFlag(phone);
    return { status: "not_pending" };
  }

  const claimed = await claimOffer(offerId, decision);
  await clearOfferFlag(phone);
  if (!claimed) return { status: "already_closed" };

  if (decision === "accepted") {
    await onOfferAccepted(offerId, claimed, chatId);
    return { status: "accepted" };
  }
  await onOfferNotAccepted(offerId, claimed, "declined");
  return { status: "declined" };
}

/** Accept the caregiver's current pending shift offer (U2). */
export function acceptCaregiverShiftOffer(phone: string, chatId: string): Promise<ShiftResolution> {
  return resolveCaregiverPendingOffer(phone, chatId, "accepted");
}

/** Decline the caregiver's current pending shift offer (U2). */
export function declineCaregiverShiftOffer(phone: string, chatId: string): Promise<ShiftResolution> {
  return resolveCaregiverPendingOffer(phone, chatId, "declined");
}

// ── Acceptance ────────────────────────────────────────────────────────────────

async function onOfferAccepted(offerId: string, offer: ShiftOffer, caregiverChatId: string): Promise<void> {
  const now = new Date().toISOString();

  if (offer.kind === "booking") {
    // The real booking record is booking_requests/shifts now (not
    // appointments) — resolved via the linked agent_tasks doc, which carries
    // both bookingRequestId and the original appointments[] dates.
    if (offer.agentTaskId) {
      const { writeConfirmedShifts, finalizeAcceptedBooking } = await import("./bookingExecutor");
      const taskSnap = await db.collection("agent_tasks").doc(offer.agentTaskId).get();
      const task = taskSnap.exists ? (taskSnap.data() as BookingTask & { bookingRequestId?: string }) : null;
      const bookingRequestId = task?.bookingRequestId;
      if (task && bookingRequestId) {
        const bookingReqSnap = await db.collection("booking_requests").doc(bookingRequestId).get();
        const bookingReqData = bookingReqSnap.data() ?? {};
        await db.collection("booking_requests").doc(bookingRequestId).update({ status: "accepted" });
        await writeConfirmedShifts(
          bookingRequestId,
          task,
          (bookingReqData.clientName as string) ?? "",
          (bookingReqData.seniorName as string | undefined) ?? null,
          (bookingReqData.address as string | undefined) ?? null,
        );
      } else {
        console.error(`shiftOffer: could not resolve booking_requests for agent task ${offer.agentTaskId} (offer ${offerId})`);
      }
      await db.collection("agent_tasks").doc(offer.agentTaskId).update({
        status: "approved", caregiverAccepted: true, caregiverAcceptedAt: now,
      });

      await sendMessage(caregiverChatId,
        "You're confirmed! I'll text you the care plan and directions the morning of every visit."
      ).catch(() => {});

      await finalizeAcceptedBooking(offer.agentTaskId, offer.clientPhone).catch((err) =>
        console.error("shiftOffer: finalizeAcceptedBooking failed", { offerId, err })
      );
    } else {
      // Offers without an agent task (web-originated): just tell both sides —
      // nothing to write here since there's no linked booking_requests/task
      // to resolve a real shift from.
      await sendMessage(caregiverChatId,
        "You're confirmed! I'll text you the care plan and directions the morning of every visit."
      ).catch(() => {});
      const chatId = await clientChatId(offer.clientPhone);
      if (chatId) {
        const msg = await generateCaraMessage({
          audience: "family",
          context:  `${offer.caregiverName} just accepted the booking — the visit is confirmed. Celebrate briefly and say you'll text when they arrive.`,
          fallback: `Great news — ${offer.caregiverName} accepted! Your visit is confirmed. I'll text you when they arrive.`,
          maxTokens: 80,
        });
        await sendMessage(chatId, msg).catch(() => {});
      }
    }
    return;
  }

  if (offer.kind === "swap") {
    const p = (offer.payload ?? {}) as { date?: string };
    // Dual-lookup — same pattern as start_shift/complete_shift: the visit
    // being swapped may live in appointments (old bookings) or shifts (new
    // ones written by writeConfirmedShifts).
    const batch = db.batch();
    for (const apptId of offer.appointmentIds) {
      const apptSnap = await db.collection("appointments").doc(apptId).get();
      const coll = apptSnap.exists ? "appointments" : "shifts";
      batch.update(db.collection(coll).doc(apptId), {
        caregiverId:    offer.caregiverId,
        caregiverName:  offer.caregiverName,
        swapNote:       "Client-requested caregiver swap",
        swapAcceptedAt: now,
      });
    }
    await batch.commit();

    await sendMessage(caregiverChatId,
      `You're set${p.date ? ` for ${p.date}` : ""}! I'll send the care plan and directions before the visit.`
    ).catch(() => {});

    const chatId = await clientChatId(offer.clientPhone);
    if (chatId) {
      const msg = await generateCaraMessage({
        audience: "family",
        context:  `${offer.caregiverName} accepted the caregiver swap${p.date ? ` for the visit on ${p.date}` : ""}. Confirm the change is locked in.`,
        fallback: `Done - ${offer.caregiverName} accepted and is now set${p.date ? ` for ${p.date}` : ""}.`,
        maxTokens: 80,
      });
      await sendMessage(chatId, msg).catch(() => {});
    }
    return;
  }

  // kind === "time_change"
  const p = (offer.payload ?? {}) as {
    newDate?: string; newStartTime?: string; newEndTime?: string;
    previousDate?: string; previousStartTime?: string;
  };
  const batch = db.batch();
  for (const apptId of offer.appointmentIds) {
    // Dual-lookup — same pattern as the swap branch above: the visit being
    // moved may live in appointments (old bookings) or shifts (new ones
    // written by writeConfirmedShifts).
    const apptSnap = await db.collection("appointments").doc(apptId).get();
    const coll = apptSnap.exists ? "appointments" : "shifts";
    batch.update(db.collection(coll).doc(apptId), {
      date:              p.newDate,
      startTime:         p.newStartTime,
      endTime:           p.newEndTime,
      previousDate:      p.previousDate ?? null,
      previousStartTime: p.previousStartTime ?? null,
      rescheduledAt:     now,
      pendingTimeChange: admin.firestore.FieldValue.delete(),
    });
  }
  await batch.commit();

  await sendMessage(caregiverChatId,
    `Locked in — the visit is now ${p.newDate} at ${p.newStartTime}. Thanks for confirming!`
  ).catch(() => {});

  const chatId = await clientChatId(offer.clientPhone);
  if (chatId) {
    const msg = await generateCaraMessage({
      audience: "family",
      context:  `${offer.caregiverName} confirmed the new time — the visit is now ${p.newDate} at ${p.newStartTime}. Confirm the reschedule is locked in.`,
      fallback: `All set — ${offer.caregiverName} confirmed the new time. The visit is now ${p.newDate} at ${p.newStartTime}.`,
      maxTokens: 80,
    });
    await sendMessage(chatId, msg).catch(() => {});
  }
}

// ── Decline / expiry ──────────────────────────────────────────────────────────

async function onOfferNotAccepted(
  offerId: string,
  offer: ShiftOffer,
  reason: "declined" | "expired",
): Promise<void> {
  const reasonLabel = reason === "declined" ? "declined_by_caregiver" : "offer_expired";

  if (offer.kind === "booking") {
    // Cancel the pending booking_requests doc (not appointments — see
    // onOfferAccepted's "booking" branch for why) and the task, then offer
    // alternatives. status:'declined' for a caregiver decline matches
    // CaregiverBookingsPage.tsx's own handleDecline; 'cancelled' for expiry
    // since nobody explicitly declined.
    if (offer.agentTaskId) {
      const taskSnap = await db.collection("agent_tasks").doc(offer.agentTaskId).get();
      const bookingRequestId = taskSnap.exists ? (taskSnap.data() as { bookingRequestId?: string }).bookingRequestId : undefined;
      const batch = db.batch();
      if (bookingRequestId) {
        batch.update(db.collection("booking_requests").doc(bookingRequestId), {
          status: reason === "declined" ? "declined" : "cancelled",
        });
      }
      batch.update(db.collection("agent_tasks").doc(offer.agentTaskId), { status: reasonLabel });
      await batch.commit();
    }

    // Skip this caregiver in the re-match.
    await db.collection("agent_sessions").doc(offer.clientPhone).update({
      rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(offer.caregiverId),
    }).catch(() => {});

    const chatId = await clientChatId(offer.clientPhone);
    if (chatId) {
      const ctx = reason === "declined"
        ? `${offer.caregiverName} couldn't take the visit after all. Reassure the family and tell them you're already finding alternatives.`
        : `${offer.caregiverName} didn't respond to the booking request in time. Reassure the family and tell them you're already finding alternatives.`;
      const msg = await generateCaraMessage({
        audience: "family",
        context:  ctx,
        fallback: `${offer.caregiverName} isn't able to take that visit — already on it, finding you other great options now.`,
        maxTokens: 80,
      });
      await sendMessage(chatId, msg).catch(() => {});

      const sessionData = (await db.collection("agent_sessions").doc(offer.clientPhone).get()).data() ?? {};
      const { runMatchingForClient } = await import("./matchingAgent");
      await runMatchingForClient(offer.clientPhone, chatId, sessionData, sessionData).catch((err) =>
        console.error("shiftOffer: re-match after non-acceptance failed", { offerId, err })
      );
    }
    return;
  }

  if (offer.kind === "swap") {
    // Appointment was never modified — nothing to roll back.
    const p = (offer.payload ?? {}) as { date?: string };
    const chatId = await clientChatId(offer.clientPhone);
    if (chatId) {
      const ctx = reason === "declined"
        ? `${offer.caregiverName} can't cover the visit${p.date ? ` on ${p.date}` : ""}. The current caregiver is still assigned. Offer to show other available caregivers.`
        : `${offer.caregiverName} didn't respond in time to the swap request${p.date ? ` for ${p.date}` : ""}. The current caregiver is still assigned. Offer to show other available caregivers.`;
      const msg = await generateCaraMessage({
        audience: "family",
        context:  ctx,
        fallback: `${offer.caregiverName} isn't able to cover that visit — your current caregiver is still assigned. Want me to show other options?`,
        maxTokens: 80,
      });
      await sendMessage(chatId, msg).catch(() => {});
    }
    return;
  }

  // kind === "time_change" — keep original schedule, clear the pending marker.
  const batch = db.batch();
  for (const apptId of offer.appointmentIds) {
    const apptSnap = await db.collection("appointments").doc(apptId).get();
    const coll = apptSnap.exists ? "appointments" : "shifts";
    batch.update(db.collection(coll).doc(apptId), {
      pendingTimeChange: admin.firestore.FieldValue.delete(),
    });
  }
  await batch.commit();

  const p = (offer.payload ?? {}) as { newDate?: string; newStartTime?: string; previousDate?: string; previousStartTime?: string };
  const chatId = await clientChatId(offer.clientPhone);
  if (chatId) {
    const ctx = reason === "declined"
      ? `${offer.caregiverName} can't make the new time (${p.newDate} at ${p.newStartTime}), so the visit stays at the original time (${p.previousDate} at ${p.previousStartTime}). Offer to find a different caregiver for the new time instead.`
      : `${offer.caregiverName} didn't confirm the new time (${p.newDate} at ${p.newStartTime}) in time, so the visit stays at the original time (${p.previousDate} at ${p.previousStartTime}). Offer to find a different caregiver for the new time instead.`;
    const msg = await generateCaraMessage({
      audience: "family",
      context:  ctx,
      fallback: `${offer.caregiverName} can't make the new time, so I've kept the visit at ${p.previousDate} at ${p.previousStartTime}. Want me to find someone else for the new time instead?`,
      maxTokens: 90,
    });
    await sendMessage(chatId, msg).catch(() => {});
  }
}

// ── Expiry sweep (called from the scheduled job) ──────────────────────────────

export async function expireShiftOffers(): Promise<number> {
  const nowIso = new Date().toISOString();
  // Single-field query + in-code filter — avoids needing a composite index.
  const snap = await db.collection("shift_offers").where("status", "==", "pending").limit(200).get();
  let expired = 0;
  for (const doc of snap.docs) {
    const offer = doc.data() as ShiftOffer;
    if (offer.expiresAt >= nowIso) continue;
    const claimed = await claimOffer(doc.id, "expired");
    if (!claimed) continue; // raced with a live reply — that path handles it
    expired++;
    await clearOfferFlag(claimed.caregiverPhone);
    await onOfferNotAccepted(doc.id, claimed, "expired");
    // Let the caregiver know the window closed (best effort).
    try {
      const cgSession = await getOrCreateSession(claimed.caregiverPhone, { caregiverId: claimed.caregiverId });
      await sendMessage(cgSession.chatId,
        "The shift offer I sent earlier has expired, so I've let the family know. No action needed — I'll text you the next opportunity."
      );
    } catch (err) {
      console.error("expireShiftOffers: caregiver notify failed", { offerId: doc.id, err });
    }
  }
  return expired;
}
