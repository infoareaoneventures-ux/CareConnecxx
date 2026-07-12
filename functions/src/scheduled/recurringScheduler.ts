import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { isUSFederalHoliday } from "../utils/holidays";
import { canonicalApptFields } from "../utils/appointmentDoc";

const db = admin.firestore();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecurringSchedule {
  id?:               string;
  clientId:          string;
  caregiverId:       string;
  caregiverName:     string;
  clientPhone:       string;
  seniorName:        string;
  seniorId?:         string;         // Multi-senior: explicit reference to senior_profiles doc
  days:              string[];       // ["Mon", "Wed", "Fri"]
  startTime:         string;         // "09:00"
  endTime:           string;         // "13:00"
  durationHours:     number;
  hourlyRate:        number;
  status:            "active" | "paused" | "cancelled";
  startDate:         string;         // ISO date — when care began
  pausedAt?:         string;
  pausedReason?:     string;
  weeksBookedAhead:  number;
  lastExtendedAt:    string;
  createdAt:         string;
  holidayBehavior?:  "skip" | "reschedule_next_day" | "keep";
  excludeDates?:     string[];       // YYYY-MM-DD dates to always skip
}

// ── Date generation (mirrors matching.ts generateRecurringDates) ──────────────

export function generateRecurringDates(
  fromDate: string,
  days:     string[],
  weeks:    number
): Array<{ date: string }> {
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const results: Array<{ date: string }> = [];
  const from = new Date(fromDate);

  for (let week = 1; week <= weeks; week++) {
    for (const day of days) {
      const target = dayMap[day];
      if (target === undefined) continue;
      const base    = new Date(from);
      const current = base.getDay();
      let diff      = target - current + week * 7;
      if (diff <= 0) diff += 7;
      base.setDate(base.getDate() + diff);
      results.push({ date: base.toISOString().split("T")[0] });
    }
  }
  // Sort ascending and deduplicate
  return [...new Map(results.map((r) => [r.date, r])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Holiday + exclude-date filters ───────────────────────────────────────────

function applyHolidayFilter(
  dates: Array<{ date: string }>,
  behavior: RecurringSchedule["holidayBehavior"]
): Array<{ date: string }> {
  if (!behavior || behavior === "keep") return dates;
  const result: Array<{ date: string }> = [];
  for (const entry of dates) {
    if (!isUSFederalHoliday(entry.date)) {
      result.push(entry);
      continue;
    }
    if (behavior === "skip") continue;
    if (behavior === "reschedule_next_day") {
      const next = new Date(entry.date);
      next.setDate(next.getDate() + 1);
      result.push({ date: next.toISOString().split("T")[0] });
    }
  }
  return result;
}

function applyExcludeDates(
  dates: Array<{ date: string }>,
  excludeDates?: string[]
): Array<{ date: string }> {
  if (!excludeDates?.length) return dates;
  const excluded = new Set(excludeDates);
  return dates.filter(d => !excluded.has(d.date));
}

// ── Core extension logic ──────────────────────────────────────────────────────

export async function extendRecurringScheduleById(scheduleId: string): Promise<void> {
  const snap = await db.collection("recurring_schedules").doc(scheduleId).get();
  if (!snap.exists) return;
  await extendSchedule(scheduleId, snap.data() as RecurringSchedule);
}

async function extendSchedule(
  scheduleId: string,
  schedule:   RecurringSchedule
): Promise<void> {
  // Find the latest booked appointment for this recurring schedule
  const latestSnap = await db.collection("appointments")
    .where("recurringScheduleId", "==", scheduleId)
    .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
    .orderBy("date", "desc")
    .limit(1)
    .get();

  if (latestSnap.empty) return;

  const latestDate      = new Date(latestSnap.docs[0].data().date as string);
  const today           = new Date();
  const weeksRemaining  = (latestDate.getTime() - today.getTime()) / (7 * 24 * 60 * 60 * 1000);

  // Only extend if less than 2 weeks of appointments remain
  if (weeksRemaining > 2) return;

  let newDates = generateRecurringDates(latestDate.toISOString().split("T")[0], schedule.days, 4);
  newDates = applyHolidayFilter(newDates, schedule.holidayBehavior);
  newDates = applyExcludeDates(newDates, schedule.excludeDates);
  if (newDates.length === 0) return;

  const batch = db.batch();
  for (const { date } of newDates) {
    const ref = db.collection("appointments").doc();
    batch.set(ref, {
      clientId:            schedule.clientId,
      caregiverId:         schedule.caregiverId,
      caregiverName:       schedule.caregiverName,
      date,
      startTime:           schedule.startTime,
      endTime:             schedule.endTime,
      durationHours:       schedule.durationHours,
      hourlyRate:          schedule.hourlyRate,
      seniorName:          schedule.seniorName || null,
      ...canonicalApptFields({ startTime: schedule.startTime, durationHours: schedule.durationHours, hourlyRate: schedule.hourlyRate }),
      status:              "confirmed",
      recurringScheduleId: scheduleId,
      humanApproved:       true,
      createdAt:           new Date().toISOString(),
    });
  }
  await batch.commit();

  await db.collection("recurring_schedules").doc(scheduleId).update({
    lastExtendedAt:  new Date().toISOString(),
    weeksBookedAhead: 4,
  });

  console.log(`[extendSchedule] Extended ${scheduleId} with ${newDates.length} appointments`);
}

// ── Scheduled job — every Sunday at 8pm ET ────────────────────────────────────

export const extendRecurringSchedules = functions.pubsub
  .schedule("0 0 * * 1")   // Monday 00:00 UTC = Sunday 8pm ET
  .timeZone("UTC")
  .onRun(async () => {
    const snap = await db.collection("recurring_schedules")
      .where("status", "==", "active")
      .get();

    console.log(`[extendRecurringSchedules] Processing ${snap.size} active schedules`);

    for (const doc of snap.docs) {
      try {
        await extendSchedule(doc.id, doc.data() as RecurringSchedule);
      } catch (err) {
        console.error(`[extendRecurringSchedules] Failed for ${doc.id}:`, err);

        const schedule = doc.data() as RecurringSchedule;
        const phone: string | undefined = (schedule as any).clientPhone;

        // Log admin alert so the team can investigate
        await db.collection("admin_alerts").add({
          type:       "recurring_schedule_extend_failed",
          scheduleId: doc.id,
          clientId:   schedule.clientId,
          error:      String(err),
          createdAt:  new Date().toISOString(),
          resolved:   false,
        }).catch(() => {});

        // Notify family so they know care continuity might be affected
        if (phone) {
          const { sendViaInteractionAgent } = await import("../agents/caraAgent");
          await sendViaInteractionAgent(phone, {
            content:
              "I ran into an issue scheduling your upcoming care visits — I'll retry shortly. " +
              "If this persists, reply here and I'll sort it out for you.",
            urgency:     "standard",
            sourceAgent: "recurring_scheduler",
            canDrop:     false,
          }).catch(() => {});

          // Schedule a 1h retry
          const { scheduleTrigger } = await import("../triggers/triggerEngine");
          await scheduleTrigger({
            userId:      schedule.clientId,
            phone,
            type:        "custom",
            scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            message:     `retry_extend_schedule:${doc.id}`,
          }).catch(() => {});
        }
      }
    }
  });
