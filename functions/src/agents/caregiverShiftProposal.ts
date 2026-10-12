// agents/caregiverShiftProposal.ts — the reschedule-proposal strip on an
// Active Bookings visit (components/caregiver/CaregiverBookingsPage.tsx):
//
//   family proposed   → "Accept new time" (handleAcceptReschedule: the page's
//                        own-visit overlap check, then the real date/startTime/
//                        endTime move + rescheduleHistory) · "Decline"
//                        (handleClearReschedule: the pending fields cleared,
//                        the confirmed time untouched)
//   you proposed      → "Withdraw" (the same handleClearReschedule write)
//
// ONE implementation for every Evia door (caregiver sweep B1 + B4, 2026-10-11):
// the manage_shift_reschedule tool, the parked ACCEPT / DECLINE reply to the
// proposal notice (decisionNotices.ts) and the WITHDRAW keyword
// (routeCaregiver.ts) all end here, so a reply by text is the page's write —
// field for field, including the page's refusal text. The family is told by
// onShiftStatusChanged (notificationTriggers.ts), which watches these exact
// field transitions — nothing here sends its own text to the family.
import * as admin from "firebase-admin";
import { findCaregiverOwnShiftConflict, type OwnShiftConflict } from "./shiftReschedule";
import { logAudit } from "../observability/auditLog";
import { fmtDate, fmtTime } from "./caregiverBookingRequests";

const db = admin.firestore();
type Doc = FirebaseFirestore.DocumentData;

// ── Display ──────────────────────────────────────────────────────────────────
/** "Tue, Oct 6, 2099, 12:00 PM – 3:00 PM" — the strip's own date + range rendering. */
export function visitWhen(v: { date?: unknown; startTime?: unknown; endTime?: unknown } | Doc): string {
  return `${fmtDate(String(v.date ?? ""))}, ${fmtTime(v.startTime as string | undefined)}${v.endTime ? ` – ${fmtTime(String(v.endTime))}` : ""}`;
}
/** The proposed time on the strip. */
export function proposalWhen(shift: Doc): string {
  return visitWhen({ date: shift.reschedulePendingDate, startTime: shift.reschedulePendingStartTime, endTime: shift.reschedulePendingEndTime });
}
/** The page's alert on an overlap, verbatim. */
export const conflictAlert = (c: OwnShiftConflict) =>
  `You already have another shift at ${fmtTime(c.startTime)}${c.endTime ? `–${fmtTime(c.endTime)}` : ""} that day — choose a different time.`;

// ── Load ─────────────────────────────────────────────────────────────────────
export type ShiftProposalLoad =
  | { ok: true; shift: Doc; ref: FirebaseFirestore.DocumentReference }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

/** The strip renders only on a SCHEDULED visit of yours with a proposal pending. */
export async function loadShiftWithProposal(caregiverId: string, shiftId: string): Promise<ShiftProposalLoad> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NOT_FOUND", message: "Visit not found" };
  const shift = snap.data()!;
  if (shift.caregiverId !== caregiverId) return { ok: false, code: "PERMISSION_DENIED", message: "Visit does not belong to this caregiver" };
  if (!shift.reschedulePendingDate) return { ok: false, code: "INVALID_INPUT", message: "There's no pending reschedule proposal on this visit" };
  if (shift.status !== "scheduled") return { ok: false, code: "INVALID_INPUT", message: `Only a scheduled visit carries a reschedule proposal (status: ${shift.status})` };
  return { ok: true, shift, ref };
}

// ── The three buttons ────────────────────────────────────────────────────────
export type ProposalDecisionResult =
  | { ok: true; shiftId: string; clientName: string; from: { date: string; startTime: string; endTime: string | null }; to: { date: string; startTime: string; endTime: string | null } | null }
  | { ok: false; code: "CONFLICT"; message: string; conflict: OwnShiftConflict }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

const clearFields = () => ({
  reschedulePendingDate: admin.firestore.FieldValue.delete(),
  reschedulePendingStartTime: admin.firestore.FieldValue.delete(),
  reschedulePendingEndTime: admin.firestore.FieldValue.delete(),
  reschedulePendingAt: admin.firestore.FieldValue.delete(),
  rescheduledBy: admin.firestore.FieldValue.delete(),
});
const timesOf = (v: Doc) => ({ date: String(v.date ?? ""), startTime: String(v.startTime ?? ""), endTime: v.endTime ? String(v.endTime) : null });

