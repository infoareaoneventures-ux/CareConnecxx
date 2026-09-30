// scheduled/shiftEndReminder.ts — "did you forget to finish?" (founder, 2026-09-29:
// "when a shift passes the end time does the caregiver get notified to complete
// or finish the shift in case they forgot" → nothing did, on either side → "okay").
//
// Two one-time reminders, 15 minutes after a visit's scheduled end, texted and
// mirrored to the caregiver's bell (type starts with "shift" → the Bookings page):
//   • still running — the visit is still `in-progress`: text FINISH / open the page.
//     Hours are only created from a completed shift, so an unfinished visit is
//     never billed or paid until it is ended.
//   • missed — the visit is still `scheduled` (never started): the page shows it
//     as Missed with Log Hours; the text says reply LOG.
// Plain fixed sentences (no model). Each fires once per visit (stamped on the
// shift) and only while the end passed within the last 24h, so a deploy never
// texts about ancient visits. Every 15 minutes.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";
import { businessTodayStr, parseScheduledTimeMs, formatHHMMForDisplay } from "../utils/scheduledTime";
import { visitPageLink } from "../agents/inShift";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();
export const GRACE_MS = 15 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The visit's scheduled end as a business-timezone instant; an end clock before the start means it crosses midnight. */
export function scheduledEndMs(v: { date?: unknown; startTime?: unknown; endTime?: unknown }): number | null {
  const date = String(v.date ?? "");
  const start = String(v.startTime ?? "");
  const end = String(v.endTime ?? start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(end)) return null;
  const [h, m] = end.split(":").map(Number);
  let ms = parseScheduledTimeMs(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  if (!Number.isFinite(ms)) return null;
  if (/^\d{1,2}:\d{2}$/.test(start) && end < start.padStart(5, "0")) ms += DAY_MS;
  return ms;
}

/** Pure decision: remind now? (once the grace passed, and not more than a day later). */
export function shouldRemind(endMs: number | null, nowMs: number, alreadySent: boolean): boolean {
  if (endMs === null || alreadySent) return false;
  return nowMs >= endMs + GRACE_MS && nowMs <= endMs + MAX_AGE_MS;
}

export function stillRunningText(v: FirebaseFirestore.DocumentData, shiftId: string): string {
  const who = visitSeniorName(v, "your client");
  return `${who}'s visit was scheduled to end at ${formatHHMMForDisplay(String(v.endTime ?? ""))} and is still in progress. Text FINISH when you're done, or open it here: ${visitPageLink(shiftId)}`;
}
export function missedText(v: FirebaseFirestore.DocumentData): string {
  const family = String(v.clientName || visitSeniorName(v, "the family"));
  return `Your ${formatHHMMForDisplay(String(v.startTime ?? ""))} visit with ${family} wasn't started. If you did the visit, reply LOG to log the hours. If not, no action needed.`;
}

async function remind(doc: FirebaseFirestore.QueryDocumentSnapshot, kind: "running" | "missed", nowMs: number): Promise<boolean> {
  const v = doc.data();
  const caregiverId = String(v.caregiverId ?? "");
  if (!caregiverId) return false;
  const text = kind === "running" ? stillRunningText(v, doc.id) : missedText(v);
  const stamp = kind === "running" ? "caraEndReminderSentAt" : "caraMissedReminderSentAt";
  // Bell first (idempotent per visit), then the text with the same words.
  await writeUserNotification({
    sourcePath: `shifts/${doc.id}`, eventId: kind === "running" ? "end-reminder" : "missed-reminder", recipientId: caregiverId,
    transitionType: kind === "running" ? "shift_end_reminder" : "shift_missed",
    type: kind === "running" ? "shift_end_reminder" : "shift_missed",
    title: kind === "running" ? "Visit still in progress" : "Visit not started",
    body: text.replace(/ Text FINISH when you're done, or open it here: \S+$/, " Finish it from your Bookings page."),
    data: { shiftId: doc.id },
  }).catch((err) => console.error("[shiftEndReminder] bell failed:", doc.id, err));
  let sent = false;
  const phone = await resolveCaregiverPhone(caregiverId);
  const sess = phone ? await db.collection("agent_sessions").doc(phone).get().catch(() => null) : null;
  if (phone && sess?.exists && !sess.data()?.optedOut) {
    sent = await sendViaInteractionAgent(phone, { content: text, urgency: "standard", sourceAgent: kind === "running" ? "shift_end_reminder" : "shift_missed_reminder", canDrop: false });
  }
  await doc.ref.update({ [stamp]: new Date(nowMs).toISOString() }).catch(() => {});
  return sent;
}

export async function runShiftEndReminders(nowMs = Date.now()): Promise<{ running: number; missed: number; skipped: number }> {
  const out = { running: 0, missed: 0, skipped: 0 };
  const today = businessTodayStr(undefined, new Date(nowMs));
  const yesterday = businessTodayStr(undefined, new Date(nowMs - DAY_MS));
  const [inProgress, scheduled] = await Promise.all([
    queryVisits({ shiftStatuses: ["in-progress"] }),
    queryVisits({ dateOp: ">=", dateValue: yesterday, dateUpperBound: today, shiftStatuses: ["scheduled"] }),
  ]);
  for (const doc of inProgress) {
    const v = doc.data();
    if (!shouldRemind(scheduledEndMs(v), nowMs, !!v.caraEndReminderSentAt)) { out.skipped++; continue; }
    try { await remind(doc, "running", nowMs); out.running++; } catch (err) { console.error("[shiftEndReminder] running:", doc.id, err); }
  }
  for (const doc of scheduled) {
    const v = doc.data();
    if (!shouldRemind(scheduledEndMs(v), nowMs, !!v.caraMissedReminderSentAt)) { out.skipped++; continue; }
    try { await remind(doc, "missed", nowMs); out.missed++; } catch (err) { console.error("[shiftEndReminder] missed:", doc.id, err); }
  }
  return out;
}

export const sendShiftEndReminders = functions.pubsub
  .schedule("*/15 * * * *")
  .onRun(async () => { await runShiftEndReminders(); });
