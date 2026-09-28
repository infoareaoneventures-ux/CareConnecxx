import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { answerHumanMidFlow } from "./humanReply";
import { businessTodayStr, parseScheduledTimeMs } from "../utils/scheduledTime";
import { fmtDate, fmtTime } from "./caregiverBookingRequests";
import { isShiftOverdue } from "./shiftReschedule";

const db = admin.firestore();

/**
 * The caregiver Bookings page's two cancel buttons, over text — each with the
 * page's own dialog and the page's own write, nothing more (2026-09-28):
 *
 *   ✕ on an upcoming visit  → "Cancel this shift only? The rest of your booking
 *                              stays active."  → {status: needs_replacement
 *                              (starts within 24h) | cancelled, cancelledBy:
 *                              'caregiver', updatedAt}
 *   Cancel Booking (card)    → "Cancel this shift and all future scheduled
 *                              shifts for this booking?" → the same patch on
 *                              this booking's every scheduled visit (batch),
 *                              and booking_requests → cancelled when none of
 *                              them was urgent
 *
 *   identify → the options the page shows (each visit with a ✕, then "the
 *              whole booking with X" per booking), numbered; a message that
 *              already names one ("cancel tomorrow's shift", "cancel the
 *              booking with Basra") skips the list
 *   confirm  → the matching dialog; YES → the matching write; NO / CANCEL back out
 *
 * The family's notice comes from onShiftStatusChanged, exactly as on the site.
 * Entry: the CANCEL keyword, or the CANCEL_SHIFT intent (routeIntent).
 */

export interface CancelOption {
  index:      number;
  kind:       "visit" | "booking";
  /** the shift id (visit), or the booking's earliest scheduled shift id (booking — what the page's button passes) */
  id:         string;
  bookingRequestId: string | null;
  date:       string;
  startTime:  string;
  endTime?:   string;
  clientName: string;
  clientId:   string;
  /** booking: how many scheduled visits it covers */
  count?:     number;
}

const CONFIRM_VISIT   = "Cancel this shift only? The rest of your booking stays active. Reply YES to cancel, or NO to keep it.";
const CONFIRM_BOOKING = "Cancel this shift and all future scheduled shifts for this booking? Reply YES to cancel, or NO to keep it.";

const CLEAR = {
  cancelStep:          admin.firestore.FieldValue.delete(),
  cancelCandidates:    admin.firestore.FieldValue.delete(),
  cancelShiftId:       admin.firestore.FieldValue.delete(),
  cancelKind:          admin.firestore.FieldValue.delete(),
  cancelShiftDate:     admin.firestore.FieldValue.delete(),
  cancelShiftClientId: admin.firestore.FieldValue.delete(),
  stateExpiresAt:      admin.firestore.FieldValue.delete(),
};

export function optionLine(o: CancelOption): string {
  if (o.kind === "booking") return `The whole booking with ${o.clientName} — every upcoming visit (${o.count ?? 0})`;
  return `${fmtDate(o.date)} at ${fmtTime(o.startTime)}${o.endTime ? ` – ${fmtTime(o.endTime)}` : ""} — ${o.clientName} (this visit only)`;
}
const confirmFor = (o: CancelOption) => `${optionLine(o)}.\n\n${o.kind === "booking" ? CONFIRM_BOOKING : CONFIRM_VISIT}`;
const listText = (opts: CancelOption[]) => `What do you need to cancel?\n${opts.map((o) => `${o.index}. ${optionLine(o)}`).join("\n")}\n\nReply with the number, or CANCEL to back out.`;

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The caregiver is cancelling a visit or a booking. Current step's question: "${currentQuestion}". ` +
      "Reply YES if their message is a general question or off-topic comment unrelated to that question. " +
      "Reply NO if it is a direct answer. Only reply YES or NO.",
    text,
    5,
  );
  return result.toUpperCase().startsWith("Y");
}
async function answerMidFlow(text: string, reAsk: string): Promise<string> {
  return answerHumanMidFlow({ audience: "caregiver", situation: "caregiver is cancelling one of their upcoming visits or a booking", text, reAsk });
}

