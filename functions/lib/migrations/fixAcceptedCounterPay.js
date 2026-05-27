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
exports.fixAcceptedCounterPay = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * One-time migration: fixes shiftHours docs where a client accepted a caregiver
 * counter-proposal but grossPay was stored as base pay only (missing line items).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 *
 * Safe to re-run — docs that already have the correct grossPay are skipped.
 */
exports.fixAcceptedCounterPay = functions.https.onRequest(async (req, res) => {
    var _a, _b;
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    const results = { fixed: 0, skipped: 0, errors: [] };
    // Only docs accepted by the client after a counter
    const snap = await db.collection("shiftHours")
        .where("status", "==", "approved")
        .where("resolvedBy", "==", "client")
        .get();
    for (const doc of snap.docs) {
        const s = doc.data();
        // Only applies when a counter was on file
        if (!s.counterTotalHours) {
            results.skipped++;
            continue;
        }
        const counterBasePay = Math.round(s.counterTotalHours * s.payRate * 100) / 100;
        const safeLineItems = Array.isArray(s.counterLineItems) ? s.counterLineItems : [];
        const lineItemsTotal = Math.round(safeLineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0) * 100) / 100;
        const correctGross = (_a = s.counterGrossPay) !== null && _a !== void 0 ? _a : Math.round((counterBasePay + lineItemsTotal) * 100) / 100;
        // Skip if grossPay is already correct (within 1 cent rounding)
        if (Math.abs(((_b = s.grossPay) !== null && _b !== void 0 ? _b : 0) - correctGross) < 0.02 && safeLineItems.length === 0) {
            results.skipped++;
            continue;
        }
        // Fix the history array: update the 'accepted' entry to include financials
        const history = Array.isArray(s.correctionHistory) ? [...s.correctionHistory] : [];
        const fixedHistory = history.map((entry) => {
            if (entry.action !== "accepted")
                return entry;
            return Object.assign(Object.assign({}, entry), { lineItems: safeLineItems, lineItemsTotal, basePay: counterBasePay, grossPay: correctGross });
        });
        try {
            await doc.ref.update({
                lineItems: safeLineItems,
                lineItemsTotal,
                basePay: counterBasePay,
                grossPay: correctGross,
                correctionHistory: fixedHistory,
                updatedAt: new Date().toISOString(),
            });
            results.fixed++;
        }
        catch (e) {
            results.errors.push(`${doc.id}: ${e.message}`);
        }
    }
    res.json(results);
});
//# sourceMappingURL=fixAcceptedCounterPay.js.map