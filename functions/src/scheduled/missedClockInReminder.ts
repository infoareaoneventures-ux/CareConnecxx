// scheduled/missedClockInReminder.ts — "you haven't clocked in" one minute after a visit's start (founders, 2026-11-25:
// "should remind you if you missed clock in, at clock in. If it starts at 9, it should send a reminder at 9:01").
//
// The 30-minute heads-up (thirtyMinShiftReminder) says "start when you get there"; until now nothing said anything at the
// start time itself, and the next text was the "wasn't started" one 15 minutes after the visit's END. This is the middle one:
// a visit still `scheduled` one minute after its start gets one plain text and a bell, once (stamped on the shift), for the
// next hour only (after that the missed-visit text owns it, and a deploy never texts about old visits). Every minute.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { writeUserNotification } from "../notifications/userNotification";
import { resolveCaregiverPhone } from "../utils/caregiverPhone";
import { businessTodayStr, formatHHMMForDisplay } from "../utils/scheduledTime";
import { careZoneOf, wallToInstantMs } from "../utils/careTime";
import { visitPageLink } from "../agents/inShift";
import { queryVisits, visitSeniorName } from "../utils/visitQuery";

const db = admin.firestore();
export const CLOCK_IN_GRACE_MS = 60 * 1000;
export const CLOCK_IN_WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The visit's scheduled start as an instant in the visit's own care-location zone. */
export function scheduledStartMs(v: { date?: unknown; startTime?: unknown } & Record<string, unknown>): number | null {
  const date = String(v.date ?? ""), start = String(v.startTime ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start)) return null;
  const ms = wallToInstantMs(date, start.padStart(5, "0"), careZoneOf(v as never));
  return Number.isFinite(ms) ? ms : null;
}

/** Pure decision: remind now? From one minute after the start, for an hour, once. */
export function shouldRemindClockIn(startMs: number | null, nowMs: number, alreadySent: boolean): boolean {
  if (startMs === null || alreadySent) return false;
  return nowMs >= startMs + CLOCK_IN_GRACE_MS && nowMs <= startMs + CLOCK_IN_WINDOW_MS;
}

export function clockInText(v: FirebaseFirestore.DocumentData, shiftId: string): string {
  const who = visitSeniorName(v, "your client");
  return `${who}'s visit was set to start at ${formatHHMMForDisplay(String(v.startTime ?? ""))} and I haven't seen you clock in. Say start once you're there. Running behind? Say late and I'll pass it on to the family. Or open it here: ${visitPageLink(shiftId)}`;
}
/** The bell's copy: the page's wording, no text keywords (C18). */
export function clockInBell(v: FirebaseFirestore.DocumentData): string {
  const who = visitSeniorName(v, "your client");
  return `${who}'s visit was set to start at ${formatHHMMForDisplay(String(v.startTime ?? ""))} and hasn't been started. Start it from your Bookings page.`;
}

export async function runMissedClockInReminders(nowMs = Date.now()): Promise<{ sent: number; skipped: number }> {
  const out = { sent: 0, skipped: 0 };
  const today = businessTodayStr(undefined, new Date(nowMs));
  const yesterday = businessTodayStr(undefined, new Date(nowMs - DAY_MS));
  const docs = await queryVisits({ dateOp: ">=", dateValue: yesterday, dateUpperBound: today, shiftStatuses: ["scheduled"] });
  for (const doc of docs) {
    const v = doc.data();
    if (!shouldRemindClockIn(scheduledStartMs(v), nowMs, !!v.caraClockInReminderSentAt)) { out.skipped++; continue; }
    const caregiverId = String(v.caregiverId ?? "");
    if (!caregiverId) { out.skipped++; continue; }
    try {
      // Stamp first: two overlapping runs must never both text, and a failed send is not retried every minute for an hour.
      await doc.ref.update({ caraClockInReminderSentAt: new Date(nowMs).toISOString() });
      const phone = await resolveCaregiverPhone(caregiverId);
      const sess = phone ? await db.collection("agent_sessions").doc(phone).get().catch(() => null) : null;
      let sent = false;
      if (phone && sess?.exists && !sess.data()?.optedOut) {
        sent = await sendViaInteractionAgent(phone, { content: clockInText(v, doc.id), urgency: "standard", sourceAgent: "shift_clock_in_reminder", canDrop: false, fixedString: true });
      }
      if (sent) {
        await writeUserNotification({
          sourcePath: `shifts/${doc.id}`, eventId: "clock-in-reminder", recipientId: caregiverId,
          transitionType: "shift_clock_in_reminder", type: "shift_clock_in_reminder", title: "Visit not started yet",
          body: clockInBell(v), data: { shiftId: doc.id },
        }).catch((err) => console.error("[missedClockInReminder] bell failed:", doc.id, err));
        out.sent++;
      } else out.skipped++;
    } catch (err) { console.error("[missedClockInReminder]", doc.id, err); }
  }
  return out;
}

export const sendMissedClockInReminders = functions.pubsub
  .schedule("* * * * *")
  .onRun(async () => { await runMissedClockInReminders(); });
