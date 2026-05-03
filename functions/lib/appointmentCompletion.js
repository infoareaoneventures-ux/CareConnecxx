"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.markAppointmentsCompleted = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
const GRACE_MINUTES = 30;
// Parse the appointment's stored `time` field into 24h "HH:MM". Accepts
// "9:00 AM", "9:00", "09:00", "21:30", etc. Returns null on parse failure.
function parseTime24(raw) {
    if (typeof raw !== "string")
        return null;
    const trimmed = raw.trim().toUpperCase();
    const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
    if (!match)
        return null;
    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const meridiem = match[3];
    if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59)
        return null;
    if (meridiem === "PM" && hour < 12)
        hour += 12;
    if (meridiem === "AM" && hour === 12)
        hour = 0;
    if (hour > 23)
        return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
// Compute when the appointment was scheduled to end, in UTC ms. Returns null
// if any of the inputs are unparseable.
function computeScheduledEndMs(isoDate, time, duration) {
    if (typeof isoDate !== "string")
        return null;
    const time24 = parseTime24(time);
    if (!time24)
        return null;
    const hours = typeof duration === "number" && isFinite(duration) ? duration : 1;
    // Treat the stored isoDate+time as local-time; without a tz hint we
    // approximate with UTC. Caregivers running cron at 15-min cadence absorb
    // up to a few hours of skew via the GRACE_MINUTES buffer.
    const start = new Date(`${isoDate}T${time24}:00Z`);
    const startMs = start.getTime();
    if (!isFinite(startMs))
        return null;
    return startMs + hours * 60 * 60 * 1000;
}
/**
 * Mark appointments `completed` when their scheduled end + grace has passed.
 * Unblocks shiftHours.submitShiftHours which gates on `appt.status === 'completed'`.
 */
exports.markAppointmentsCompleted = functions.pubsub
    .schedule("every 15 minutes")
    .onRun(async () => {
    const now = Date.now();
    const todayIso = new Date(now).toISOString().split("T")[0];
    const snap = await db.collection("appointments")
        .where("status", "in", ["confirmed", "awaiting_feedback"])
        .where("isoDate", "<=", todayIso)
        .limit(500)
        .get();
    let updated = 0;
    for (const doc of snap.docs) {
        const a = doc.data();
        const endMs = computeScheduledEndMs(a.isoDate, a.time, a.duration);
        if (endMs == null)
            continue;
        if (now < endMs + GRACE_MINUTES * 60 * 1000)
            continue;
        await doc.ref.update({
            status: "completed",
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        updated++;
    }
    return null;
});
//# sourceMappingURL=appointmentCompletion.js.map