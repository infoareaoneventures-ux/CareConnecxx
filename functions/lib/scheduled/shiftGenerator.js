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
exports.generateRollingShifts = exports.onBookingAccepted = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function normDay(day) {
    // Normalize 'MON' / 'monday' / 'Mon' → 'Mon' to match ALL_DAYS_ORDER
    const d = day.trim();
    return d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase();
}
function nextOccurrenceOnOrAfter(fromDate, dayName) {
    const target = ALL_DAYS_ORDER.indexOf(normDay(dayName));
    if (target === -1)
        return fromDate;
    const base = new Date(fromDate + 'T12:00:00');
    const diff = (target - base.getDay() + 7) % 7;
    base.setDate(base.getDate() + diff);
    return base.toISOString().split('T')[0];
}
function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}
// Shared: generate shifts for one booking starting from a given date up to generateTo.
async function generateShiftsForBooking(bookingId, booking, generateFrom, generateTo) {
    var _a, _b, _c, _d;
    const dayShiftTimes = ((_a = booking.schedule) === null || _a === void 0 ? void 0 : _a.dayShiftTimes) || {};
    if (Object.keys(dayShiftTimes).length === 0)
        return 0;
    const endDate = ((_b = booking.schedule) === null || _b === void 0 ? void 0 : _b.ongoing) ? null : (((_c = booking.schedule) === null || _c === void 0 ? void 0 : _c.endDate) || null);
    if (endDate && generateFrom > endDate)
        return 0;
    const caregiverId = booking.caregiverId || '';
    let caregiverPhotoURL = null;
    if (caregiverId) {
        const cgSnap = await db.collection('caregivers').doc(caregiverId).get().catch(() => null);
        const cgData = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data();
        caregiverPhotoURL = (cgData === null || cgData === void 0 ? void 0 : cgData.profilePhoto) || (cgData === null || cgData === void 0 ? void 0 : cgData.photoURL) || (cgData === null || cgData === void 0 ? void 0 : cgData.photo) || null;
    }
    const shiftBase = {
        clientId: booking.clientId || '',
        clientName: booking.clientName || '',
        clientPhotoURL: booking.clientPhotoURL || null,
        caregiverId,
        caregiverName: booking.caregiverName || '',
        caregiverPhotoURL,
        status: 'scheduled',
        address: booking.address || '',
        careNeeds: booking.careNeeds || [],
        lifestylePreferences: booking.lifestylePreferences || [],
        rate: (_d = booking.rate) !== null && _d !== void 0 ? _d : null,
        paymentMethod: booking.paymentMethod || null,
        notes: booking.notes || '',
        careRecipients: booking.careRecipients || [],
        emergencyContact: booking.emergencyContact || null,
        schedule: booking.schedule || null,
        bookingRequestId: bookingId,
        jobId: booking.jobId || null,
        recurringWeekly: true,
        tasksCompleted: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const newShifts = [];
    Object.entries(dayShiftTimes).forEach(([day, blocks]) => {
        blocks
            .filter(b => b.start && b.end)
            .forEach(b => {
            let dateStr = nextOccurrenceOnOrAfter(generateFrom, day);
            while (dateStr <= generateTo) {
                if (endDate && dateStr > endDate)
                    break;
                newShifts.push({ date: dateStr, start: b.start, end: b.end });
                dateStr = addDays(dateStr, 7);
            }
        });
    });
    if (newShifts.length === 0)
        return 0;
    for (let i = 0; i < newShifts.length; i += 499) {
        const chunk = newShifts.slice(i, i + 499);
        const batch = db.batch();
        chunk.forEach(({ date, start, end }) => {
            batch.set(db.collection('shifts').doc(), Object.assign(Object.assign({}, shiftBase), { date, startTime: start, endTime: end }));
        });
        await batch.commit();
    }
    return newShifts.length;
}
/**
 * Firestore trigger: when a booking_request is accepted, immediately generate
 * the first 2 weeks of shifts without waiting for the daily job.
 */
exports.onBookingAccepted = functions.firestore
    .document('booking_requests/{bookingId}')
    .onWrite(async (change, context) => {
    var _a, _b;
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    // Only fire when status is 'accepted'
    if (!after || after.status !== 'accepted')
        return;
    // If already accepted before, only re-generate if no scheduled shifts exist
    if ((before === null || before === void 0 ? void 0 : before.status) === 'accepted') {
        const bookingIdCheck = context.params.bookingId;
        const existingSnap = await db.collection('shifts')
            .where('bookingRequestId', '==', bookingIdCheck)
            .where('status', '==', 'scheduled')
            .limit(1)
            .get();
        if (!existingSnap.empty)
            return; // has shifts already, skip
        // no shifts found — fall through and regenerate
    }
    const bookingId = context.params.bookingId;
    const today = new Date().toISOString().split('T')[0];
    const startDate = ((_a = after.schedule) === null || _a === void 0 ? void 0 : _a.startDate) || today;
    // Allow up to 2 days in the past to handle UTC vs local timezone differences
    // (e.g. client sets startDate = "today" in PDT but server UTC is already "tomorrow")
    const twoDaysAgo = addDays(today, -2);
    const generateFrom = startDate >= twoDaysAgo ? startDate : today;
    const generateTo = addDays(generateFrom >= today ? generateFrom : today, 13); // 2 weeks
    try {
        const created = await generateShiftsForBooking(bookingId, after, generateFrom, generateTo);
        console.log(`onBookingAccepted: created ${created} shifts for booking ${bookingId}`);
        // Notify the client that the caregiver accepted
        if (after.clientId) {
            await db.collection('users').doc(after.clientId).collection('notifications').add({
                userId: after.clientId,
                type: 'booking_accepted',
                title: 'Booking Accepted',
                body: `${after.caregiverName || 'Your caregiver'} accepted your booking request.`,
                data: { bookingId, caregiverId: after.caregiverId },
                isRead: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
        // Auto-close job post if enough caregivers have now accepted
        if (after.jobId) {
            const [jobSnap, acceptedSnap] = await Promise.all([
                db.collection('job_posts').doc(after.jobId).get(),
                db.collection('booking_requests')
                    .where('jobId', '==', after.jobId)
                    .where('status', '==', 'accepted')
                    .get(),
            ]);
            const caregiversNeeded = ((_b = jobSnap.data()) === null || _b === void 0 ? void 0 : _b.caregiversNeeded) || 1;
            if (jobSnap.exists && acceptedSnap.size >= caregiversNeeded) {
                await db.collection('job_posts').doc(after.jobId).update({
                    status: 'filled',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }
    }
    catch (err) {
        console.error(`onBookingAccepted: error for booking ${bookingId}`, err);
    }
});
/**
 * Daily job: for every accepted booking, ensure there is at least 2 weeks of
 * scheduled shifts ahead. Generates more whenever the furthest scheduled shift
 * falls within 7 days of today.
 * On the first run after a CLEANUP_SHIFTS env flag is set, it will first wipe
 * all scheduled shifts and regenerate from scratch.
 */
exports.generateRollingShifts = functions.pubsub
    .schedule('every 24 hours')
    .onRun(async () => {
    var _a, _b;
    const today = new Date().toISOString().split('T')[0];
    const threshold = addDays(today, 14);
    const bookingsSnap = await db.collection('booking_requests')
        .where('status', '==', 'accepted')
        .get();
    if (bookingsSnap.empty) {
        console.log('generateRollingShifts: no accepted bookings');
        return;
    }
    // ── ONE-TIME CLEANUP: wipe all scheduled shifts and regenerate ──
    // Check a flag doc; if it exists we already cleaned up.
    const flagRef = db.collection('_meta').doc('shiftsCleanedUp');
    const flagSnap = await flagRef.get();
    if (!flagSnap.exists) {
        console.log('generateRollingShifts: running one-time cleanup...');
        const scheduledSnap = await db.collection('shifts').where('status', '==', 'scheduled').get();
        let deleted = 0;
        for (let i = 0; i < scheduledSnap.docs.length; i += 499) {
            const batch = db.batch();
            scheduledSnap.docs.slice(i, i + 499).forEach(d => batch.delete(d.ref));
            await batch.commit();
            deleted += Math.min(499, scheduledSnap.docs.length - i);
        }
        console.log(`generateRollingShifts: deleted ${deleted} bad shifts`);
        // Regenerate 4 weeks for all accepted bookings immediately
        const generateTo = addDays(today, 27);
        let totalCreated = 0;
        for (const bookingDoc of bookingsSnap.docs) {
            try {
                const n = await generateShiftsForBooking(bookingDoc.id, bookingDoc.data(), today, generateTo);
                totalCreated += n;
            }
            catch (err) {
                console.error('cleanup regen error', bookingDoc.id, err);
            }
        }
        await flagRef.set({ cleanedAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`generateRollingShifts: cleanup done — created ${totalCreated} shifts`);
        return;
    }
    // ── END ONE-TIME CLEANUP ──
    let totalCreated = 0;
    for (const bookingDoc of bookingsSnap.docs) {
        try {
            const booking = bookingDoc.data();
            const bookingId = bookingDoc.id;
            const endDate = ((_a = booking.schedule) === null || _a === void 0 ? void 0 : _a.ongoing) ? null : (((_b = booking.schedule) === null || _b === void 0 ? void 0 : _b.endDate) || null);
            if (endDate && today > endDate)
                continue;
            const latestShiftSnap = await db.collection('shifts')
                .where('bookingRequestId', '==', bookingId)
                .where('status', '==', 'scheduled')
                .orderBy('date', 'desc')
                .limit(1)
                .get();
            const maxShiftDate = latestShiftSnap.empty
                ? addDays(today, -1)
                : latestShiftSnap.docs[0].data().date;
            if (maxShiftDate >= threshold)
                continue;
            const generateFrom = addDays(maxShiftDate, 1);
            const generateTo = addDays(maxShiftDate, 14);
            const created = await generateShiftsForBooking(bookingId, booking, generateFrom, generateTo);
            totalCreated += created;
        }
        catch (err) {
            console.error(`generateRollingShifts: error processing booking ${bookingDoc.id}`, err);
        }
    }
    console.log(`generateRollingShifts: created ${totalCreated} shifts`);
});
//# sourceMappingURL=shiftGenerator.js.map