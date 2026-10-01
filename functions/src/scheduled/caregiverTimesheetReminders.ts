// scheduled/caregiverTimesheetReminders.ts — the caregiver's two Timesheets
// reminders (founder, 2026-10-01: "what is the nudge or reminder for time
// submittal and corrections as they come" → the page only had the red badge →
// "yes" to adding both, on both sides: a bell the Payments page shows + a text).
//
//   • Unsubmitted hours — a visit ended (or was logged) a day ago and still has
//     no shiftHours record: "Reply SUBMIT". Once per visit, only while the visit
//     ended within the last week, so a deploy never texts about ancient visits.
//   • Correction waiting — the family proposed a correction and the caregiver
//     hasn't answered; 3 hours before the 24-hour auto-accept: "Reply REVIEW".
//     Once per correction.
// Plain fixed sentences (no model). Bell type starts with "shift_hours" → the
// Timesheets tab on both sides (utils/notificationRoutes.ts, notificationsPage.ts).
// Hourly.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";
import { businessTodayStr, DEFAULT_TZ } from "../utils/scheduledTime";
import { queryVisits } from "../utils/visitQuery";

const db = admin.firestore();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Remind about unsubmitted hours once the visit ended a day ago … */
export const UNSUBMITTED_AFTER_MS = DAY_MS;
/** … but never for a visit that ended more than a week ago. */
export const UNSUBMITTED_MAX_AGE_MS = 7 * DAY_MS;
/** Remind about a correction this long before it auto-accepts. */
export const CORRECTION_WARN_MS = 3 * HOUR_MS;

export function tsMs(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isNaN(ms) ? null : ms; }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    const o = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof o.toMillis === "function") return o.toMillis();
    const s = typeof o.seconds === "number" ? o.seconds : typeof o._seconds === "number" ? o._seconds : null;
    return s === null ? null : s * 1000;
  }
  return null;
}
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, month: "short", day: "numeric" });

/** Pure decision: a day after the visit ended, within a week, once. */
export function shouldRemindUnsubmitted(completedMs: number | null, nowMs: number, alreadySent: boolean): boolean {
  if (completedMs === null || alreadySent) return false;
  return nowMs >= completedMs + UNSUBMITTED_AFTER_MS && nowMs <= completedMs + UNSUBMITTED_MAX_AGE_MS;
}
/** Pure decision: inside the last 3 hours before the auto-accept, once. */
export function correctionReminderDue(respondByMs: number | null, nowMs: number, alreadySent: boolean): boolean {
  if (respondByMs === null || alreadySent) return false;
  const left = respondByMs - nowMs;
  return left > 0 && left <= CORRECTION_WARN_MS;
}
export function hoursLeftLabel(respondByMs: number, nowMs: number): string {
  const h = Math.max(1, Math.ceil((respondByMs - nowMs) / HOUR_MS));
  return `${h} hour${h === 1 ? "" : "s"}`;
}

export function unsubmittedText(shift: FirebaseFirestore.DocumentData, completedMs: number): string {
  return `Your ${shortDate(completedMs)} visit with ${String(shift.clientName || "the family")} still has no hours submitted. Reply SUBMIT to submit them.`;
}
export function correctionText(row: FirebaseFirestore.DocumentData, respondByMs: number, nowMs: number): string {
  const when = tsMs(row.submittedStartTime);
  return `${String(row.clientName || "The family")}'s correction to your ${when !== null ? `${shortDate(when)} ` : ""}hours auto-accepts in ${hoursLeftLabel(respondByMs, nowMs)}. Reply REVIEW to accept it or send a counter.`;
}