/** The page's options: every visit with a ✕ (scheduled, today or later, not overdue), then one "whole booking" per booking. */
export async function loadCancelOptions(caregiverId: string): Promise<CancelOption[]> {
  const today = businessTodayStr();
  const snap = await db.collection("shifts")
    .where("caregiverId", "==", caregiverId)
    .where("status", "in", ["scheduled"])
    .where("date", ">=", today)
    .orderBy("date", "asc")
    .limit(60)
    .get();
  const visits = snap.docs
    .filter((d) => d.data().caregiverId === caregiverId && d.data().status === "scheduled" && !isShiftOverdue(d.data()))
    .sort((a, b) => String(a.data().date).localeCompare(String(b.data().date)) || String(a.data().startTime ?? "").localeCompare(String(b.data().startTime ?? "")));
  const out: CancelOption[] = visits.slice(0, 5).map((d, i) => ({
    index: i + 1, kind: "visit" as const, id: d.id, bookingRequestId: (d.data().bookingRequestId as string | undefined) ?? null,
    date: String(d.data().date ?? ""), startTime: String(d.data().startTime ?? ""), endTime: d.data().endTime ? String(d.data().endTime) : undefined,
    clientName: String(d.data().clientName ?? "the family"), clientId: String(d.data().clientId ?? ""),
  }));
  const byBooking = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const d of visits) { const key = String(d.data().bookingRequestId || d.id); if (!byBooking.has(key)) byBooking.set(key, []); byBooking.get(key)!.push(d); }
  for (const [key, list] of byBooking) {
    const first = list[0];
    out.push({
      index: out.length + 1, kind: "booking", id: first.id, bookingRequestId: first.data().bookingRequestId ? key : null,
      date: String(first.data().date ?? ""), startTime: String(first.data().startTime ?? ""), endTime: first.data().endTime ? String(first.data().endTime) : undefined,
      clientName: String(first.data().clientName ?? "the family"), clientId: String(first.data().clientId ?? ""), count: list.length,
    });
  }
  return out;
}

const urgent = (s: FirebaseFirestore.DocumentData): boolean => {
  const startsMs = parseScheduledTimeMs(`${String(s.date ?? "")}T${String(s.startTime ?? "00:00").slice(0, 5)}:00`);
  return Number.isFinite(startsMs) && startsMs > 0 ? (startsMs - Date.now()) / (1000 * 60 * 60) <= 24 : false;
};

/** The ✕'s write (CaregiverBookingsPage BookingGroupCard.handleCancelShift). */
export async function cancelShiftLikeThePage(shiftId: string): Promise<{ ok: true; status: "needs_replacement" | "cancelled" } | { ok: false; reason: "not_found" | "not_scheduled"; status?: string }> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const shift = snap.data() ?? {};
  if (shift.status !== "scheduled") return { ok: false, reason: "not_scheduled", status: String(shift.status ?? "") };
  const status = urgent(shift) ? "needs_replacement" as const : "cancelled" as const;
  await ref.update({ status, cancelledBy: "caregiver", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, status };
}

