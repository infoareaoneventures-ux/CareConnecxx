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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkStripeAccountStatus = exports.getStripeOnboardingLink = exports.createStripeConnectAccount = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const Stripe = require("stripe");
if (!admin.apps.length) {
    admin.initializeApp();
}
const stripe = new Stripe(((_a = functions.config().stripe) === null || _a === void 0 ? void 0 : _a.secret) || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();
const appUrl = () => {
    var _a;
    const url = ((_a = functions.config().app) === null || _a === void 0 ? void 0 : _a.url) || process.env.APP_URL;
    if (!url) {
        throw new functions.https.HttpsError("failed-precondition", "APP_URL is not configured for Stripe Connect redirects");
    }
    return url.replace(/\/+$/, "");
};
const buildAccountLink = async (accountId) => {
    const base = appUrl();
    return stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${base}/caregiver/payout?stripe=refresh`,
        return_url: `${base}/caregiver/payout?stripe=success`,
        type: "account_onboarding",
    });
};
const syncAccountStatus = async (accountId) => {
    const account = await stripe.accounts.retrieve(accountId);
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const detailsSubmitted = !!account.details_submitted;
    const complete = chargesEnabled && payoutsEnabled;
    const snap = await db.collection("caregivers")
        .where("stripeAccountId", "==", accountId)
        .limit(1)
        .get();
    if (!snap.empty) {
        const update = {
            chargesEnabled,
            payoutsEnabled,
            detailsSubmitted,
            stripeOnboardingComplete: complete,
        };
        if (complete) {
            update.stripeOnboardingCompletedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        await snap.docs[0].ref.update(update);
    }
    return { chargesEnabled, payoutsEnabled, detailsSubmitted, stripeOnboardingComplete: complete };
};
exports.createStripeConnectAccount = functions
    .https.onCall(async (data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
    }
    const uid = context.auth.uid;
    const email = (data === null || data === void 0 ? void 0 : data.email) || context.auth.token.email;
    const caregiverRef = db.collection("caregivers").doc(uid);
    const caregiverSnap = await caregiverRef.get();
    const existing = (_a = caregiverSnap.data()) === null || _a === void 0 ? void 0 : _a.stripeAccountId;
    if (existing) {
        const link = await buildAccountLink(existing);
        return { accountId: existing, onboardingUrl: link.url, onboardingComplete: false };
    }
    const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email,
        capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
        },
        business_type: "individual",
        metadata: { caregiverId: uid, platform: "careconnex" },
    });
    await caregiverRef.set({
        stripeAccountId: account.id,
        stripeOnboardingComplete: false,
        payoutsEnabled: false,
        chargesEnabled: false,
        detailsSubmitted: false,
        stripeAccountCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const link = await buildAccountLink(account.id);
    return { accountId: account.id, onboardingUrl: link.url, onboardingComplete: false };
});
exports.getStripeOnboardingLink = functions
    .https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
    }
    const accountId = data === null || data === void 0 ? void 0 : data.accountId;
    if (!accountId) {
        throw new functions.https.HttpsError("invalid-argument", "accountId is required");
    }
    const link = await buildAccountLink(accountId);
    return { url: link.url };
});
exports.checkStripeAccountStatus = functions
    .https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be logged in");
    }
    const accountId = data === null || data === void 0 ? void 0 : data.accountId;
    if (!accountId) {
        throw new functions.https.HttpsError("invalid-argument", "accountId is required");
    }
    return syncAccountStatus(accountId);
});
//# sourceMappingURL=stripeConnect.js.map