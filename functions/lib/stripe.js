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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCaregiverBillingPortalSession = exports.reactivateSubscription = exports.createIdentityVerificationSession = exports.cancelSubscription = exports.getSubscriptionDetails = exports.stripeWebhook = exports.createCheckoutSession = void 0;
exports.getStripeClient = getStripeClient;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const stripe_1 = __importDefault(require("stripe"));
// Initialize Stripe with secret key
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2023-10-16',
});
function getStripeClient() { return stripe; }
// Webhook secret for verifying Stripe events
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
// Price ID for $29.95/month membership (legacy fallback)
const MEMBERSHIP_PRICE_ID = process.env.STRIPE_MEMBERSHIP_PRICE_ID || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO';
// Allowed price IDs for all three plans + caregiver membership
const ALLOWED_PRICE_IDS = [
    process.env.STRIPE_PRICE_MONTHLY || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO',
    process.env.STRIPE_PRICE_QUARTERLY || '',
    process.env.STRIPE_PRICE_ANNUAL || '',
    process.env.STRIPE_CAREGIVER_ANNUAL || 'price_1TO8L6L7Ss5iuUb7Vrbea2tg',
    process.env.STRIPE_CAREGIVER_MONTHLY || '',
    MEMBERSHIP_PRICE_ID,
].filter(Boolean);
/**
 * Create a Stripe Checkout session for membership subscription
 */
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
    var _a, _b;
    // Verify authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const { successUrl, cancelUrl, priceId, includeMVR } = data;
    const userId = context.auth.uid;
    // Resolve which price to charge — validate against allowed list
    const resolvedPriceId = (priceId && ALLOWED_PRICE_IDS.includes(priceId))
        ? priceId
        : MEMBERSHIP_PRICE_ID;
    const mvrPriceId = (process.env.STRIPE_MVR_PRICE_ID || '').trim();
    const addMVR = includeMVR === true && mvrPriceId.length > 0 && !mvrPriceId.startsWith('FILL_IN');
    try {
        // Get or create Stripe customer
        const userRef = admin.firestore().collection('customers').doc(userId);
        const userDoc = await userRef.get();
        let customerId = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.stripeCustomerId;
        if (!customerId) {
            // Get user email from Auth
            const user = await admin.auth().getUser(userId);
            // Create new Stripe customer
            const customer = await stripe.customers.create({
                email: user.email,
                metadata: {
                    firebaseUID: userId,
                },
            });
            customerId = customer.id;
            // Save to Firestore
            await userRef.set({
                stripeCustomerId: customerId,
                email: user.email,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        const lineItems = [
            { price: resolvedPriceId, quantity: 1 },
        ];
        if (addMVR) {
            lineItems.push({ price: mvrPriceId, quantity: 1 });
        }
        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            line_items: lineItems,
            mode: 'subscription',
            success_url: successUrl,
            cancel_url: cancelUrl,
            subscription_data: {
                metadata: {
                    firebaseUID: userId,
                },
            },
            metadata: Object.assign({ firebaseUID: userId }, (addMVR && { includeMVR: 'true' })),
        });
        return { sessionId: session.id, url: session.url };
    }
    catch (error) {
        const stripeMsg = ((_b = error === null || error === void 0 ? void 0 : error.raw) === null || _b === void 0 ? void 0 : _b.message) || (error === null || error === void 0 ? void 0 : error.message) || String(error);
        console.error('Error creating checkout session:', stripeMsg, error);
        throw new functions.https.HttpsError('internal', `Failed to create checkout session: ${stripeMsg}`);
    }
});
/**
 * Stripe webhook handler for subscription events
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) {
        res.status(400).send('Missing stripe-signature header');
        return;
    }
    if (!webhookSecret) {
        console.error('STRIPE_WEBHOOK_SECRET is not configured — refusing to process webhook');
        res.status(500).send('Webhook secret not configured');
        return;
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    }
    catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }
    // Handle the event
    try {
        // Idempotency check: Ensure we don't process the same event twice
        const eventRef = admin.firestore().collection('processed_stripe_events').doc(event.id);
        const eventDoc = await eventRef.get();
        if (eventDoc.exists) {
            console.log(`Event ${event.id} already processed. Skipping.`);
            res.json({ received: true, status: 'already_processed' });
            return;
        }
        // Mark as processing/processed
        await eventRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                await handleCheckoutSessionCompleted(session);
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                await handleInvoicePaymentSucceeded(invoice);
                break;
            }
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                await handleInvoicePaymentFailed(invoice);
                break;
            }
            case 'customer.subscription.created': {
                const subscription = event.data.object;
                await handleSubscriptionCreated(subscription);
                break;
            }
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                await handleSubscriptionUpdated(subscription);
                break;
            }
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                await handleSubscriptionDeleted(subscription);
                break;
            }
            case 'identity.verification_session.verified':
            case 'identity.verification_session.processing':
            case 'identity.verification_session.requires_input':
            case 'identity.verification_session.canceled': {
                const session = event.data.object;
                await handleIdentityVerificationEvent(session);
                break;
            }
            case 'payment_intent.succeeded': {
                const intent = event.data.object;
                await handleShiftPaymentIntentSucceeded(intent);
                break;
            }
            case 'payment_intent.payment_failed': {
                const intent = event.data.object;
                await handleShiftPaymentIntentFailed(intent);
                break;
            }
            case 'payment_method.attached': {
                const pm = event.data.object;
                await handlePaymentMethodAttached(pm);
                break;
            }
            default:
                console.log(`Unhandled event type: ${event.type}`);
        }
        res.json({ received: true });
    }
    catch (error) {
        console.error('Error handling webhook event:', error);
        res.status(500).send('Internal server error');
    }
});
/**
 * Handle checkout.session.completed
 * For caregiver payments: auto-initiate Checkr background check + set verificationStatus submitted
 */