/** The Cancel Booking button's write (CaregiverBookingsPage.handleCancelShift): this shift + every future scheduled shift of the booking, then the booking itself when none was urgent. */
export async function cancelBookingLikeThePage(caregiverId: string, shiftId: string): Promise<{ ok: true; anyUrgent: boolean; count: number; toast: string } | { ok: false; reason: "not_found" | "not_scheduled"; status?: string }> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const shift = snap.data() ?? {};
  if (shift.status !== "scheduled") return { ok: false, reason: "not_scheduled", status: String(shift.status ?? "") };
  const bookingRequestId = shift.bookingRequestId as string | undefined;
  const batch = db.batch();
  let anyUrgent = false;
  let count = 0;
  const applyCancel = (r: FirebaseFirestore.DocumentReference, s: FirebaseFirestore.DocumentData) => {
    const u = urgent(s);
    if (u) anyUrgent = true;
    count += 1;
    batch.update(r, { status: u ? "needs_replacement" : "cancelled", cancelledBy: "caregiver", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  };
  applyCancel(ref, shift);
  if (bookingRequestId) {
    const future = await db.collection("shifts")
      .where("bookingRequestId", "==", bookingRequestId)
      .where("status", "==", "scheduled")
      .where("caregiverId", "==", caregiverId)
      .get();
    future.docs.forEach((d) => { if (d.id !== shiftId && d.data().status === "scheduled" && d.data().caregiverId === caregiverId) applyCancel(d.ref, d.data()); });
    await batch.commit();
    if (!anyUrgent) {
      await db.collection("booking_requests").doc(bookingRequestId).update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
  } else {
    await batch.commit();
  }
  // The page's toasts.
  return { ok: true, anyUrgent, count, toast: anyUrgent ? "Cancelled — the family can pick a replacement for the urgent shift" : "Booking cancelled" };
}

/** "cancel tomorrow's shift" / "cancel the booking with Basra" → the option it names, else null. */
export async function resolveOptionFromText(text: string, options: CancelOption[]): Promise<CancelOption | null> {
  if (options.length === 0) return null;
  const raw = await parseWithClaude(
    `A caregiver wrote a message about cancelling. These are the things they could cancel:\n${options.map((o) => `${o.index}. ${optionLine(o)}`).join("\n")}\n` +
      `Today is ${businessTodayStr()}. If the message clearly refers to exactly ONE of these (by day, date, family, or "the whole booking" / "all my shifts with"), reply with its number. ` +
      `If it just says they need to cancel something, or it is unclear which, reply 0. Reply with only the number.`,
    text,
    5,
  );
  const n = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  return options.find((o) => o.index === n) ?? null;
}

async function parkChoice(sessionRef: FirebaseFirestore.DocumentReference, o: CancelOption, expires: string): Promise<void> {
  await sessionRef.update({ cancelShiftId: o.id, cancelKind: o.kind, cancelShiftDate: o.date, cancelShiftClientId: o.clientId, stateExpiresAt: expires });
}

export async function handleCaregiverCancelShift(
  caregiverId:    string,
  _caregiverName: string,
  caregiverPhone: string,
  text:           string,
  session:        Record<string, unknown>,
  chatId:         string,
): Promise<void> {
  const step = (session.cancelStep as string) ?? "identify_shift";
  const sessionRef = db.collection("agent_sessions").doc(caregiverPhone);
  const expires = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();

  if (step === "identify_shift") {
    const options = await loadCancelOptions(caregiverId);
    if (options.length === 0) {
      await sendMessage(chatId, "You don't have any upcoming shifts to cancel.");
      await sessionRef.update({ cancelStep: admin.firestore.FieldValue.delete() });
      return;
    }
    await sessionRef.update({ cancelStep: "confirm_shift", cancelCandidates: JSON.stringify(options), stateExpiresAt: expires() });
    // A message that already names one thing skips the list (the bare CANCEL keyword never does).
    const named = text.trim().toUpperCase() === "CANCEL" ? null : await resolveOptionFromText(text, options);
    if (named) {
      await parkChoice(sessionRef, named, expires());
      await sendMessage(chatId, confirmFor(named));
      return;
    }
    await sendMessage(chatId, listText(options));
    return;
  }

  if (step === "confirm_shift") {
    const options: CancelOption[] = (() => { try { return JSON.parse((session.cancelCandidates as string) ?? "[]"); } catch { return []; } })();
    if (options.length === 0) {
      await sessionRef.update({ cancelStep: "identify_shift", cancelCandidates: admin.firestore.FieldValue.delete() });
      await sendMessage(chatId, "Something went wrong — let me start over. What do you need to cancel?");
      return;
    }
    if (text.trim().toUpperCase() === "CANCEL") {
      await sessionRef.update(CLEAR);
      await sendMessage(chatId, "No problem — your shifts are unchanged.");
      return;
    }

    const chosenId = session.cancelShiftId as string | undefined;
    const chosen = chosenId ? options.find((o) => o.id === chosenId && o.kind === ((session.cancelKind as string) || o.kind)) ?? options.find((o) => o.id === chosenId) : undefined;
    if (chosen) {
      const confirm = chosen.kind === "booking" ? CONFIRM_BOOKING : CONFIRM_VISIT;
      // "Reply YES or NO" — a bare YES / NO is the strict protocol; anything else is checked for a question first.
      const norm = text.trim().toUpperCase();
      if (norm !== "YES" && norm !== "NO" && await isQuestionOrOther(text, confirm)) { await sendMessage(chatId, await answerMidFlow(text, confirm)); return; }
      const decision = norm === "YES" || norm === "NO" ? norm : await parseWithClaude(
        '"yes", "yeah", "confirm", "do it", "cancel it" → YES. "no", "wait", "never mind", "keep it", "back" → NO. Reply with exactly YES or NO.',
        text, 5,
      );
      if (decision === "YES") {
        await sessionRef.update(CLEAR);
        if (chosen.kind === "booking") {
          const r = await cancelBookingLikeThePage(caregiverId, chosen.id);
          if (!r.ok) { await sendMessage(chatId, r.reason === "not_scheduled" ? `That booking's next visit is already ${r.status} — nothing to cancel.` : "That booking isn't on your bookings any more."); return; }
          await sendMessage(chatId, `${r.toast} — ${chosen.clientName}, ${r.count} visit${r.count === 1 ? "" : "s"}. The family has been notified.`);
          return;
        }
        const r = await cancelShiftLikeThePage(chosen.id);
        if (!r.ok) { await sendMessage(chatId, r.reason === "not_scheduled" ? `That shift is already ${r.status} — nothing to cancel.` : "That shift isn't on your bookings any more."); return; }
        await sendMessage(chatId, r.status === "needs_replacement"
          ? `Cancelled — ${optionLine(chosen)}. It starts within 24 hours, so the family is being offered a replacement caregiver.`
          : `Cancelled — ${optionLine(chosen)}. The family has been notified.`);
        return;
      }
      if (decision === "NO") {
        if (options.length === 1) { await sessionRef.update(CLEAR); await sendMessage(chatId, "Okay — keeping it. Your shifts are unchanged."); return; }
        await sessionRef.update({ cancelShiftId: admin.firestore.FieldValue.delete(), cancelKind: admin.firestore.FieldValue.delete(), cancelShiftDate: admin.firestore.FieldValue.delete(), cancelShiftClientId: admin.firestore.FieldValue.delete() });
        await sendMessage(chatId, `Okay — keeping that one.\n${options.map((o) => `${o.index}. ${optionLine(o)}`).join("\n")}\n\nReply with another number, or CANCEL to back out.`);
        return;
      }
      await sendMessage(chatId, confirm);
      return;
    }

    const reAskPick = `Reply with the number of what to cancel (1–${options.length}), or CANCEL to back out.`;
    if (await isQuestionOrOther(text, reAskPick)) { await sendMessage(chatId, await answerMidFlow(text, reAskPick)); return; }
    const pick = parseInt(text.trim(), 10);
    const option = options.find((o) => o.index === pick) ?? (Number.isNaN(pick) ? await resolveOptionFromText(text, options) : null);
    if (!option) { await sendMessage(chatId, `Please reply with a number between 1 and ${options.length}, or CANCEL to back out.`); return; }
    await parkChoice(sessionRef, option, expires());
    await sendMessage(chatId, confirmFor(option));
    return;
  }

  await sessionRef.update(CLEAR);
  await sendMessage(chatId, "Let's start over — what do you need to cancel?");
}
