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
exports.onShiftStatusChanged = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * When a shift transitions to 'completed' or 'cancelled', check whether
 * any scheduled shifts remain for that booking. If none do, mark the
 * booking_requests doc as 'completed' so client and caregiver UIs
 * correctly move the booking to Past without needing per-component
 * shift cross-references.
 */
exports.onShiftStatusChanged = functions.firestore
    .document('shifts/{shiftId}')
    .onUpdate(async (change) => {
    try {
        const before = change.before.data();
        const after = change.after.data();
        // Only care about transitions into a terminal state
        const terminal = ['completed', 'cancelled'];
        if (!terminal.includes(after.status))
            return;
        if (before.status === after.status)
            return;
        const bookingRequestId = after.bookingRequestId;
        if (!bookingRequestId)
            return;
        // Check if any scheduled shifts remain for this booking
        const remainingSnap = await db
            .collection('shifts')
            .where('bookingRequestId', '==', bookingRequestId)
            .where('status', '==', 'scheduled')
            .limit(1)
            .get();
        if (!remainingSnap.empty) {
            // Still active shifts — nothing to do
            return;
        }
        // No scheduled shifts left — mark booking as completed
        const bookingRef = db.collection('booking_requests').doc(bookingRequestId);
        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists)
            return;
        const booking = bookingSnap.data();
        // Only update if currently accepted (don't overwrite cancelled)
        if (booking.status !== 'accepted')
            return;
        await bookingRef.update({
            status: 'completed',
            completedAt: new Date().toISOString(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[onShiftStatusChanged] booking ${bookingRequestId} marked completed — no scheduled shifts remain`);
    }
    catch (err) {
        console.error('[onShiftStatusChanged] error:', err);
    }
});
//# sourceMappingURL=shiftStatusTrigger.js.map