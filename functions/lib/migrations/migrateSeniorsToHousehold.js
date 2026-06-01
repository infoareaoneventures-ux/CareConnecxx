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
exports.migrateSeniorsToHousehold = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * One-time migration: converts old-style senior_profiles (where doc ID === client UID)
 * to the new multi-senior model (auto-generated ID + clientId back-reference).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 *
 * Safe to re-run — already-migrated docs are skipped.
 */
exports.migrateSeniorsToHousehold = functions.https.onRequest(async (req, res) => {
    var _a;
    // Protect: require admin secret header
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    const results = { migrated: 0, skipped: 0, errors: [] };
    const seniorSnap = await db.collection("senior_profiles").get();
    for (const seniorDoc of seniorSnap.docs) {
        const seniorId = seniorDoc.id;
        const data = seniorDoc.data();
        // Already migrated: has a clientId field that differs from its own doc ID
        if (data.clientId && data.clientId !== seniorId) {
            results.skipped++;
            continue;
        }
        // Only migrate docs whose ID matches a real client user
        const userDoc = await db.collection("users").doc(seniorId).get();
        if (!userDoc.exists || ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.userType) !== "client") {
            results.skipped++;
            continue;
        }
        try {
            // Create new senior_profiles doc with auto-generated ID
            const newSeniorRef = db.collection("senior_profiles").doc();
            const newSeniorId = newSeniorRef.id;
            await db.runTransaction(async (tx) => {
                // Create new senior doc with clientId back-reference
                tx.set(newSeniorRef, Object.assign(Object.assign({}, data), { clientId: seniorId, migratedFrom: seniorId }));
                // Update user doc with seniorIds array
                tx.update(db.collection("users").doc(seniorId), {
                    seniorIds: admin.firestore.FieldValue.arrayUnion(newSeniorId),
                });
                // Mark old doc as migrated (kept as backup — do not delete)
                tx.update(seniorDoc.ref, { migratedTo: newSeniorId });
            });
            results.migrated++;
        }
        catch (err) {
            results.errors.push(`${seniorId}: ${String(err)}`);
        }
    }
    res.json(results);
});
//# sourceMappingURL=migrateSeniorsToHousehold.js.map