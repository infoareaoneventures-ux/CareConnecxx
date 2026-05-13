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
exports.stripeConnectWebhook = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const Stripe = require("stripe");
if (!admin.apps.length) {
    admin.initializeApp();
}
const stripe = new Stripe(((_a = functions.config().stripe) === null || _a === void 0 ? void 0 : _a.secret) || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();
const connectWebhookSecret = () => { var _a; return ((_a = functions.config().stripe) === null || _a === void 0 ? void 0 : _a.connect_webhook_secret) || process.env.STRIPE_CONNECT_WEBHOOK_SECRET; };
exports.stripeConnectWebhook = functions
    .https.onRequest(async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig) {
        res.status(400).send("Missing stripe-signature header");
        return;
    }
    const secret = connectWebhookSecret();
    if (!secret) {
        console.error("STRIPE_CONNECT_WEBHOOK_SECRET is not configured — refusing to process webhook");
        res.status(500).send("Webhook secret not configured");
        return;
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
    }
    catch (err) {
        console.error("Connect webhook signature verification failed:", err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }
    try {
        if (event.type === "account.updated") {
            const account = event.data.object;
            const accountId = account.id;
            const snap = await db.collection("caregivers")
                .where("stripeAccountId", "==", accountId)
                .limit(1)
                .get();
            if (!snap.empty) {
                const chargesEnabled = !!account.charges_enabled;
                const payoutsEnabled = !!account.payouts_enabled;
                const detailsSubmitted = !!account.details_submitted;
                const complete = chargesEnabled && payoutsEnabled;
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
                // Advance Cara onboarding if caregiver has an iMessage session
                if (complete) {
                    try {
                        const cgPhone = snap.docs[0].data().phone;
                        if (cgPhone) {
                            const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require("./agents/onboardingConversation")));
                            await advanceOnboardingStep(cgPhone, "stripe_connect", "");
                        }
                    }
                    catch (err) {
                        console.error("advanceOnboardingStep(stripe_connect) error:", err);
                    }
                }
            }
        }
        else {
            console.log(`Unhandled Connect event: ${event.type}`);
        }
        res.json({ received: true });
    }
    catch (error) {
        console.error("Error handling Connect webhook event:", error);
        res.status(500).send("Internal server error");
    }
});
//# sourceMappingURL=stripeConnectWebhook.js.map