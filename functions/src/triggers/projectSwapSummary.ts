import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

// Track C follow-up (review residual): the raw swap collections carry fields the
// swap UI never needs and should not expose — shift_offers has clientPhone /
// caregiverPhone / caregiverName, shift_swap_requests has candidatesContacted
// (other caregivers' ids), candidateResponses, fromCaregiverName. Firestore
// can't filter fields on read, so instead of granting owner-read on the raw docs
// we project a SANITIZED summary (status + appointment + date/time + the owner
// id fields only) into `shift_swap_summaries`, and the raw collections stay
// server-only. The UI reads the summary collection.
//
// Doc ids are source-prefixed (`req_<id>` / `off_<id>`) so the two sources can't
// collide, and writes are idempotent upserts so trigger retries are safe.

const SUMMARY = "shift_swap_summaries";

/** Caregiver-initiated swaps (shift_swap_requests) -> sanitized summary. */
export const projectSwapRequestSummary = functions.firestore
  .document("shift_swap_requests/{id}")
  .onWrite(async (change, ctx) => {
    const ref = db.collection(SUMMARY).doc(`req_${ctx.params.id}`);
    if (!change.after.exists) { await ref.delete().catch(() => {}); return; }
    const d = change.after.data()!;
    await ref.set({
      source: "swap_request",
      status: d.status ?? null,
      appointmentId: d.appointmentId ?? null,
      date: d.date ?? null,
      time: d.time ?? null,
      expiresAt: d.expiresAt ?? null,
      clientId: d.clientId ?? null,
      fromCaregiverId: d.fromCaregiverId ?? null,
    }, { merge: true });
  });

/** Client-initiated swaps (shift_offers, kind 'swap') -> sanitized summary. */
export const projectSwapOfferSummary = functions.firestore
  .document("shift_offers/{id}")
  .onWrite(async (change, ctx) => {
    const ref = db.collection(SUMMARY).doc(`off_${ctx.params.id}`);
    const after = change.after.exists ? change.after.data()! : null;
    // Only swap-kind offers belong in the swap UI; anything else (and deletes)
    // clears any summary that may exist.
    if (!after || after.kind !== "swap") { await ref.delete().catch(() => {}); return; }
    await ref.set({
      source: "offer",
      status: after.status ?? null,
      appointmentId: Array.isArray(after.appointmentIds) ? after.appointmentIds[0] : (after.appointmentId ?? null),
      date: after.date ?? null,
      time: after.time ?? null,
      expiresAt: after.expiresAt ?? null,
      clientId: after.clientId ?? null,
      caregiverId: after.caregiverId ?? null,
    }, { merge: true });
  });
