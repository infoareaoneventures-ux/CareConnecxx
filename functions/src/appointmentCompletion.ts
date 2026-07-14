import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { parseScheduledTimeMs, businessTodayStr } from "./utils/scheduledTime";
import { normalizeAppointmentTime } from "./utils/appointmentDoc";

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

const GRACE_MINUTES = 30;

// Compute when the appointment was scheduled to end, in UTC ms. Returns null
// if any of the inputs are unparseable.
export function computeScheduledEndMs(scheduleDate: unknown, time: unknown, duration: unknown): number | null {
    if (typeof scheduleDate !== "string") return null;
    const time24 = normalizeAppointmentTime(time);
    if (!time24) return null;
    const hours = typeof duration === "number" && isFinite(duration) ? duration : 1;
    // The stored isoDate+time is Pacific wall-clock. Parsing it as UTC ("...Z")
    // lands 7-8h EARLY — the cron would mark an evening shift completed before
    // it starts, unblocking submitShiftHours pre-shift. GRACE_MINUTES (30) is
    // an intentional post-end buffer, not a timezone allowance.
    const startMs = parseScheduledTimeMs(`${scheduleDate}T${time24}:00`);
    if (!isFinite(startMs)) return null;
    return startMs + hours * 60 * 60 * 1000;
}

/**
 * Mark appointments `completed` when their scheduled end + grace has passed.
 * Unblocks shiftHours.submitShiftHours which gates on `appt.status === 'completed'`.
 */
export const markAppointmentsCompleted = functions.pubsub
    .schedule("every 15 minutes")
    .onRun(async () => {
        const now = Date.now();
        // Pacific business date, not UTC — during PT evening hours the UTC date
        // is already tomorrow, which would pull tomorrow's shifts into the scan.
        const todayIso = businessTodayStr();

        const snap = await db.collection("appointments")
            .where("status", "in", ["confirmed", "awaiting_feedback"])
            .where("date", "<=", todayIso)
            .limit(500)
            .get();

        let updated = 0;
        for (const doc of snap.docs) {
            const a = doc.data();
            const endMs = computeScheduledEndMs(a.date ?? a.isoDate, a.time ?? a.startTime, a.duration ?? a.durationHours);
            if (endMs == null) {
                console.error(`[markAppointmentsCompleted] unconvertible appointment ${doc.id}`);
                continue;
            }
            if (now < endMs + GRACE_MINUTES * 60 * 1000) continue;

            await doc.ref.update({
                status: "completed",
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            updated++;
        }

        return null;
    });
