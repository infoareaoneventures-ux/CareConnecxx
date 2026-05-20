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
exports.getCaregiverTaxSummary = getCaregiverTaxSummary;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
async function getCaregiverTaxSummary(caregiverId, year) {
    var _a, _b, _c, _d, _e;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    // Query approved/auto_approved/paid shift hours for the caregiver
    // Collection name is "shiftHours" per shiftHours.ts (see shiftRef.set / db.collection('shiftHours'))
    const shiftSnap = await db.collection("shiftHours")
        .where("caregiverId", "==", caregiverId)
        .where("status", "in", ["approved", "auto_approved", "paid"])
        .get();
    let totalEarnings = 0;
    let totalHours = 0;
    let visitCount = 0;
    const quarterly = { q1: 0, q2: 0, q3: 0, q4: 0 };
    for (const doc of shiftSnap.docs) {
        const data = doc.data();
        // submittedAt is the ISO timestamp stored during submitShiftHours
        const date = (_b = (_a = data.submittedAt) === null || _a === void 0 ? void 0 : _a.split("T")[0]) !== null && _b !== void 0 ? _b : "";
        if (!date || date < startDate || date > endDate)
            continue;
        // grossPay is set upon approval: Math.round(submittedTotalHours * payRate * 100) / 100
        // submittedTotalHours is the hours field (or finalTotalHours after correction)
        const hours = (_d = (_c = data.finalTotalHours) !== null && _c !== void 0 ? _c : data.submittedTotalHours) !== null && _d !== void 0 ? _d : 0;
        const earnings = (_e = data.grossPay) !== null && _e !== void 0 ? _e : 0;
        totalHours += hours;
        totalEarnings += earnings;
        visitCount++;
        const month = parseInt(date.split("-")[1], 10);
        if (month <= 3)
            quarterly.q1 += earnings;
        else if (month <= 6)
            quarterly.q2 += earnings;
        else if (month <= 9)
            quarterly.q3 += earnings;
        else
            quarterly.q4 += earnings;
    }
    // Count completed payouts for the year
    const payoutSnap = await db.collection("payouts")
        .where("caregiverId", "==", caregiverId)
        .where("status", "==", "completed")
        .get();
    const payoutCount = payoutSnap.docs.filter(d => {
        var _a;
        const ts = (_a = d.data().createdAt) !== null && _a !== void 0 ? _a : "";
        return ts >= startDate && ts <= endDate;
    }).length;
    const summary = {
        caregiverId,
        year,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalHours: Math.round(totalHours * 10) / 10,
        visitCount,
        eligibleFor1099: totalEarnings >= 600,
        payoutCount,
        quarterlyBreakdown: {
            q1: Math.round(quarterly.q1 * 100) / 100,
            q2: Math.round(quarterly.q2 * 100) / 100,
            q3: Math.round(quarterly.q3 * 100) / 100,
            q4: Math.round(quarterly.q4 * 100) / 100,
        },
        generatedAt: new Date().toISOString(),
    };
    // Cache in Firestore for fast re-retrieval
    await db.collection("tax_summaries").doc(`${caregiverId}_${year}`).set(summary);
    return summary;
}
//# sourceMappingURL=taxDocuments.js.map