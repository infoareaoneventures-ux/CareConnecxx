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
exports.getPayrollSetupDetails = exports.approvePayrollSetup = exports.markPayrollSubmitted = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * Mark payroll setups as submitted to HWS
 * Callable by admin only
 */
exports.markPayrollSubmitted = functions.https.onCall(async (data, context) => {
    var _a;
    // Verify admin
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.userType) !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    const { ids } = data;
    if (!Array.isArray(ids) || ids.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'IDs array required');
    }
    const batch = db.batch();
    for (const id of ids) {
        const ref = db.collection('payrollSetups').doc(id);
        batch.update(ref, {
            status: 'submitted_to_hws',
            submittedToHwsAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    await batch.commit();
    return { success: true, count: ids.length };
});
/**
 * Approve a payroll setup
 * Callable by admin only
 */
exports.approvePayrollSetup = functions.https.onCall(async (data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.userType) !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    const { id } = data;
    if (!id) {
        throw new functions.https.HttpsError('invalid-argument', 'Setup ID required');
    }
    await db.collection('payrollSetups').doc(id).update({
        status: 'active',
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: context.auth.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    // Update client's payroll status
    const setupDoc = await db.collection('payrollSetups').doc(id).get();
    const setupData = setupDoc.data();
    if (setupData === null || setupData === void 0 ? void 0 : setupData.clientId) {
        await db.collection('users').doc(setupData.clientId).update({
            payrollStatus: 'active',
            payrollSetupId: id
        });
    }
    return { success: true };
});
/**
 * Get payroll setup details with sensitive data
 * Callable by admin only
 */
exports.getPayrollSetupDetails = functions.https.onCall(async (data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
    }
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!userDoc.exists || ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.userType) !== 'admin') {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    const { id } = data;
    if (!id) {
        throw new functions.https.HttpsError('invalid-argument', 'Setup ID required');
    }
    const setupDoc = await db.collection('payrollSetups').doc(id).get();
    if (!setupDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Setup not found');
    }
    const setupData = setupDoc.data();
    // Get client details
    const clientDoc = await db.collection('users').doc(setupData === null || setupData === void 0 ? void 0 : setupData.clientId).get();
    const clientData = clientDoc.data();
    return Object.assign(Object.assign({ id: setupDoc.id }, setupData), { clientName: (clientData === null || clientData === void 0 ? void 0 : clientData.name) || (clientData === null || clientData === void 0 ? void 0 : clientData.displayName) || 'Unknown', clientEmail: (clientData === null || clientData === void 0 ? void 0 : clientData.email) || '' });
});
// Weekly hours flow removed — replaced by per-shift shiftHours.ts.
//# sourceMappingURL=payroll.js.map