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
exports.reactivateSubscription = exports.createIdentityVerificationSession = exports.cancelSubscription = exports.getSubscriptionDetails = exports.stripeWebhook = exports.createCheckoutSession = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const stripe_1 = __importDefault(require("stripe"));
// Initialize Stripe with secret key
const stripe = new stripe_1.default(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2023-10-16',
});
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
    var _a, _b, _c, _d;
    // Cara iMessage onboarding — advance step when client finishes payment setup
    if (((_a = session.metadata) === null || _a === void 0 ? void 0 : _a.task) === 'client_payment_setup' && ((_b = session.metadata) === null || _b === void 0 ? void 0 : _b.phone)) {
        try {
            const { advanceOnboardingStep } = await Promise.resolve().then(() => __importStar(require('./agents/onboardingConversation')));
            await advanceOnboardingStep(session.metadata.phone, 'payment', '');
        }
        catch (err) {
            console.error('advanceOnboardingStep(payment) error:', err);
        }
        return;
    }
    const userId = (_c = session.metadata) === null || _c === void 0 ? void 0 : _c.firebaseUID;
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
    const includeMVRFlag = ((_d = session.metadata) === null || _d === void 0 ? void 0 : _d.includeMVR) === 'true';
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
    console.log(`Payment succeeded for user: ${userId}`);
}
/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(invoice) {
    var _a;
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
    // Update user status
    await admin.firestore().collection('users').doc(userId).update({
        membershipStatus: 'payment_failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Payment failed for user: ${userId}`);
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
            // Let the client retry
            await sendToPhone(phone, "It looks like we need a little more info to verify you — tap the link above and try again.").catch((err) => console.error('identity retry message error:', err));
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
//# sourceMappingURL=stripe.js.map