async function handleCheckoutSessionCompleted(session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    // Cara iMessage onboarding — advance step when client finishes payment setup
    if (((_a = session.metadata) === null || _a === void 0 ? void 0 : _a.task) === 'client_payment_setup' && ((_b = session.metadata) === null || _b === void 0 ? void 0 : _b.phone)) {
        try {
            const phone = session.metadata.phone;
            const subscriptionId = typeof session.subscription === 'string'
                ? session.subscription
                : (_d = (_c = session.subscription) === null || _c === void 0 ? void 0 : _c.id) !== null && _d !== void 0 ? _d : '';
            const customerId = typeof session.customer === 'string'
                ? session.customer
                : (_f = (_e = session.customer) === null || _e === void 0 ? void 0 : _e.id) !== null && _f !== void 0 ? _f : '';
            if (subscriptionId || customerId) {
                await admin.firestore().collection('agent_sessions').doc(phone).update(Object.assign(Object.assign({}, (subscriptionId ? { stripeSubscriptionId: subscriptionId } : {})), (customerId ? { stripeCustomerId: customerId } : {}))).catch(() => { });
            }
            // Pass the subscription id through so the user doc records a REAL subscription.
            const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require('./agents/onboardingConversation')));
            await advanceOnboardingStep(phone, 'payment', subscriptionId);
        }
        catch (err) {
            console.error('advanceOnboardingStep(payment) error:', err);
        }
        return;
    }
    // Cara iMessage onboarding — caregiver membership payment complete
    if (((_g = session.metadata) === null || _g === void 0 ? void 0 : _g.task) === 'caregiver_membership' && ((_h = session.metadata) === null || _h === void 0 ? void 0 : _h.phone)) {
        try {
            const phone = session.metadata.phone;
            const subscriptionId = typeof session.subscription === 'string'
                ? session.subscription
                : (_k = (_j = session.subscription) === null || _j === void 0 ? void 0 : _j.id) !== null && _k !== void 0 ? _k : '';
            const update = {};
            // If MVR was included in the checkout, flag the session so Checkr uses the MVR package
            if (((_l = session.metadata) === null || _l === void 0 ? void 0 : _l.includeMVR) === 'true')
                update.mvrPaid = true;
            if (subscriptionId)
                update.caregiverSubscriptionId = subscriptionId;
            if (Object.keys(update).length) {
                await admin.firestore().collection('agent_sessions').doc(phone).update(update).catch(() => { });
            }
            const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require('./agents/onboardingConversation')));
            await advanceOnboardingStep(phone, 'membership', '');
        }
        catch (err) {
            console.error('advanceOnboardingStep(membership) error:', err);
        }
        return;
    }
    const userId = (_m = session.metadata) === null || _m === void 0 ? void 0 : _m.firebaseUID;
    if (!userId)
        return;
    await admin.firestore().collection('users').doc(userId).set({
        membershipStatus: 'active',
        stripeCustomerId: session.customer,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    // Only continue for caregivers
    const caregiverSnap = await admin.firestore().collection('caregivers').doc(userId).get();
    if (!caregiverSnap.exists) {
        console.log(`Checkout completed for client user: ${userId}`);
        return;
    }
    const caregiverData = caregiverSnap.data() || {};
    // Idempotency: skip if Checkr already initiated and invitation not expired
    const bgData = caregiverData.backgroundCheckData || {};
    if (bgData.checkrCandidateId && bgData.invitationStatus !== 'expired' && bgData.invitationStatus !== 'canceled') {
        await admin.firestore().collection('caregivers').doc(userId).set({
            membershipPaid: true,
            verificationStatus: 'submitted',
        }, { merge: true });
        console.log(`Checkr already initiated for caregiver: ${userId}`);
        return;
    }
    // Gather caregiver info for Checkr candidate
    let email;
    try {
        const authUser = await admin.auth().getUser(userId);
        email = authUser.email;
    }
    catch (e) {
        console.error(`Could not get auth user for ${userId}`, e);
    }
    if (!email) {
        console.error(`Caregiver ${userId} has no email — cannot initiate Checkr`);
        return;
    }
    const nameParts = (caregiverData.name || '').trim().split(/\s+/);
    const firstName = caregiverData.firstName || nameParts[0] || '';
    const lastName = caregiverData.lastName || nameParts.slice(1).join(' ') || '';
    const zipCode = (caregiverData.zipCode || caregiverData.zip || '').trim();
    const state = (caregiverData.state || '').trim();
    const includeMVRFlag = ((_o = session.metadata) === null || _o === void 0 ? void 0 : _o.includeMVR) === 'true';
    if (!firstName || !lastName || !zipCode) {
        console.warn(`Caregiver ${userId} missing profile fields — marking paid, deferring Checkr`);
        await admin.firestore().collection('caregivers').doc(userId).set(Object.assign({ membershipPaid: true, checkrInitPending: true }, (includeMVRFlag && { mvrPaid: true })), { merge: true });
        return;
    }
    const apiKey = (process.env.CHECKR_KEY || process.env.CHECKR_API_KEY || '').trim();
    if (!apiKey) {
        console.error('CHECKR_KEY / CHECKR_API_KEY not configured — marking paid, skipping Checkr');
        await admin.firestore().collection('caregivers').doc(userId).set({ membershipPaid: true }, { merge: true });
        return;
    }
    try {
        const CHECKR_BASE = process.env.CHECKR_API_URL || 'https://api.checkr.com/v1';
        const CHECKR_PKG_BASE = process.env.CHECKR_PACKAGE || 'driver_pro';
        const CHECKR_PKG_MVR = process.env.CHECKR_PACKAGE_MVR || CHECKR_PKG_BASE;
        const CHECKR_PKG = includeMVRFlag ? CHECKR_PKG_MVR : CHECKR_PKG_BASE;
        const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
        const dateKey = new Date().toISOString().slice(0, 10);
        const workLocations = state ? [{ country: 'US', state: state.toUpperCase() }] : [];
        const candidateBody = {
            first_name: firstName, last_name: lastName, email,
            zipcode: zipCode, custom_id: userId,
        };
        if (workLocations.length)
            candidateBody.work_locations = workLocations;
        const candidateRes = await fetch(`${CHECKR_BASE}/candidates`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': `${userId}-candidate-${dateKey}` },
            body: JSON.stringify(candidateBody),
        });
        if (!candidateRes.ok) {
            const errText = await candidateRes.text().catch(() => '');
            console.error(`Checkr candidate failed for ${userId}: ${candidateRes.status} ${errText}`);
            await admin.firestore().collection('caregivers').doc(userId).set({ membershipPaid: true }, { merge: true });
            return;
        }
        const candidate = await candidateRes.json();
        const candidateId = candidate.id;
        const invBody = { candidate_id: candidateId, package: CHECKR_PKG };
        if (workLocations.length)
            invBody.work_locations = workLocations;
        const invRes = await fetch(`${CHECKR_BASE}/invitations`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': `${userId}-invitation-${dateKey}` },
            body: JSON.stringify(invBody),
        });
        const invOk = invRes.ok;
        if (!invOk) {
            const errText = await invRes.text().catch(() => '');
            console.error(`Checkr invitation failed for ${userId}: ${invRes.status} ${errText}`);
        }
        await admin.firestore().collection('caregivers').doc(userId).set(Object.assign(Object.assign({ membershipPaid: true }, (includeMVRFlag && { mvrPaid: true })), { verificationStatus: 'submitted', backgroundCheckData: Object.assign({ checkrCandidateId: candidateId, legalFirstName: firstName, legalLastName: lastName, zip: zipCode, submittedAt: new Date().toISOString(), status: 'pending', invitationStatus: invOk ? 'sent' : 'error', initiatedVia: 'stripe_webhook' }, (includeMVRFlag && { mvrIncluded: true })) }), { merge: true });
        await admin.firestore().collection('users').doc(userId).set({
            verificationStatus: 'submitted',
        }, { merge: true });
        console.log(`Checkr initiated for caregiver: ${userId}, candidate: ${candidateId}`);
    }
    catch (err) {
        console.error(`Checkr auto-initiation error for ${userId}:`, err === null || err === void 0 ? void 0 : err.message);
        await admin.firestore().collection('caregivers').doc(userId).set({ membershipPaid: true }, { merge: true });
    }
}
/**
 * Handle invoice.payment_succeeded
 */
