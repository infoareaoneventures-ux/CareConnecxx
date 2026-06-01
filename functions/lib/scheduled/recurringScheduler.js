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
exports.extendRecurringSchedules = void 0;
exports.generateRecurringDates = generateRecurringDates;
exports.extendRecurringScheduleById = extendRecurringScheduleById;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const holidays_1 = require("../utils/holidays");
const db = admin.firestore();
// ── Date generation (mirrors matching.ts generateRecurringDates) ──────────────
function generateRecurringDates(fromDate, days, weeks) {
    const dayMap = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const results = [];
    const from = new Date(fromDate);
    for (let week = 1; week <= weeks; week++) {
        for (const day of days) {
            const target = dayMap[day];
            if (target === undefined)
                continue;
            const base = new Date(from);
            const current = base.getDay();
            let diff = target - current + week * 7;
            if (diff <= 0)
                diff += 7;
            base.setDate(base.getDate() + diff);
            results.push({ date: base.toISOString().split("T")[0] });
        }
    }
    // Sort ascending and deduplicate
    return [...new Map(results.map((r) => [r.date, r])).values()]
        .sort((a, b) => a.date.localeCompare(b.date));
}
// ── Holiday + exclude-date filters ───────────────────────────────────────────
function applyHolidayFilter(dates, behavior) {
    if (!behavior || behavior === "keep")
        return dates;
    const result = [];
    for (const entry of dates) {
        if (!(0, holidays_1.isUSFederalHoliday)(entry.date)) {
            result.push(entry);
            continue;
        }
        if (behavior === "skip")
            continue;
        if (behavior === "reschedule_next_day") {
            const next = new Date(entry.date);
            next.setDate(next.getDate() + 1);
            result.push({ date: next.toISOString().split("T")[0] });
        }
    }
    return result;
}
function applyExcludeDates(dates, excludeDates) {
    if (!(excludeDates === null || excludeDates === void 0 ? void 0 : excludeDates.length))
        return dates;
    const excluded = new Set(excludeDates);
    return dates.filter(d => !excluded.has(d.date));
}
// ── Core extension logic ──────────────────────────────────────────────────────
async function extendRecurringScheduleById(scheduleId) {
    const snap = await db.collection("recurring_schedules").doc(scheduleId).get();
    if (!snap.exists)
        return;
    await extendSchedule(scheduleId, snap.data());
}
async function extendSchedule(scheduleId, schedule) {
    // Find the latest booked appointment for this recurring schedule
    const latestSnap = await db.collection("appointments")
        .where("recurringScheduleId", "==", scheduleId)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .orderBy("date", "desc")
        .limit(1)
        .get();
    if (latestSnap.empty)
        return;
    const latestDate = new Date(latestSnap.docs[0].data().date);
    const today = new Date();
    const weeksRemaining = (latestDate.getTime() - today.getTime()) / (7 * 24 * 60 * 60 * 1000);
    // Only extend if less than 2 weeks of appointments remain
    if (weeksRemaining > 2)
        return;
    let newDates = generateRecurringDates(latestDate.toISOString().split("T")[0], schedule.days, 4);
    newDates = applyHolidayFilter(newDates, schedule.holidayBehavior);
    newDates = applyExcludeDates(newDates, schedule.excludeDates);
    if (newDates.length === 0)
        return;
    const batch = db.batch();
    for (const { date } of newDates) {
        const ref = db.collection("appointments").doc();
        batch.set(ref, {
            clientId: schedule.clientId,
            caregiverId: schedule.caregiverId,
            caregiverName: schedule.caregiverName,
            date,
            startTime: schedule.startTime,
            endTime: schedule.endTime,
            durationHours: schedule.durationHours,
            hourlyRate: schedule.hourlyRate,
            status: "confirmed",
            recurringScheduleId: scheduleId,
            humanApproved: true,
            createdAt: new Date().toISOString(),
        });
    }
    await batch.commit();
    await db.collection("recurring_schedules").doc(scheduleId).update({
        lastExtendedAt: new Date().toISOString(),
        weeksBookedAhead: 4,
    });
    console.log(`[extendSchedule] Extended ${scheduleId} with ${newDates.length} appointments`);
}
// ── Scheduled job — every Sunday at 8pm ET ────────────────────────────────────
exports.extendRecurringSchedules = functions.pubsub
    .schedule("0 0 * * 1") // Monday 00:00 UTC = Sunday 8pm ET
    .timeZone("UTC")
    .onRun(async () => {
    const snap = await db.collection("recurring_schedules")
        .where("status", "==", "active")
        .get();
    console.log(`[extendRecurringSchedules] Processing ${snap.size} active schedules`);
    for (const doc of snap.docs) {
        try {
            await extendSchedule(doc.id, doc.data());
        }
        catch (err) {
            console.error(`[extendRecurringSchedules] Failed for ${doc.id}:`, err);
            const schedule = doc.data();
            const phone = schedule.clientPhone;
            // Log admin alert so the team can investigate
            await db.collection("admin_alerts").add({
                type: "recurring_schedule_extend_failed",
                scheduleId: doc.id,
                clientId: schedule.clientId,
                error: String(err),
                createdAt: new Date().toISOString(),
                resolved: false,
            }).catch(() => { });
            // Notify family so they know care continuity might be affected
            if (phone) {
                const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("../agents/caraAgent")));
                await sendViaInteractionAgent(phone, {
                    content: "I ran into an issue scheduling your upcoming care visits — I'll retry shortly. " +
                        "If this persists, reply here and I'll sort it out for you.",
                    urgency: "standard",
                    sourceAgent: "recurring_scheduler",
                    canDrop: false,
                }).catch(() => { });
                // Schedule a 1h retry
                const { scheduleTrigger } = await Promise.resolve().then(() => __importStar(require("../triggers/triggerEngine")));
                await scheduleTrigger({
                    userId: schedule.clientId,
                    phone,
                    type: "custom",
                    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    message: `retry_extend_schedule:${doc.id}`,
                }).catch(() => { });
            }
        }
    }
});
//# sourceMappingURL=recurringScheduler.js.map