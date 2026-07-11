import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { parseScheduledTimeMs, businessTodayStr } from "./utils/scheduledTime";

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

const GRACE_MINUTES = 30;

// Parse the appointment's stored `time` field into 24h "HH:MM". Accepts
// "9:00 AM", "9:00", "09:00", "21:30", etc. Returns null on parse failure.
function parseTime24(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().toUpperCase();
    const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
    if (!match) return null;
    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const meridiem = match[3];
    if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (hour > 23) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Compute when the appointment was scheduled to end, in UTC ms. Returns null
// if any of the inputs are unparseable.
export function computeScheduledEndMs(isoDate: unknown, time: unknown, duration: unknown): number | null {
    if (typeof isoDate !== "string") return null;
    const time24 = parseTime24(time);
    if (!time24) return null;
    const hours = typeof duration === "number" && isFinite(duration) ? duration : 1;
    // The stored isoDate+time is Pacific wall-clock. Parsing it as UTC ("...Z")
    // lands 7-8h EARLY — the cron would mark an evening shift completed before
    // it starts, unblocking submitShiftHours pre-shift. GRACE_MINUTES (30) is
    // an intentional post-end buffer, not a timezone allowance.
    const startMs = parseScheduledTimeMs(`${isoDate}T${time24}:00`);
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
            .where("isoDate", "<=", todayIso)
            .limit(500)
            .get();

        let updated = 0;
        for (const doc of snap.docs) {
            const a = doc.data();
            const endMs = computeScheduledEndMs(a.isoDate, a.time, a.duration);
            if (endMs == null) continue;
            if (now < endMs + GRACE_MINUTES * 60 * 1000) continue;

            await doc.ref.update({
                status: "completed",
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            updated++;
        }

        return null;
    });
