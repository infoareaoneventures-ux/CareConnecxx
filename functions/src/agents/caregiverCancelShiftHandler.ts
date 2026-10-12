import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { isQuestionOrOther, answerMidFlow as answerMidFlowShared } from "./stepHandler";
import { businessTodayStr } from "../utils/scheduledTime";
import { fmtDate, fmtTime } from "./caregiverBookingRequests";
import { isShiftOverdue } from "./shiftReschedule";
// The two writes are the shared server rule's (shifts/visitActions.ts, 2026-10-11): the same cancelVisit /
// cancelBooking the site's ✕ and Cancel Booking reach through the visit_action_requests queue.
import { cancelVisit, cancelBooking } from "../shifts/visitActions";

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

// A mid-flow question is answered FROM what is on the caregiver's screen (founder 2026-10-11): the dialog or the
// numbered list they were just sent, plus what the page's cancel actually does — never a static sentence the
// model could pad with an invented fee or policy, and never a claim that anything was cancelled.
const answerMidFlow = (text: string, reAsk: string, facts: string) => answerMidFlowShared(text, reAsk, { audience: "caregiver", facts });
/** What the Bookings page's cancel actually does (verified: it writes status, cancelledBy, updatedAt and nothing else). */
export const CANCEL_RULES =
  "A visit that starts within 24 hours is marked needs_replacement — the family is offered a replacement care provider; any other visit is marked cancelled. " +
  "It is recorded as cancelled by the care provider and the family is notified, exactly as when the site's cancel button is used. " +
  "No fee, charge or penalty is applied to the care provider — only the visit's status changes. " +
  "Within 24 hours of a visit, cancelling is the only option (rescheduling is not offered that close to the start). " +
  "'This visit only' cancels one visit and the rest of the booking stays active; 'the whole booking' cancels this visit and every future scheduled visit of that booking, and the booking itself is closed when none of them was urgent.";
/** The dialog's facts: nothing has happened yet, what YES would do for THIS option, and the page's rules. */
export const CANCEL_FACTS = (o: CancelOption) =>
  `Nothing has been cancelled yet; YES cancels, NO keeps it. ${o.kind === "booking"
    ? `YES cancels this visit and every future scheduled visit of the booking with ${o.clientName} (${o.count ?? 0} visits).`
    : `YES cancels only this one visit (${optionLine(o)}).`} ${CANCEL_RULES}`;

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

/**
 * The ✕'s write (CaregiverBookingsPage BookingGroupCard.handleCancelShift) —
 * shifts/visitActions.ts cancelVisit. `caregiverId` enforces ownership (Evia's
 * CANCEL flow); the system path (`cancelledBy: 'system'`, the membership lock in
 * triggers/caregiverAccountEvents.ts) passes none.
 */
export async function cancelShiftLikeThePage(shiftId: string, cancelledBy: "caregiver" | "system" = "caregiver", caregiverId: string | null = null): Promise<{ ok: true; status: "needs_replacement" | "cancelled" } | { ok: false; reason: "not_found" | "not_scheduled" | "not_yours"; status?: string }> {
  const r = await cancelVisit({ caregiverId, shiftId, cancelledBy });
  if (r.ok) return { ok: true, status: r.status };
  if (r.reason === "not_scheduled") return { ok: false, reason: "not_scheduled", status: r.status };
  if (r.reason === "not_yours") return { ok: false, reason: "not_yours" };
  return { ok: false, reason: "not_found" };
}

/** The Cancel Booking button's write (CaregiverBookingsPage.handleCancelShift) — shifts/visitActions.ts cancelBooking, plus the page's toast. */
export async function cancelBookingLikeThePage(caregiverId: string, shiftId: string): Promise<{ ok: true; anyUrgent: boolean; count: number; toast: string } | { ok: false; reason: "not_found" | "not_scheduled" | "not_yours"; status?: string }> {
  const r = await cancelBooking({ caregiverId, shiftId });
  if (!r.ok) {
    if (r.reason === "not_scheduled") return { ok: false, reason: "not_scheduled", status: r.status };
    if (r.reason === "not_yours") return { ok: false, reason: "not_yours" };
    return { ok: false, reason: "not_found" };
  }
  // The page's toasts.
  return { ok: true, anyUrgent: r.anyUrgent, count: r.count, toast: r.anyUrgent ? "Cancelled — the family can pick a replacement for the urgent shift" : "Booking cancelled" };
}

/** "cancel tomorrow's shift" / "cancel the booking with Basra" → the option it names, else null. */
export async function resolveOptionFromText(text: string, options: CancelOption[]): Promise<CancelOption | null> {
  if (options.length === 0) return null;
  const raw = await parseWithClaude(
    `A care provider wrote a message about cancelling. These are the things they could cancel:\n${options.map((o) => `${o.index}. ${optionLine(o)}`).join("\n")}\n` +
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
    // (2026-10-11: this regex was written with `s+` for `\s+`, so "CANCEL SHIFT" / "cancel my booking" were not bare
    // keywords here — hidden until now because the router's CANCEL_PHRASES matched them first.)
    const bare = /^CANCEL(\s+(MY\s+|A\s+)?(SHIFT|VISIT|BOOKING))?$/i.test(text.trim());
    const named = bare ? null : await resolveOptionFromText(text, options);
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
      // The screen is the whole dialog (the option line + the page's question); the facts are what YES actually writes.
      if (norm !== "YES" && norm !== "NO" && await isQuestionOrOther(text, confirm)) { await sendMessage(chatId, await answerMidFlow(text, confirmFor(chosen), CANCEL_FACTS(chosen))); return; }
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
        const r = await cancelShiftLikeThePage(chosen.id, "caregiver", caregiverId);
        if (!r.ok) { await sendMessage(chatId, r.reason === "not_scheduled" ? `That shift is already ${r.status} — nothing to cancel.` : "That shift isn't on your bookings any more."); return; }
        await sendMessage(chatId, r.status === "needs_replacement"
          ? `Cancelled — ${optionLine(chosen)}. It starts within 24 hours, so the family is being offered a replacement care provider.`
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
    // The screen is the numbered list they were just sent; the facts are what cancelling does (nothing yet).
    if (await isQuestionOrOther(text, reAskPick)) {
      const facts = `The numbered list on their screen:\n${listText(options)}\n\nNothing is cancelled by picking a number — a YES/NO dialog follows. ${CANCEL_RULES}`;
      await sendMessage(chatId, await answerMidFlow(text, reAskPick, facts));
      return;
    }
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