async function notify(opts: { caregiverId: string; text: string; bellBody: string; sourcePath: string; eventId: string; type: string; title: string; data: Record<string, unknown>; sourceAgent: string }): Promise<boolean> {
  // Bell first (idempotent per source + event), then the text with the same words.
  await writeUserNotification({
    sourcePath: opts.sourcePath, eventId: opts.eventId, recipientId: opts.caregiverId,
    transitionType: opts.type, type: opts.type, title: opts.title, body: opts.bellBody, data: opts.data,
  }).catch((err) => console.error("[caregiverTimesheetReminders] bell failed:", opts.sourcePath, err));
  const phone = await resolveCaregiverPhone(opts.caregiverId);
  const sess = phone ? await db.collection("agent_sessions").doc(phone).get().catch(() => null) : null;
  if (!phone || !sess?.exists || sess.data()?.optedOut) return false;
  return sendViaInteractionAgent(phone, { content: opts.text, urgency: "standard", sourceAgent: opts.sourceAgent, canDrop: false });
}

export async function runCaregiverTimesheetReminders(nowMs = Date.now()): Promise<{ unsubmitted: number; corrections: number; skipped: number }> {
  const out = { unsubmitted: 0, corrections: 0, skipped: 0 };

  // ── Unsubmitted hours: completed visits from the last week with no shiftHours doc ──
  const today = businessTodayStr(undefined, new Date(nowMs));
  const weekAgo = businessTodayStr(undefined, new Date(nowMs - UNSUBMITTED_MAX_AGE_MS - DAY_MS));
  const completed = await queryVisits({ dateOp: ">=", dateValue: weekAgo, dateUpperBound: today, shiftStatuses: ["completed"] });
  for (const doc of completed) {
    const v = doc.data();
    const completedMs = tsMs(v.completedAt);
    if (!shouldRemindUnsubmitted(completedMs, nowMs, !!v.caraSubmitReminderSentAt)) { out.skipped++; continue; }
    const caregiverId = String(v.caregiverId ?? "");
    if (!caregiverId) { out.skipped++; continue; }
    const hoursDoc = await db.collection("shiftHours").doc(String(v.appointmentId || doc.id)).get().catch(() => null);
    if (hoursDoc?.exists) { out.skipped++; continue; } // the page would not list it under Unsubmitted
    try {
      const text = unsubmittedText(v, completedMs as number);
      await notify({
        caregiverId, text, bellBody: text.replace(/ Reply SUBMIT to submit them\.$/, " Submit them on your Timesheets page."),
        sourcePath: `shifts/${doc.id}`, eventId: "submit-reminder", type: "shift_hours_unsubmitted", title: "Hours not submitted",
        data: { shiftId: doc.id }, sourceAgent: "timesheet_submit_reminder",
      });
      await doc.ref.update({ caraSubmitReminderSentAt: new Date(nowMs).toISOString() }).catch(() => {});
      out.unsubmitted++;
    } catch (err) { console.error("[caregiverTimesheetReminders] unsubmitted:", doc.id, err); }
  }

  // ── Corrections waiting: 3 hours before the family's proposal auto-accepts ──
  const corrections = await db.collection("shiftHours").where("status", "==", "correction_proposed").get();
  for (const doc of corrections.docs) {
    const r = doc.data();
    const respondByMs = tsMs(r.correctionRespondByAt);
    if (!correctionReminderDue(respondByMs, nowMs, !!r.caraCorrectionReminderSentAt)) { out.skipped++; continue; }
    const caregiverId = String(r.caregiverId ?? "");
    if (!caregiverId) { out.skipped++; continue; }
    try {
      const text = correctionText(r, respondByMs as number, nowMs);
      await notify({
        caregiverId, text, bellBody: text.replace(/ Reply REVIEW to accept it or send a counter\.$/, " Review it on your Timesheets page."),
        sourcePath: `shiftHours/${doc.id}`, eventId: "correction-reminder", type: "shift_hours_correction_reminder", title: "Correction awaiting your answer",
        data: { appointmentId: doc.id }, sourceAgent: "timesheet_correction_reminder",
      });
      await doc.ref.update({ caraCorrectionReminderSentAt: new Date(nowMs).toISOString() }).catch(() => {});
      out.corrections++;
    } catch (err) { console.error("[caregiverTimesheetReminders] correction:", doc.id, err); }
  }
  return out;
}

export const sendCaregiverTimesheetReminders = functions.pubsub
  .schedule("0 * * * *")
  .onRun(async () => { await runCaregiverTimesheetReminders(); });
