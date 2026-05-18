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
exports.generateRollingShifts = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
const ALL_DAYS_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function nextOccurrenceOnOrAfter(fromDate, dayName) {
    const target = ALL_DAYS_ORDER.indexOf(dayName);
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
/**
 * Daily job: for every accepted booking, ensure there is at least 1 week of
 * scheduled shifts ahead. Generates exactly 1 more week whenever the furthest
 * scheduled shift falls within 7 days of today. Stops at endDate for
 * fixed-term bookings; runs indefinitely for ongoing ones.
 */
exports.generateRollingShifts = functions.pubsub
    .schedule('every 24 hours')
    .onRun(async () => {
    var _a, _b, _c, _d;
    const today = new Date().toISOString().split('T')[0];
    const threshold = addDays(today, 14); // trigger when less than 2 weeks ahead
    const bookingsSnap = await db.collection('booking_requests')
        .where('status', '==', 'accepted')
        .get();
    if (bookingsSnap.empty) {
        console.log('generateRollingShifts: no accepted bookings');
        return;
    }
    let totalCreated = 0;
    for (const bookingDoc of bookingsSnap.docs) {
        try {
            const booking = bookingDoc.data();
            const bookingId = bookingDoc.id;
            const dayShiftTimes = ((_a = booking.schedule) === null || _a === void 0 ? void 0 : _a.dayShiftTimes) || {};
            if (Object.keys(dayShiftTimes).length === 0)
                continue;
            const endDate = ((_b = booking.schedule) === null || _b === void 0 ? void 0 : _b.ongoing) ? null : (((_c = booking.schedule) === null || _c === void 0 ? void 0 : _c.endDate) || null);
            // Skip if booking period has already ended
            if (endDate && today > endDate)
                continue;
            // Find the furthest future scheduled shift for this booking
            const latestShiftSnap = await db.collection('shifts')
                .where('bookingRequestId', '==', bookingId)
                .where('status', '==', 'scheduled')
                .orderBy('date', 'desc')
                .limit(1)
                .get();
            const maxShiftDate = latestShiftSnap.empty
                ? addDays(today, -1) // no future shifts → start from today
                : latestShiftSnap.docs[0].data().date;
            // Only act if we're within the 7-day threshold
            if (maxShiftDate >= threshold)
                continue;
            const generateFrom = addDays(maxShiftDate, 1);
            const generateTo = addDays(maxShiftDate, 14);
            // Fetch caregiver photo
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
                continue;
            // Firestore batch limit is 500 writes
            for (let i = 0; i < newShifts.length; i += 499) {
                const chunk = newShifts.slice(i, i + 499);
                const batch = db.batch();
                chunk.forEach(({ date, start, end }) => {
                    batch.set(db.collection('shifts').doc(), Object.assign(Object.assign({}, shiftBase), { date, startTime: start, endTime: end }));
                });
                await batch.commit();
            }
            totalCreated += newShifts.length;
        }
        catch (err) {
            console.error(`generateRollingShifts: error processing booking ${bookingDoc.id}`, err);
        }
    }
    console.log(`generateRollingShifts: created ${totalCreated} shifts across ${bookingsSnap.size} accepted bookings`);
});
//# sourceMappingURL=shiftGenerator.js.map