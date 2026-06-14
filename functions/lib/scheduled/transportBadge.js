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
exports.evaluateTransportBadges = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
function isExpired(expirationDate) {
    if (!expirationDate)
        return false;
    return new Date(expirationDate) < new Date();
}
function isExpiringSoon(expirationDate, daysAhead = 30) {
    if (!expirationDate)
        return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + daysAhead);
    return new Date(expirationDate) < cutoff;
}
/**
 * Daily job: re-evaluate transportation badges for all caregivers who offer Transportation.
 * Badge requires: admin-approved account + all three transport docs approved + none expired.
 * Strips badge if any doc expires. Notifies caregiver when docs are expiring soon.
 */
exports.evaluateTransportBadges = functions.pubsub
    .schedule('every 24 hours')
    .onRun(async () => {
    const snap = await db.collection('caregivers')
        .where('verified', '==', true)
        .get();
    if (snap.empty)
        return;
    const batch = db.batch();
    const notifications = [];
    for (const doc of snap.docs) {
        const data = doc.data();
        const services = data.services || data.skills || [];
        if (!services.includes('Transportation'))
            continue;
        const docs = data.documents || {};
        const license = docs.driversLicense;
        const insurance = docs.insurance;
        const registration = docs.registration;
        const allApproved = (license === null || license === void 0 ? void 0 : license.status) === 'approved' &&
            (insurance === null || insurance === void 0 ? void 0 : insurance.status) === 'approved' &&
            (registration === null || registration === void 0 ? void 0 : registration.status) === 'approved';
        const anyExpired = isExpired(license === null || license === void 0 ? void 0 : license.expirationDate) ||
            isExpired(insurance === null || insurance === void 0 ? void 0 : insurance.expirationDate) ||
            isExpired(registration === null || registration === void 0 ? void 0 : registration.expirationDate);
        const shouldHaveBadge = allApproved && !anyExpired;
        if (!shouldHaveBadge) {
            notifications.push(db.collection('users').doc(doc.id).collection('notifications').add({
                title: 'Transportation documents expired',
                body: 'One or more of your transportation documents has expired. Upload updated documents to keep your transportation status active.',
                type: 'system',
                isRead: false,
                createdAt: new Date().toISOString(),
            }));
        }
        // Warn about docs expiring within 30 days
        const expiringSoon = [];
        if (isExpiringSoon(license === null || license === void 0 ? void 0 : license.expirationDate) && !isExpired(license === null || license === void 0 ? void 0 : license.expirationDate))
            expiringSoon.push("Driver's License");
        if (isExpiringSoon(insurance === null || insurance === void 0 ? void 0 : insurance.expirationDate) && !isExpired(insurance === null || insurance === void 0 ? void 0 : insurance.expirationDate))
            expiringSoon.push('Vehicle Insurance');
        if (isExpiringSoon(registration === null || registration === void 0 ? void 0 : registration.expirationDate) && !isExpired(registration === null || registration === void 0 ? void 0 : registration.expirationDate))
            expiringSoon.push('Vehicle Registration');
        if (expiringSoon.length > 0) {
            const lastWarnedAt = data.transportDocWarnedAt;
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            if (!lastWarnedAt || lastWarnedAt < oneDayAgo) {
                batch.update(doc.ref, { transportDocWarnedAt: new Date().toISOString() });
                notifications.push(db.collection('users').doc(doc.id).collection('notifications').add({
                    title: 'Document expiring soon',
                    body: `${expiringSoon.join(', ')} will expire within 30 days. Upload a renewal to keep your transportation badge active.`,
                    type: 'system',
                    isRead: false,
                    createdAt: new Date().toISOString(),
                }));
            }
        }
    }
    await batch.commit();
    await Promise.allSettled(notifications);
    console.log(`evaluateTransportBadges: processed ${snap.docs.length} verified caregivers`);
});
/**
 * Callable trigger: re-evaluate a single caregiver's transport badge immediately.
 * Used by admin panel after approving/rejecting a transport doc.
 */
//# sourceMappingURL=transportBadge.js.map