/** "Accept new time" — the page's handleAcceptReschedule: overlap check, then the real time moves (same doc, history appended). */
export async function acceptFamilyShiftProposal(caregiverId: string, shiftId: string, nowIso: string, source: string): Promise<ProposalDecisionResult> {
  const loaded = await loadShiftWithProposal(caregiverId, shiftId);
  if (!loaded.ok) return loaded;
  const { shift, ref } = loaded;
  if (shift.rescheduledBy !== "client") return { ok: false, code: "INVALID_INPUT", message: "This proposal is your own — nothing to accept (withdraw it instead)" };
  const pendingStart = String(shift.reschedulePendingStartTime ?? "");
  const conflict = await findCaregiverOwnShiftConflict({
    caregiverId, date: String(shift.reschedulePendingDate), startTime: pendingStart,
    endTime: String(shift.reschedulePendingEndTime ?? pendingStart), excludeShiftId: shiftId,
  });
  if (conflict) return { ok: false, code: "CONFLICT", message: conflictAlert(conflict), conflict };
  await ref.update({
    date: shift.reschedulePendingDate,
    startTime: shift.reschedulePendingStartTime,
    endTime: shift.reschedulePendingEndTime,
    ...clearFields(),
    rescheduleHistory: admin.firestore.FieldValue.arrayUnion({
      from: { date: shift.date, startTime: shift.startTime, endTime: shift.endTime ?? null },
      to:   { date: shift.reschedulePendingDate, startTime: shift.reschedulePendingStartTime, endTime: shift.reschedulePendingEndTime ?? null },
      proposedBy: shift.rescheduledBy,
      proposedAt: shift.reschedulePendingAt ?? null,
      acceptedBy: "caregiver",
      acceptedAt: nowIso,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logAudit({ eventType: "shift_reschedule_accepted", userId: caregiverId, data: { source, shiftId } }).catch(() => {});
  return {
    ok: true, shiftId, clientName: String(shift.clientName ?? "the family"), from: timesOf(shift),
    to: { date: String(shift.reschedulePendingDate), startTime: pendingStart, endTime: shift.reschedulePendingEndTime ? String(shift.reschedulePendingEndTime) : null },
  };
}

/** "Decline" (the family's proposal) / "Withdraw" (your own) — the page's handleClearReschedule: the pending fields only. */
async function clearProposal(caregiverId: string, shiftId: string, expectBy: "client" | "caregiver", source: string): Promise<ProposalDecisionResult> {
  const loaded = await loadShiftWithProposal(caregiverId, shiftId);
  if (!loaded.ok) return loaded;
  const { shift, ref } = loaded;
  if (shift.rescheduledBy !== expectBy) {
    return { ok: false, code: "INVALID_INPUT", message: expectBy === "client"
      ? "This proposal is your own — withdraw it instead of declining it"
      : "This is the family's proposal — accept or decline it; there is nothing of yours to withdraw" };
  }
  await ref.update({ ...clearFields(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  logAudit({ eventType: "shift_reschedule_cleared", userId: caregiverId, data: { source, shiftId } }).catch(() => {});
  return { ok: true, shiftId, clientName: String(shift.clientName ?? "the family"), from: timesOf(shift), to: null };
}
export const declineFamilyShiftProposal = (caregiverId: string, shiftId: string, source: string) => clearProposal(caregiverId, shiftId, "client", source);
export const withdrawOwnShiftProposal  = (caregiverId: string, shiftId: string, source: string) => clearProposal(caregiverId, shiftId, "caregiver", source);

// ── The visits with a proposal pending (the strip's own query: scheduled visits of yours) ──
export interface PendingProposalVisit { shiftId: string; clientName: string; by: "client" | "caregiver"; when: string; proposed: string; line: string }

export async function listPendingProposals(caregiverId: string, by: "client" | "caregiver"): Promise<PendingProposalVisit[]> {
  const snap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "==", "scheduled").get();
  return snap.docs
    .map((d): Doc & { id: string } => ({ ...(d.data() as Doc), id: d.id }))
    .filter((s) => s.reschedulePendingDate && s.rescheduledBy === by)
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")))
    .map((s) => {
      const clientName = String(s.clientName ?? "the family");
      const when = visitWhen(s);
      return { shiftId: s.id, clientName, by, when, proposed: proposalWhen(s), line: `your visit with ${clientName} on ${when}` };
    });
}

// ── WITHDRAW by text (routeCaregiver.ts) — the strip's Withdraw button ───────
// One proposal out → it is withdrawn; several → "Which visit?" with a numbered
// list, the pick parked on the session the way the in-shift keywords park
// theirs (a number or the family's name answers; CANCEL / NO backs out).
export const WITHDRAW_CHOICE_TTL_MS = 30 * 60 * 1000;
export interface PendingWithdrawChoice { candidates: Array<{ shiftId: string; line: string }>; at: string; expiresAt: string }
export const whichProposalPrompt = (candidates: Array<{ line: string }>) =>
  `Which visit? ${candidates.map((c, i) => `Reply ${i + 1} for ${c.line}`).join(", ")}.`;
export const withdrawnLine = (r: Extract<ProposalDecisionResult, { ok: true }>) =>
  `Withdrawn — your visit with ${r.clientName} stays at ${visitWhen(r.from)}.`;

export async function handleWithdrawKeyword(
  phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>,
  deps: { say: (m: string) => Promise<unknown>; nowMs?: number },
): Promise<"handled" | "passthrough"> {
  const nowMs = deps.nowMs ?? Date.now();
  const raw = text.trim();
  const upper = raw.toUpperCase().replace(/\s+/g, " ");
  const sessRef = db.collection("agent_sessions").doc(phone);
  const clearChoice = () => sessRef.update({ pendingWithdrawChoice: admin.firestore.FieldValue.delete() }).catch(() => {});

  const choice = session.pendingWithdrawChoice as PendingWithdrawChoice | undefined;
  if (choice?.candidates?.length) {
    if (Date.parse(choice.expiresAt) < nowMs) { await clearChoice(); }
    else {
      if (upper === "CANCEL" || upper === "NO") { await clearChoice(); await deps.say("Okay — nothing changed."); return "handled"; }
      const n = /^\d+$/.test(raw) ? Number(raw) : null;
      const lower = raw.toLowerCase();
      const byName = lower.length >= 3 ? choice.candidates.filter((c) => c.line.toLowerCase().includes(lower)) : [];
      const picked = n !== null ? choice.candidates[n - 1] : byName.length === 1 ? byName[0] : undefined;
      if (!picked) { await deps.say(whichProposalPrompt(choice.candidates)); return "handled"; }
      await clearChoice();
      const r = await withdrawOwnShiftProposal(caregiverId, picked.shiftId, "sms:withdraw");
      await deps.say(r.ok ? withdrawnLine(r) : "That proposal isn't pending any more — nothing changed.");
      return "handled";
    }
  }

  if (upper !== "WITHDRAW" && upper !== "WITHDRAW PROPOSAL" && upper !== "WITHDRAW IT") return "passthrough";
  const mine = await listPendingProposals(caregiverId, "caregiver");
  if (mine.length === 0) { await deps.say("You don't have a reschedule proposal out on any visit — nothing to withdraw."); return "handled"; }
  if (mine.length === 1) {
    const r = await withdrawOwnShiftProposal(caregiverId, mine[0].shiftId, "sms:withdraw");
    await deps.say(r.ok ? withdrawnLine(r) : "That proposal isn't pending any more — nothing changed.");
    return "handled";
  }
  const candidates = mine.map((m) => ({ shiftId: m.shiftId, line: `${m.line} (proposed ${m.proposed})` }));
  await sessRef.set({ pendingWithdrawChoice: { candidates, at: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + WITHDRAW_CHOICE_TTL_MS).toISOString() } satisfies PendingWithdrawChoice }, { merge: true }).catch(() => {});
  await deps.say(whichProposalPrompt(candidates));
  return "handled";
}