async function handleInvoicePaymentSucceeded(invoice) {
    var _a;
    const subscriptionId = invoice.subscription;
    if (!subscriptionId)
        return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const userId = (_a = subscription.metadata) === null || _a === void 0 ? void 0 : _a.firebaseUID;
    if (!userId)
        return;
    // Record payment
    await admin.firestore().collection('payments').add({
        userId,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscriptionId,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        status: 'succeeded',
        periodStart: new Date(invoice.period_start * 1000),
        periodEnd: new Date(invoice.period_end * 1000),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Restore membership status on renewal
    await admin.firestore().collection('users').doc(userId).set({
        membershipStatus: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    // Notify caregiver of successful payment
    const amountPaid = (invoice.amount_paid / 100).toFixed(2);
    const isRenewal = invoice.billing_reason === 'subscription_cycle';
    await admin.firestore().collection('users').doc(userId).collection('notifications').add({
        userId,
        type: 'membership_payment_succeeded',
        title: isRenewal ? 'Membership Renewed' : 'Membership Activated',
        body: isRenewal
            ? `Your CareConnex membership has been renewed. $${amountPaid} was charged.`
            : `Your CareConnex membership is now active. $${amountPaid} was charged.`,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Only re-initiate Checkr on annual renewal, not on first subscription payment
    if (invoice.billing_reason !== 'subscription_cycle') {
        console.log(`Invoice succeeded for ${userId} — billing_reason: ${invoice.billing_reason}, skipping Checkr re-initiation`);
        return;
    }
    const caregiverSnap = await admin.firestore().collection('caregivers').doc(userId).get();
    if (!caregiverSnap.exists)
        return;
    const caregiverData = caregiverSnap.data() || {};
    const bgData = caregiverData.backgroundCheckData || {};
    const existingCandidateId = bgData.checkrCandidateId;
    if (!existingCandidateId) {
        console.log(`Renewal for caregiver ${userId} but no checkrCandidateId — skipping Checkr`);
        return;
    }
    // Renewal: reset verification and re-run Checkr for the existing candidate
    console.log(`Annual renewal for caregiver ${userId} — re-initiating Checkr`);
    const apiKey = (process.env.CHECKR_KEY || process.env.CHECKR_API_KEY || '').trim();
    if (!apiKey) {
        console.error('CHECKR_KEY not configured — skipping Checkr renewal');
        return;
    }
    try {
        const CHECKR_BASE = process.env.CHECKR_API_URL || 'https://api.checkr.com/v1';
        const CHECKR_PKG = process.env.CHECKR_PACKAGE || 'driver_pro';
        const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
        const dateKey = new Date().toISOString().slice(0, 10);
        const invRes = await fetch(`${CHECKR_BASE}/invitations`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': `${userId}-renewal-${dateKey}` },
            body: JSON.stringify({ candidate_id: existingCandidateId, package: CHECKR_PKG }),
        });
        const invOk = invRes.ok;
        if (!invOk) {
            const errText = await invRes.text().catch(() => '');
            console.error(`Checkr renewal invitation failed for ${userId}: ${invRes.status} ${errText}`);
        }
        await admin.firestore().collection('caregivers').doc(userId).set({
            verified: false,
            verificationStatus: 'submitted',
            backgroundCheckStatus: 'pending',
            backgroundCheckComplete: false,
            backgroundCheckData: Object.assign(Object.assign({}, bgData), { submittedAt: new Date().toISOString(), status: 'pending', invitationStatus: invOk ? 'sent' : 'error', initiatedVia: 'annual_renewal', checkrClearedAt: null }),
        }, { merge: true });
        console.log(`Checkr renewal initiated for caregiver: ${userId}`);
    }
    catch (err) {
        console.error(`Checkr renewal error for ${userId}:`, err === null || err === void 0 ? void 0 : err.message);
    }
}
/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(invoice) {
    var _a, _b;
    const subscriptionId = invoice.subscription;
    if (!subscriptionId)
        return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const userId = (_a = subscription.metadata) === null || _a === void 0 ? void 0 : _a.firebaseUID;
    if (!userId)
        return;
    // Record failed payment
    await admin.firestore().collection('payments').add({
        userId,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscriptionId,
        amount: invoice.amount_due,
        currency: invoice.currency,
        status: 'failed',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Stripe Smart Retries drive the actual retry attempts; each failed attempt
    // re-fires this webhook. `attempt_count` tells us which attempt this is, and a
    // null `next_payment_attempt` means Stripe has exhausted retries (final notice).
    const attemptCount = (_b = invoice.attempt_count) !== null && _b !== void 0 ? _b : 1;
    const isFinalAttempt = invoice.next_payment_attempt == null;
    const nextRetryDate = invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : null;
    // Update user status
    await admin.firestore().collection('users').doc(userId).update({
        membershipStatus: 'payment_failed',
        subscriptionStatus: 'past_due',
        paymentFailureCount: attemptCount,
        lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Escalating dunning communication — tone sharpens with each failed attempt,
    // and the final attempt warns that access is about to end.
    const billingUrl = "cara.app/billing";
    let dunningMsg;
    if (isFinalAttempt) {
        dunningMsg =
            "We weren't able to process your CareConnex membership payment after several tries, " +
                `so your membership is now at risk of being canceled. To keep your access, please update your ` +
                `payment method at ${billingUrl} today. Reply HELP if you need a hand.`;
    }
    else if (attemptCount <= 1) {
        dunningMsg =
            "Heads up — we couldn't process your CareConnex membership payment. " +
                `No action needed if your card just needs a moment, but you can update billing anytime at ${billingUrl}.` +
                (nextRetryDate ? ` We'll retry on ${nextRetryDate}.` : "");
    }
    else {
        dunningMsg =
            "We still haven't been able to process your CareConnex membership payment. " +
                `Please update your payment method at ${billingUrl} to avoid an interruption.` +
                (nextRetryDate ? ` Next retry: ${nextRetryDate}.` : "") +
                " Reply HELP if you need assistance.";
    }
    // Proactively text the client via Cara
    try {
        const sessionSnap = await admin.firestore()
            .collection("agent_sessions")
            .where("userId", "==", userId)
            .where("optedOut", "==", false)
            .limit(1)
            .get();
        if (!sessionSnap.empty) {
            const clientPhone = sessionSnap.docs[0].id;
            const { sendViaInteractionAgent } = await Promise.resolve().then(() => __importStar(require("./agents/caraAgent")));
            await sendViaInteractionAgent(clientPhone, {
                content: dunningMsg,
                urgency: "immediate",
                sourceAgent: "billing",
                canDrop: false,
                // Billing/legal notice — force SMS for reliable delivery, never iMessage.
                preferredService: "SMS",
            });
        }
    }
    catch (err) {
        console.error(`handleInvoicePaymentFailed: failed to notify client ${userId}:`, err);
    }
    // In-app notification in addition to SMS
    try {
        const notifBody = isFinalAttempt
            ? 'We were unable to process your membership payment. Your access is at risk — please update your payment method.'
            : `We couldn't process your membership payment (attempt ${attemptCount}).${nextRetryDate ? ` We'll retry on ${nextRetryDate}.` : ' Please update your payment method.'}`;
        await admin.firestore().collection('users').doc(userId).collection('notifications').add({
            userId,
            type: 'membership_payment_failed',
            title: 'Membership Payment Failed',
            body: notifBody,
            isRead: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
    catch (err) {
        console.error(`handleInvoicePaymentFailed: failed to write in-app notification for ${userId}:`, err);
    }
    console.log(`Payment failed for user: ${userId} (attempt ${attemptCount}, final: ${isFinalAttempt})`);
}
/**
 * Handle customer.subscription.created
 */
async function handleSubscriptionCreated(subscription) {
    var _a, _b;
    const userId = (_a = subscription.metadata) === null || _a === void 0 ? void 0 : _a.firebaseUID;
    if (!userId)
        return;
    // Save subscription to Firestore
    await admin.firestore()
        .collection('customers')
        .doc(userId)
        .collection('subscriptions')
        .doc(subscription.id)
        .set({
        id: subscription.id,
        status: subscription.status,
        price_id: (_b = subscription.items.data[0]) === null || _b === void 0 ? void 0 : _b.price.id,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        created: new Date(subscription.created * 1000),
        cancel_at_period_end: subscription.cancel_at_period_end,
        metadata: subscription.metadata,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Update user document
    await admin.firestore().collection('users').doc(userId).update({
        membershipStatus: subscription.status,
        subscriptionId: subscription.id,
        subscriptionActive: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Subscription created for user: ${userId}`);
}
/**
 * Handle customer.subscription.updated
 */
async function handleSubscriptionUpdated(subscription) {
    var _a;
    const userId = (_a = subscription.metadata) === null || _a === void 0 ? void 0 : _a.firebaseUID;
    if (!userId)
        return;
    // Update subscription in Firestore
    await admin.firestore()
        .collection('customers')
        .doc(userId)
        .collection('subscriptions')
        .doc(subscription.id)
        .update({
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000),
        cancel_at_period_end: subscription.cancel_at_period_end,
        canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Update user document
    await admin.firestore().collection('users').doc(userId).update({
        membershipStatus: subscription.status,
        subscriptionActive: subscription.status === 'active' || subscription.status === 'trialing',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Subscription updated for user: ${userId}`);
}
/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(subscription) {
    var _a;
    const userId = (_a = subscription.metadata) === null || _a === void 0 ? void 0 : _a.firebaseUID;
    if (!userId)
        return;
    // Update subscription in Firestore
    await admin.firestore()
        .collection('customers')
        .doc(userId)
        .collection('subscriptions')
        .doc(subscription.id)
        .update({
        status: 'canceled',
        canceled_at: new Date(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Update user document
    await admin.firestore().collection('users').doc(userId).update({
        membershipStatus: 'canceled',
        subscriptionActive: false,
        subscriptionId: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await admin.firestore().collection('users').doc(userId).collection('notifications').add({
        userId,
        type: 'membership_cancelled',
        title: 'Membership Cancelled',
        body: 'Your CareConnex membership has been cancelled.',
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Subscription canceled for user: ${userId}`);
}
/**
 * Get user's subscription details
 */
exports.getSubscriptionDetails = functions.https.onCall(async (data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const userId = context.auth.uid;
    try {
        const subscriptions = await admin.firestore()
            .collection('customers')
            .doc(userId)
            .collection('subscriptions')
            .where('status', 'in', ['active', 'trialing'])
            .limit(1)
            .get();
        if (subscriptions.empty) {
            return { hasSubscription: false };
        }
        const subscription = subscriptions.docs[0].data();
        return {
            hasSubscription: true,
            subscription: {
                id: subscription.id,
                status: subscription.status,
                currentPeriodEnd: (_a = subscription.current_period_end) === null || _a === void 0 ? void 0 : _a.toDate(),
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                priceId: subscription.price_id,
            },
        };
    }
    catch (error) {
        console.error('Error getting subscription details:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get subscription details');
    }
});
/**
 * Cancel subscription
 */
exports.cancelSubscription = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const userId = context.auth.uid;
    try {
        // Get active subscription
        const subscriptions = await admin.firestore()
            .collection('customers')
            .doc(userId)
            .collection('subscriptions')
            .where('status', 'in', ['active', 'trialing'])
            .limit(1)
            .get();
        if (subscriptions.empty) {
            throw new functions.https.HttpsError('not-found', 'No active subscription found');
        }
        const subscriptionId = subscriptions.docs[0].id;
        // Cancel in Stripe
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        });
        return { success: true };
    }
    catch (error) {
        console.error('Error canceling subscription:', error);
        throw new functions.https.HttpsError('internal', 'Failed to cancel subscription');
    }
});
/**
 * Create a Stripe Identity verification session and return the hosted URL.
 * Client should redirect the browser to `url`; Stripe sends the user back to
 * `returnUrl` once they finish (or abandon) the flow.
 */
exports.createIdentityVerificationSession = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const userId = context.auth.uid;
    const { returnUrl } = data;
    if (!returnUrl || typeof returnUrl !== 'string') {
        throw new functions.https.HttpsError('invalid-argument', 'returnUrl is required');
    }
    try {
        const session = await stripe.identity.verificationSessions.create({
            type: 'id_number',
            metadata: { firebaseUID: userId },
            return_url: returnUrl,
        });
        await admin.firestore().collection('users').doc(userId).set({
            identityCheckStatus: 'processing',
            stripeIdentityVerificationId: session.id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        return { id: session.id, url: session.url, clientSecret: session.client_secret };
    }
    catch (error) {
        console.error('Error creating identity verification session:', error);
        throw new functions.https.HttpsError('internal', error.message || 'Failed to create verification session');
    }
});
/**
 * Handle Stripe Identity webhook events — mirror session status onto the user doc
 * so the client can unblock gated actions as soon as the webhook lands.
 */
async function handleIdentityVerificationEvent(session) {
    var _a, _b;
    const userId = (_a = session.metadata) === null || _a === void 0 ? void 0 : _a.firebaseUID;
    const phone = (_b = session.metadata) === null || _b === void 0 ? void 0 : _b.phone;
    const statusMap = {
        verified: 'verified',
        processing: 'processing',
        requires_input: 'requires_input',
        canceled: 'canceled',
    };
    const status = statusMap[session.status] || session.status;
    // ── iMessage onboarding flow (phone metadata, no firebaseUID yet) ──────────
    if (phone) {
        const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require('./agents/onboardingConversation')));
        const { sendToPhone } = await Promise.resolve().then(() => __importStar(require('./linq/client')));
        if (status === 'verified') {
            try {
                await advanceOnboardingStep(phone, 'identity', '');
            }
            catch (err) {
                console.error('advanceOnboardingStep(identity) error:', err);
            }
        }
        else if (status === 'requires_input' || status === 'canceled') {
            // Let the client retry — send a FRESH link (the original may have scrolled
            // off or been consumed), not just "tap the link above".
            await sendToPhone(phone, "Hmm, that ID check didn't go through — it happens. Here's a fresh link to try again:").catch((err) => console.error('identity retry message error:', err));
            try {
                const { sendOnboardingLink } = await Promise.resolve().then(() => __importStar(require('./agents/onboardingConversation')));
                await sendOnboardingLink(phone, 'client_identity');
            }
            catch (err) {
                console.error('identity retry link error:', err);
            }
        }
        // Don't return — also update Firestore users doc if firebaseUID is present
    }
    // ── Firebase user doc update (web-app flow or post-auth iMessage users) ─────
    if (!userId) {
        if (!phone)
            console.warn('Identity session missing both firebaseUID and phone metadata:', session.id);
        return;
    }
    const update = {
        identityCheckStatus: status,
        stripeIdentityVerificationId: session.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (status === 'verified') {
        update.identityVerifiedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    await admin.firestore().collection('users').doc(userId).set(update, { merge: true });
    console.log(`Identity verification ${status} for user: ${userId}`);
}
/**
 * Confirm a shift charge actually settled. The inline `processShiftPayment`
 * call awaits paymentIntents.create with confirm:true, but Stripe can still
 * return a 'requires_action' / 'processing' status for 3DS or fraud holds.
 * This webhook is the authoritative signal that the money actually moved.
 */
async function handleShiftPaymentIntentSucceeded(intent) {
    var _a, _b;
    const appointmentId = ((_a = intent.metadata) === null || _a === void 0 ? void 0 : _a.appointmentId)
        || ((_b = intent.metadata) === null || _b === void 0 ? void 0 : _b.shiftHoursId);
    if (!appointmentId)
        return; // Not a shift charge — ignore.
    const ref = admin.firestore().collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists)
        return;
    await ref.update({
        chargeConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        stripeChargeStatus: 'succeeded',
    });
}
async function handleShiftPaymentIntentFailed(intent) {
    var _a, _b, _c;
    const appointmentId = ((_a = intent.metadata) === null || _a === void 0 ? void 0 : _a.appointmentId)
        || ((_b = intent.metadata) === null || _b === void 0 ? void 0 : _b.shiftHoursId);
    if (!appointmentId)
        return;
    const ref = admin.firestore().collection('shiftHours').doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists)
        return;
    const reason = ((_c = intent.last_payment_error) === null || _c === void 0 ? void 0 : _c.message) || 'payment_intent.payment_failed';
    await ref.update({
        status: 'payment_failed',
        stripeFailureReason: reason,
        stripeChargeStatus: 'failed',
        updatedAt: new Date().toISOString(),
    });
}
/**
 * Reactivate subscription
 */
exports.reactivateSubscription = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const userId = context.auth.uid;
    try {
        // Get subscription with cancel_at_period_end
        const subscriptions = await admin.firestore()
            .collection('customers')
            .doc(userId)
            .collection('subscriptions')
            .where('cancel_at_period_end', '==', true)
            .limit(1)
            .get();
        if (subscriptions.empty) {
            throw new functions.https.HttpsError('not-found', 'No canceled subscription found');
        }
        const subscriptionId = subscriptions.docs[0].id;
        // Reactivate in Stripe
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: false,
        });
        return { success: true };
    }
    catch (error) {
        console.error('Error reactivating subscription:', error);
        throw new functions.https.HttpsError('internal', 'Failed to reactivate subscription');
    }
});
/**
 * Create a Stripe Billing Portal session for a caregiver to manage their
 * membership subscription (update card, view invoices, cancel).
 */
exports.createCaregiverBillingPortalSession = functions.https.onCall(async (data, context) => {
    var _a;
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }
    const userId = context.auth.uid;
    const returnUrl = (data === null || data === void 0 ? void 0 : data.returnUrl) || `${process.env.APP_URL || 'https://careconnex.app'}/caregiver/payments`;
    try {
        const customerDoc = await admin.firestore().collection('customers').doc(userId).get();
        const customerId = (_a = customerDoc.data()) === null || _a === void 0 ? void 0 : _a.stripeCustomerId;
        if (!customerId) {
            throw new functions.https.HttpsError('not-found', 'No billing account found. Please purchase a membership first.');
        }
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });
        return { url: session.url };
    }
    catch (error) {
        if (error instanceof functions.https.HttpsError)
            throw error;
        console.error('Error creating billing portal session:', error);
        throw new functions.https.HttpsError('internal', 'Failed to open billing portal');
    }
});
// ── Auto-retry booking tasks when client adds a payment method ────────────────
async function handlePaymentMethodAttached(pm) {
    var _a;
    const customerId = typeof pm.customer === "string" ? pm.customer : (_a = pm.customer) === null || _a === void 0 ? void 0 : _a.id;
    if (!customerId)
        return;
    const db = admin.firestore();
    // Find booking tasks awaiting payment setup for this customer
    const taskSnap = await db.collection("agent_tasks")
        .where("stripeCustomerId", "==", customerId)
        .where("status", "==", "pending_payment_setup")
        .get();
    if (taskSnap.empty)
        return;
    for (const taskDoc of taskSnap.docs) {
        const task = taskDoc.data();
        const clientPhone = task.clientPhone;
        if (!clientPhone)
            continue;
        try {
            // Reset status so executeBookings can proceed
            await taskDoc.ref.update({ status: "approved" });
            const { executeBookings } = await Promise.resolve().then(() => __importStar(require("./agents/bookingExecutor")));
            await executeBookings(taskDoc.id, clientPhone);
            console.log(`[handlePaymentMethodAttached] Retried booking task ${taskDoc.id} for customer ${customerId}`);
        }
        catch (err) {
            console.error(`[handlePaymentMethodAttached] retry failed for task ${taskDoc.id}:`, err);
            await taskDoc.ref.update({ status: "pending_payment_setup" }); // revert
        }
    }
}
//# sourceMappingURL=stripe.js.map