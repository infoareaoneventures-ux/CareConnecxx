import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';
import Stripe from 'stripe';
import { claimWebhookEvent, settleWebhookEvent, STRIPE_EVENTS_COLLECTION } from './utils/webhookLedger';
import { fetchWithTimeout } from './utils/httpTimeout';
import { appLink } from './config/appUrl';
import { assertMvrPaymentConfig, assertMvrCheckConfig } from './mvrConfig';
import { writeCaregiverBackgroundPII } from './caregiverPrivate';

// Initialize Stripe with secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
  timeout: 10_000, // cap SDK calls (default 80s) so a slow Stripe response can't hold a webhook claim open to the function deadline
});

export function getStripeClient(): Stripe { return stripe; }

// Webhook secret for verifying Stripe events
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Price ID for $29.95/month membership (legacy fallback)
const MEMBERSHIP_PRICE_ID = process.env.STRIPE_MEMBERSHIP_PRICE_ID || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO';

// Allowed price IDs for all three plans + caregiver membership.
// NOTE: STRIPE_MVR_PRICE_ID is intentionally NOT in this list — the MVR add-on
// has its own dedicated callable (createMvrAddonCheckoutSession). If an MVR
// priceId is passed to createCheckoutSession it falls back to MEMBERSHIP_PRICE_ID,
// which is the correct safe default (silently ignores an unexpected priceId).
const ALLOWED_PRICE_IDS = [
  process.env.STRIPE_PRICE_MONTHLY        || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO',
  process.env.STRIPE_PRICE_QUARTERLY      || '',
  process.env.STRIPE_PRICE_ANNUAL         || '',
  // $54.99/yr caregiver membership (criminal-only background check via Checkr;
  // 2026-07-14 repricing — MVR is a separate $11.50 one-time add-on line item).
  // The old $66.49 price (price_1TqGrE…) and its product were archived in Stripe;
  // existing subscriptions keep billing on it, but new checkouts must not use it.
  process.env.STRIPE_CAREGIVER_ANNUAL     || 'price_1TtBYwL7Ss5iuUb7iZ1s0PQg',
  process.env.STRIPE_CAREGIVER_MONTHLY    || '',
  MEMBERSHIP_PRICE_ID,
].filter(Boolean);

/**
 * Create a Stripe Checkout session for membership subscription
 */
export const createCheckoutSession = functions.https.onCall(async (data, context) => {
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

    let customerId = userDoc.data()?.stripeCustomerId;

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

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
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
      metadata: {
        firebaseUID: userId,
        ...(addMVR && { includeMVR: 'true' }),
      },
    });

    return { sessionId: session.id, url: session.url };
  } catch (error: any) {
    const stripeMsg = error?.raw?.message || error?.message || String(error);
    console.error('Error creating checkout session:', stripeMsg, error);
    throw new functions.https.HttpsError('internal', `Failed to create checkout session: ${stripeMsg}`);
  }
});

/**
 * Create a one-time Stripe Checkout session for the standalone MVR ("Approved
 * Driver") add-on purchased after signup. Unlike membership (subscription mode),
 * this is a single one-time charge. On payment the webhook initiates an MVR-only
 * Checkr check (see handleCheckoutSessionCompleted, task: 'mvr_addon').
 *
 * Eligibility: any signed-in caregiver, anytime after signup — no base-check-cleared gate.
 */
export const createMvrAddonCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }
  const userId = context.auth.uid;
  const { successUrl, cancelUrl } = data || {};

  // Loud config check: refuse rather than create a checkout that can't deliver MVR.
  let mvrPriceId: string;
  try {
    mvrPriceId = assertMvrPaymentConfig();
  } catch (err) {
    console.error('createMvrAddonCheckoutSession: MVR not configured:', err);
    throw new functions.https.HttpsError('failed-precondition', 'The Approved Driver add-on is not available right now.');
  }

  try {
    // Get or create the Stripe customer (mirrors createCheckoutSession).
    const userRef = admin.firestore().collection('customers').doc(userId);
    const userDoc = await userRef.get();
    let customerId = userDoc.data()?.stripeCustomerId;
    if (!customerId) {
      const user = await admin.auth().getUser(userId);
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { firebaseUID: userId },
      });
      customerId = customer.id;
      await userRef.set({
        stripeCustomerId: customerId,
        email: user.email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: mvrPriceId, quantity: 1 }],
      mode: 'payment', // one-time charge, NOT a subscription
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { firebaseUID: userId, task: 'mvr_addon' },
      payment_intent_data: { metadata: { firebaseUID: userId, task: 'mvr_addon' } },
    });

    return { sessionId: session.id, url: session.url };
  } catch (error: any) {
    const stripeMsg = error?.raw?.message || error?.message || String(error);
    console.error('Error creating MVR add-on checkout session:', stripeMsg, error);
    throw new functions.https.HttpsError('internal', `Failed to create MVR checkout session: ${stripeMsg}`);
  }
});

/**
 * Stripe webhook handler for subscription events
 */
export const stripeWebhook = functions.https.onRequest(async (req, res) => {
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

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle the event
  try {
    // Exactly-once guard: atomically claim the event id before any side effect.
    // The claim is only stamped "processed" after the handler succeeds — a
    // failed run releases it so Stripe's retry can reprocess.
    if (await claimWebhookEvent(STRIPE_EVENTS_COLLECTION, event.id) === 'duplicate') {
      console.log(`Event ${event.id} already processed. Skipping.`);
      res.json({ received: true, status: 'already_processed' });
      return;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutSessionCompleted(session);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentSucceeded(invoice);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionCreated(subscription);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'identity.verification_session.verified':
      case 'identity.verification_session.processing':
      case 'identity.verification_session.requires_input':
      case 'identity.verification_session.canceled': {
        const session = event.data.object as Stripe.Identity.VerificationSession;
        await handleIdentityVerificationEvent(session);
        break;
      }

      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await handleShiftPaymentIntentSucceeded(intent);
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await handleShiftPaymentIntentFailed(intent);
        break;
      }

      case 'payment_method.attached': {
        const pm = event.data.object as Stripe.PaymentMethod;
        await handlePaymentMethodAttached(pm);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    await settleWebhookEvent(STRIPE_EVENTS_COLLECTION, event.id, 'processed');
    res.json({ received: true });
  } catch (error) {
    console.error('Error handling webhook event:', error);
    // Release the claim so Stripe's retry of this 500 actually reprocesses.
    await settleWebhookEvent(STRIPE_EVENTS_COLLECTION, event.id, 'failed');
    res.status(500).send('Internal server error');
  }
});

/**
 * Handle checkout.session.completed
 * For caregiver payments: auto-initiate Checkr background check + set verificationStatus submitted
 */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  // Evia iMessage onboarding — advance step when client finishes payment setup
  if (session.metadata?.task === 'client_payment_setup' && session.metadata?.phone) {
    try {
      const phone = session.metadata.phone;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription as any)?.id ?? '';
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : (session.customer as any)?.id ?? '';
      if (subscriptionId || customerId) {
        await admin.firestore().collection('agent_sessions').doc(phone).update({
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(customerId ? { stripeCustomerId: customerId } : {}),
        }).catch(() => {});
      }
      if (!subscriptionId) {
        console.error(`client_payment_setup completed without subscription id for phone=${phone}; membership remains inactive`);
        await admin.firestore().collection('admin_alerts').add({
          type: 'client_membership_missing_subscription',
          phone,
          stripeCheckoutSessionId: session.id,
          stripeCustomerId: customerId || null,
          severity: 'high',
          resolved: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }
      // Pass the subscription id through so the user doc records a REAL subscription.
      const { advanceOnboardingStep } = await import('./agents/onboardingConversation');
      await advanceOnboardingStep(phone, 'payment', subscriptionId);
    } catch (err) {
      console.error('advanceOnboardingStep(payment) error:', err);
    }
    return;
  }

  // Evia iMessage onboarding — caregiver membership payment complete
  if (session.metadata?.task === 'caregiver_membership' && session.metadata?.phone) {
    try {
      const phone = session.metadata.phone;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription as any)?.id ?? '';
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : (session.customer as any)?.id ?? '';
      const update: Record<string, unknown> = {};
      // If MVR was included in the checkout, flag the session so Checkr uses the MVR package
      if (session.metadata?.includeMVR === 'true') update.mvrPaid = true;
      if (subscriptionId) update.caregiverSubscriptionId = subscriptionId;
      // Stamped so advanceOnboardingStep can mirror it to customers/{uid} —
      // the caregiver billing portal (createCaregiverBillingPortalSession)
      // resolves the Stripe customer from that doc.
      if (customerId) update.stripeCustomerId = customerId;
      if (Object.keys(update).length) {
        await admin.firestore().collection('agent_sessions').doc(phone).update(update).catch(() => {});
      }
      if (!subscriptionId) {
        console.error(`caregiver_membership completed without subscription id for phone=${phone}; membership remains inactive`);
        await admin.firestore().collection('admin_alerts').add({
          type: 'caregiver_membership_missing_subscription',
          phone,
          stripeCheckoutSessionId: session.id,
          stripeCustomerId: customerId || null,
          severity: 'high',
          resolved: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }
      const { advanceOnboardingStep } = await import('./agents/onboardingConversation');
      await advanceOnboardingStep(phone, 'membership', '');
    } catch (err) {
      console.error('advanceOnboardingStep(membership) error:', err);
    }
    return;
  }

  // Evia SMS — standalone "add MVR later" one-time payment complete. Resolve the
  // caregiver behind this phone and kick off an MVR-only check (idempotent).
  if (session.metadata?.task === 'mvr_payment' && session.metadata?.phone) {
    const phone = session.metadata.phone;
    try {
      const sessionSnap = await admin.firestore().collection('agent_sessions').doc(phone).get();
      const caregiverUid = sessionSnap.data()?.caregiverId as string | undefined;
      if (!caregiverUid) {
        console.error(`mvr_payment: no caregiverId on agent_sessions/${phone}`);
        await admin.firestore().collection('admin_alerts').add({
          type: 'mvr_init_failed', phone, errorMessage: 'no caregiverId on session',
          createdAt: new Date().toISOString(), resolved: false, severity: 'high',
        }).catch(() => {});
        return;
      }
      const { initiateMvrOnlyCheck } = await import('./checkr');
      await initiateMvrOnlyCheck(caregiverUid);
      const { advanceOnboardingStep } = await import('./agents/onboardingConversation');
      await advanceOnboardingStep(phone, 'mvr_payment', '');
    } catch (err) {
      console.error(`mvr_payment: failed to initiate MVR check for ${phone}:`, err);
      await admin.firestore().collection('admin_alerts').add({
        type: 'mvr_init_failed', phone, errorMessage: err instanceof Error ? err.message : String(err),
        createdAt: new Date().toISOString(), resolved: false, severity: 'high',
      }).catch(() => {});
    }
    return;
  }

  // One-time MVR ("Approved Driver") add-on purchased after signup (web self-serve).
  // On payment, kick off a standalone MVR-only Checkr check. initiateMvrOnlyCheck is
  // idempotent (mvrCheckInitiated precondition), so a redelivered webhook is safe.
  if (session.metadata?.task === 'mvr_addon') {
    const caregiverUid = session.metadata?.firebaseUID;
    if (!caregiverUid) {
      console.error('mvr_addon checkout completed without firebaseUID');
      return;
    }
    try {
      const { initiateMvrOnlyCheck } = await import('./checkr');
      await initiateMvrOnlyCheck(caregiverUid);
    } catch (err) {
      // assertMvrCheckConfig and Checkr errors surface here. Don't storm Stripe
      // retries on a persistent config error — record the paid-but-uninitiated
      // state for an admin and ack the webhook.
      console.error(`mvr_addon: failed to initiate MVR check for ${caregiverUid}:`, err);
      await admin.firestore().collection('admin_alerts').add({
        type:         'mvr_init_failed',
        caregiverId:  caregiverUid,
        errorMessage: err instanceof Error ? err.message : String(err),
        createdAt:    new Date().toISOString(),
        resolved:     false,
        severity:     'high',
      }).catch(() => {});
    }
    return;
  }

  const userId = session.metadata?.firebaseUID;
  if (!userId) return;

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription as any)?.id ?? '';
  if (!subscriptionId) {
    console.error(`Membership checkout ${session.id} completed without subscription id for user=${userId}; membership remains inactive`);
    await admin.firestore().collection('admin_alerts').add({
      type: 'membership_missing_subscription',
      userId,
      stripeCheckoutSessionId: session.id,
      severity: 'high',
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return;
  }

  await admin.firestore().collection('users').doc(userId).set({
    membershipStatus: 'active',
    subscriptionActive: true,
    subscriptionId,
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
  let email: string | undefined;
  try {
    const authUser = await admin.auth().getUser(userId);
    email = authUser.email;
  } catch (e) {
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

  const includeMVRFlag = session.metadata?.includeMVR === 'true';

  if (!firstName || !lastName || !zipCode) {
    console.warn(`Caregiver ${userId} missing profile fields — marking paid, deferring Checkr`);
    await admin.firestore().collection('caregivers').doc(userId).set({
      membershipPaid: true,
      checkrInitPending: true,
      ...(includeMVRFlag && { mvrPaid: true }),
    }, { merge: true });
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
    const CHECKR_PKG_BASE = process.env.CHECKR_PACKAGE || 'checkrdirect_essential_criminal';
    let CHECKR_PKG = CHECKR_PKG_BASE;
    if (includeMVRFlag) {
      try {
        // Validate the bundled MVR package is set and distinct from base.
        CHECKR_PKG = assertMvrCheckConfig('bundled');
      } catch (cfgErr) {
        // Paid for MVR but the bundled package is misconfigured. Run the base
        // criminal check (so the caregiver isn't blocked) and alert an admin to
        // resolve the MVR portion — never silently run a non-MVR check as MVR.
        console.error(`Bundled MVR package misconfigured for ${userId}:`, cfgErr);
        await admin.firestore().collection('admin_alerts').add({
          type:         'mvr_bundle_misconfigured',
          caregiverId:  userId,
          errorMessage: cfgErr instanceof Error ? cfgErr.message : String(cfgErr),
          createdAt:    new Date().toISOString(),
          resolved:     false,
          severity:     'high',
        }).catch(() => {});
      }
    }
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    const dateKey = new Date().toISOString().slice(0, 10);
    const workLocations = state ? [{ country: 'US', state: state.toUpperCase() }] : [];

    const candidateBody: Record<string, unknown> = {
      first_name: firstName, last_name: lastName, email,
      zipcode: zipCode, custom_id: userId,
    };
    if (workLocations.length) candidateBody.work_locations = workLocations;

    const candidateRes = await fetchWithTimeout(`${CHECKR_BASE}/candidates`, {
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
    const candidateId: string = candidate.id;

    const invBody: Record<string, unknown> = { candidate_id: candidateId, package: CHECKR_PKG };
    if (workLocations.length) invBody.work_locations = workLocations;

    const invRes = await fetchWithTimeout(`${CHECKR_BASE}/invitations`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': `${userId}-invitation-${dateKey}` },
      body: JSON.stringify(invBody),
    });

    const invOk = invRes.ok;
    let invitationUrl: string | undefined;
    if (!invOk) {
      const errText = await invRes.text().catch(() => '');
      console.error(`Checkr invitation failed for ${userId}: ${invRes.status} ${errText}`);
    } else {
      const inv = await invRes.json().catch(() => null);
      if (typeof inv?.invitation_url === 'string') invitationUrl = inv.invitation_url;
    }

    // Identity PII → owner/admin-only private subcollection, not the parent.
    await writeCaregiverBackgroundPII(userId, { legalFirstName: firstName, legalLastName: lastName, zip: zipCode });
    await admin.firestore().collection('caregivers').doc(userId).set({
      membershipPaid: true,
      ...(includeMVRFlag && { mvrPaid: true }),
      verificationStatus: 'submitted',
      backgroundCheckData: {
        checkrCandidateId: candidateId,
        submittedAt: new Date().toISOString(),
        status: 'pending',
        invitationStatus: invOk ? 'sent' : 'error',
        ...(invitationUrl && { invitationUrl }),
        initiatedVia: 'stripe_webhook',
        ...(includeMVRFlag && { mvrIncluded: true }),
      },
    }, { merge: true });

    // Text the caregiver their background-check link. Checkr also emails it, but
    // an SMS-first caregiver may never see that email — the link must reach them
    // where the rest of onboarding happens.
    const caregiverPhone = (caregiverData.phone || '').trim();
    if (invitationUrl && caregiverPhone) {
      try {
        await admin.firestore().collection('agent_sessions').doc(caregiverPhone).update({
          bgcheckInviteUrl: invitationUrl,
          // Stamp the mint time so Evia's reuse guard can tell a live invite from
          // a stale one (Checkr's 7-day expiry) — an unstamped cache would fall to
          // the submittedAt fallback and, once that ages out, force-re-mint.
          bgcheckInviteSentAt: new Date().toISOString(),
        }).catch(() => {});
        const { sendViaInteractionAgent } = await import('./agents/caraAgent');
        await sendViaInteractionAgent(caregiverPhone, {
          content:
            'Payment received! Next step: your background check — it usually takes about 5 minutes. ' +
            `Tap to get started: ${invitationUrl}`,
          urgency:     'immediate',
          sourceAgent: 'checkr_status',
          canDrop:     false,
        });
      } catch (err) {
        console.error(`Failed to text bg-check link to caregiver ${userId}:`, err);
      }
    }

    await admin.firestore().collection('users').doc(userId).set({
      verificationStatus: 'submitted',
    }, { merge: true });

    console.log(`Checkr initiated for caregiver: ${userId}, candidate: ${candidateId}`);
  } catch (err: any) {
    console.error(`Checkr auto-initiation error for ${userId}:`, err?.message);
    await admin.firestore().collection('caregivers').doc(userId).set({ membershipPaid: true }, { merge: true });
  }
}

/**
 * Resolve the Firebase uid behind a subscription. Web-created subscriptions
 * carry firebaseUID metadata; Evia SMS checkouts only carry `phone`
 * (subscription_data.metadata, onboardingConversation.ts) — resolve those via
 * the agent session / Auth / the recorded subscription id so renewal,
 * payment-failure, and cancellation webhooks aren't blind to SMS members.
 */
async function resolveSubscriptionUserId(subscription: Stripe.Subscription): Promise<string | null> {
  const direct = subscription.metadata?.firebaseUID;
  if (direct) return direct;

  const phone = subscription.metadata?.phone;
  if (phone) {
    try {
      const sess = await admin.firestore().collection('agent_sessions').doc(phone).get();
      const viaSession = (sess.data()?.userId ?? sess.data()?.caregiverId) as string | undefined;
      if (viaSession) return viaSession;
    } catch { /* fall through */ }
    try {
      return (await admin.auth().getUserByPhoneNumber(phone)).uid;
    } catch { /* fall through */ }
  }

  // Last resort: the onboarding mirrors recorded the subscription id on the docs.
  try {
    const cg = await admin.firestore().collection('caregivers')
      .where('membershipSubscriptionId', '==', subscription.id).limit(1).get();
    if (!cg.empty) return cg.docs[0].id;
    const us = await admin.firestore().collection('users')
      .where('subscriptionId', '==', subscription.id).limit(1).get();
    if (!us.empty) return us.docs[0].id;
  } catch { /* fall through */ }

  return null;
}

/**
 * Mirror a membership status change onto caregivers/{uid} — the caregiver
 * webapp (CaregiverProgressCard, useCaregiverGate) reads membershipStatus /
 * membershipPaid from the CAREGIVERS doc, not users. No-op for clients.
 */
async function mirrorMembershipToCaregiverDoc(userId: string, membershipStatus: string): Promise<boolean> {
  try {
    const ref = admin.firestore().collection('caregivers').doc(userId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.set({
      membershipStatus,
      ...(membershipStatus === 'active' || membershipStatus === 'trialing' ? { membershipPaid: true } : {}),
    }, { merge: true });
    return true;
  } catch (err) {
    console.error(`mirrorMembershipToCaregiverDoc failed for ${userId}:`, err);
    return false;
  }
}

/**
 * Handle invoice.payment_succeeded
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
  const userId = await resolveSubscriptionUserId(subscription);

  if (!userId) return;

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
  await mirrorMembershipToCaregiverDoc(userId, 'active');

  // Notify caregiver of successful payment
  const amountPaid = (invoice.amount_paid / 100).toFixed(2);
  const isRenewal = invoice.billing_reason === 'subscription_cycle';
  await admin.firestore().collection('users').doc(userId).collection('notifications').add({
    userId,
    type: 'membership_payment_succeeded',
    title: isRenewal ? 'Membership Renewed' : 'Membership Activated',
    body: isRenewal
      ? `Your Evia membership has been renewed. $${amountPaid} was charged.`
      : `Your Evia membership is now active. $${amountPaid} was charged.`,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Only re-initiate Checkr on annual renewal, not on first subscription payment
  if (invoice.billing_reason !== 'subscription_cycle') {
    console.log(`Invoice succeeded for ${userId} — billing_reason: ${invoice.billing_reason}, skipping Checkr re-initiation`);
    return;
  }

  // …and only for an ANNUAL plan. `subscription_cycle` fires on EVERY renewal
  // regardless of interval, so a monthly caregiver plan (legacy $24.95 /
  // STRIPE_CAREGIVER_MONTHLY, still allowed) would buy a Checkr check every
  // month AND strip `verified` 12x/yr. The background check is annual; gate on
  // the price interval, not the price ID (robust to price-ID drift).
  const renewalInterval = subscription.items?.data?.[0]?.price?.recurring?.interval;
  if (renewalInterval !== 'year') {
    console.log(`Renewal for ${userId} is interval='${renewalInterval}', not annual — skipping Checkr re-initiation`);
    return;
  }

  const caregiverSnap = await admin.firestore().collection('caregivers').doc(userId).get();
  if (!caregiverSnap.exists) return;

  const caregiverData = caregiverSnap.data() || {};
  const bgData = caregiverData.backgroundCheckData || {};
  const existingCandidateId = bgData.checkrCandidateId;

  if (!existingCandidateId) {
    console.log(`Renewal for caregiver ${userId} but no checkrCandidateId — skipping Checkr`);
    return;
  }

  const renewalPhone = ((caregiverData.phone as string | undefined) || '').trim();
  async function notifyRenewalLinkFailure(reason: string) {
    await admin.firestore().collection('admin_alerts').add({
      type:        'onboarding_link_generation_failed',
      severity:    'high',
      step:        'stripe_subscription_renewal_bgcheck',
      caregiverId: userId,
      phone:       renewalPhone,
      error:       reason,
      createdAt:   new Date().toISOString(),
      resolved:    false,
    }).catch((alertErr: unknown) => console.error(`Failed to write Checkr renewal alert for ${userId}:`, alertErr));
    if (renewalPhone) {
      try {
        const { sendViaInteractionAgent } = await import('./agents/caraAgent');
        await sendViaInteractionAgent(renewalPhone, {
          content: 'Your annual background check needs a quick renewal. I hit a snag pulling up the link, and I will text it as soon as it is ready.',
          urgency:     'immediate',
          sourceAgent: 'checkr_status',
          canDrop:     false,
        });
      } catch (sendErr) {
        console.error(`Failed to text Checkr renewal failure to caregiver ${userId}:`, sendErr);
      }
    }
  }

  // Renewal: reset verification and re-run Checkr for the existing candidate
  console.log(`Annual renewal for caregiver ${userId} — re-initiating Checkr`);

  const apiKey = (process.env.CHECKR_KEY || process.env.CHECKR_API_KEY || '').trim();
  if (!apiKey) {
    console.error('CHECKR_KEY not configured - skipping Checkr renewal');
    await notifyRenewalLinkFailure('CHECKR_KEY not configured');
    return;
  }

  try {
    const CHECKR_BASE = process.env.CHECKR_API_URL || 'https://api.checkr.com/v1';
    const CHECKR_PKG = process.env.CHECKR_PACKAGE || 'checkrdirect_essential_criminal';
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    const dateKey = new Date().toISOString().slice(0, 10);

    const invRes = await fetch(`${CHECKR_BASE}/invitations`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'Idempotency-Key': `${userId}-renewal-${dateKey}` },
      body: JSON.stringify({ candidate_id: existingCandidateId, package: CHECKR_PKG }),
    });

    const invOk = invRes.ok;
    if (!invOk) {
      // The invitation failed, so DON'T reset the caregiver's verification state —
      // doing so would strip their verified status while leaving no valid pending
      // background check, stranding them in an un-verifiable limbo. Leave the
      // existing state intact and surface the failure for retry.
      const errText = await invRes.text().catch(() => '');
      console.error(`Checkr renewal invitation failed for ${userId}: ${invRes.status} ${errText} — leaving verification state unchanged`);
      await notifyRenewalLinkFailure(`${invRes.status} ${errText}`.trim());
      return;
    }

    const inv = await invRes.json().catch(() => null);
    const renewalUrl: string | undefined =
      typeof inv?.invitation_url === 'string' ? inv.invitation_url : undefined;

    await admin.firestore().collection('caregivers').doc(userId).set({
      verified: false,
      verificationStatus: 'submitted',
      backgroundCheckStatus: 'pending',
      backgroundCheckComplete: false,
      backgroundCheckData: {
        ...bgData,
        submittedAt: new Date().toISOString(),
        status: 'pending',
        invitationStatus: 'sent',
        ...(renewalUrl ? { invitationUrl: renewalUrl } : { invitationUrl: null }),
        initiatedVia: 'annual_renewal',
        checkrClearedAt: null,
      },
    }, { merge: true });

    // Text the renewal link — same rationale as the first-payment path: the
    // Checkr email alone is easy to miss, and the caregiver stays unbookable
    // until the renewed check clears.
    if (renewalUrl && renewalPhone) {
      try {
        await admin.firestore().collection('agent_sessions').doc(renewalPhone).update({
          bgcheckInviteUrl: renewalUrl,
          // Stamp the mint time (see the first-payment path) so Evia's reuse guard
          // treats this renewal invite as live until it actually nears expiry.
          bgcheckInviteSentAt: new Date().toISOString(),
        }).catch(() => {});
        const { sendViaInteractionAgent } = await import('./agents/caraAgent');
        await sendViaInteractionAgent(renewalPhone, {
          content:
            'Your annual membership renewed — time for your yearly background check refresh. ' +
            `It usually takes about 5 minutes: ${renewalUrl}`,
          urgency:     'immediate',
          sourceAgent: 'checkr_status',
          canDrop:     false,
        });
      } catch (err) {
        console.error(`Failed to text renewal bg-check link to caregiver ${userId}:`, err);
      }
    }

    console.log(`Checkr renewal initiated for caregiver: ${userId}`);
  } catch (err: any) {
    console.error(`Checkr renewal error for ${userId}:`, err?.message);
    await notifyRenewalLinkFailure(err?.message ?? String(err));
  }
}

/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
  const userId = await resolveSubscriptionUserId(subscription);

  if (!userId) return;

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
  const attemptCount = invoice.attempt_count ?? 1;
  const isFinalAttempt = invoice.next_payment_attempt == null;
  const nextRetryDate = invoice.next_payment_attempt
    ? new Date(invoice.next_payment_attempt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  // Update user status. set/merge, not update — an SMS-onboarded member's
  // users doc may not exist yet, and update() would 500 the whole webhook.
  await admin.firestore().collection('users').doc(userId).set({
    membershipStatus:    'payment_failed',
    subscriptionStatus:  'past_due',
    paymentFailureCount: attemptCount,
    lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  // Caregiver webapp reads the caregivers doc — surfaces the "Payment failed"
  // card with the update-payment CTA. Returns false for clients (no doc).
  const isCaregiverMember = await mirrorMembershipToCaregiverDoc(userId, 'payment_failed');

  // Escalating dunning communication — tone sharpens with each failed attempt,
  // and the final attempt warns that access is about to end.
  const billingUrl = appLink(isCaregiverMember ? "/caregiver/membership" : "/client/membership");
  let dunningMsg: string;
  if (isFinalAttempt) {
    dunningMsg =
      "We weren't able to process your Evia membership payment after several tries, " +
      `so your membership is now at risk of being canceled. To keep your access, please update your ` +
      `payment method at ${billingUrl} today. Reply HELP if you need a hand.`;
  } else if (attemptCount <= 1) {
    dunningMsg =
      "Heads up — we couldn't process your Evia membership payment. " +
      `No action needed if your card just needs a moment, but you can update billing anytime at ${billingUrl}.` +
      (nextRetryDate ? ` We'll retry on ${nextRetryDate}.` : "");
  } else {
    dunningMsg =
      "We still haven't been able to process your Evia membership payment. " +
      `Please update your payment method at ${billingUrl} to avoid an interruption.` +
      (nextRetryDate ? ` Next retry: ${nextRetryDate}.` : "") +
      " Reply HELP if you need assistance.";
  }

  // Proactively text the client via Evia
  try {
    const sessionSnap = await admin.firestore()
      .collection("agent_sessions")
      .where("userId", "==", userId)
      .where("optedOut", "==", false)
      .limit(1)
      .get();
    if (!sessionSnap.empty) {
      const clientPhone = sessionSnap.docs[0].id;
      const { sendViaInteractionAgent } = await import("./agents/caraAgent");
      await sendViaInteractionAgent(clientPhone, {
        content:     dunningMsg,
        urgency:     "immediate",
        sourceAgent: "billing",
        canDrop:     false,
        // Billing/legal notice — force SMS for reliable delivery, never iMessage.
        preferredService: "SMS",
      });
    }
  } catch (err) {
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
  } catch (err) {
    console.error(`handleInvoicePaymentFailed: failed to write in-app notification for ${userId}:`, err);
  }

  console.log(`Payment failed for user: ${userId} (attempt ${attemptCount}, final: ${isFinalAttempt})`);
}

/**
 * Handle customer.subscription.created
 */
async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  const userId = await resolveSubscriptionUserId(subscription);
  if (!userId) return;

  // Save subscription to Firestore
  await admin.firestore()
    .collection('customers')
    .doc(userId)
    .collection('subscriptions')
    .doc(subscription.id)
    .set({
      id: subscription.id,
      status: subscription.status,
      price_id: subscription.items.data[0]?.price.id,
      current_period_start: new Date(subscription.current_period_start * 1000),
      current_period_end: new Date(subscription.current_period_end * 1000),
      created: new Date(subscription.created * 1000),
      cancel_at_period_end: subscription.cancel_at_period_end,
      metadata: subscription.metadata,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  // Update user document. set/merge — the SMS path's users doc may not exist
  // yet when this event races checkout.session.completed.
  await admin.firestore().collection('users').doc(userId).set({
    membershipStatus: subscription.status,
    subscriptionId: subscription.id,
    // Derive from status, NOT hardcoded true: a subscription created
    // 'incomplete'/'past_due' (3DS-pending or API-created before first
    // payment) is NOT paid. A hardcoded true here marks such users paid and
    // trips downstream gates that publish their job / blast caregivers before
    // payment (the exact case aiMatchTriggers gates on subscriptionActive).
    // Self-heals on the next subscription.updated, but must not open the gate
    // in the interim. Matches handleSubscriptionUpdated below.
    subscriptionActive: subscription.status === 'active' || subscription.status === 'trialing',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log(`Subscription created for user: ${userId}`);
}

/**
 * Handle customer.subscription.updated
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const userId = await resolveSubscriptionUserId(subscription);
  if (!userId) return;

  // Update subscription in Firestore. set/merge — SMS-created subscriptions
  // have no customers/{uid}/subscriptions doc (that's written by the web
  // flow's created-handler), and update() on a missing doc throws.
  await admin.firestore()
    .collection('customers')
    .doc(userId)
    .collection('subscriptions')
    .doc(subscription.id)
    .set({
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000),
      current_period_end: new Date(subscription.current_period_end * 1000),
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

  // Update user document
  const userRef = admin.firestore().collection('users').doc(userId);
  await userRef.set({
    membershipStatus: subscription.status,
    subscriptionActive: subscription.status === 'active' || subscription.status === 'trialing',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await mirrorMembershipToCaregiverDoc(userId, subscription.status);

  // Repair a stuck Evia SMS session (2026-09-03): agent_sessions.onboardingStep
  // only advances to "complete" via advanceOnboardingStep('payment', ...),
  // which fires from checkout.session.completed ONLY when the checkout was
  // itself created by Evia's own SMS flow (session.metadata.task ===
  // 'client_payment_setup'). A client who finishes membership through the
  // WEBSITE's own checkout instead never gets that call — this webhook
  // (customer.subscription.updated) fires either way, so it's the one place
  // both channels are guaranteed to meet. Left unrepaired, the session stays
  // parked on an early client_* step forever, and any later text the family
  // sends keeps re-firing that step's scripted handler against stale
  // onboarding-time data (see handleClientShowCaregivers's live-location fix,
  // same session). Only flips the routing flag — never re-runs
  // advanceOnboardingStep's own side effects (those already happened for
  // real, through whichever channel the family actually used), and only once
  // identity is ALSO genuinely verified, so a client who did membership first
  // and still owes an identity check is correctly left mid-pipeline.
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    try {
      const userSnap = await userRef.get();
      const identityVerified = userSnap.data()?.identityCheckStatus === 'verified';
      if (identityVerified) {
        const stuckSessionSnap = await admin.firestore()
          .collection('agent_sessions')
          .where('userId', '==', userId)
          .limit(1)
          .get();
        if (!stuckSessionSnap.empty) {
          const stuckDoc = stuckSessionSnap.docs[0];
          const step = stuckDoc.data().onboardingStep as string | undefined;
          const prePaymentClientSteps = [
            'client_confirm_intake', 'client_ask_plan', 'client_payment', 'client_identity',
          ];
          if (step && prePaymentClientSteps.includes(step)) {
            await stuckDoc.ref.update({ onboardingStep: 'complete' });
            console.log(`handleSubscriptionUpdated: resynced stuck onboardingStep (${step} -> complete) for user ${userId}`);
          }
        }
      }
    } catch (err) {
      console.error(`handleSubscriptionUpdated: onboardingStep resync failed for ${userId}:`, err);
    }
  }

  console.log(`Subscription updated for user: ${userId}`);
}

/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const userId = await resolveSubscriptionUserId(subscription);
  if (!userId) return;

  // Update subscription in Firestore. set/merge — see handleSubscriptionUpdated.
  await admin.firestore()
    .collection('customers')
    .doc(userId)
    .collection('subscriptions')
    .doc(subscription.id)
    .set({
      status: 'canceled',
      canceled_at: new Date(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

  // Update user document
  await admin.firestore().collection('users').doc(userId).set({
    membershipStatus: 'canceled',
    subscriptionActive: false,
    subscriptionId: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  // Caregiver webapp reads the caregivers doc — surfaces the "Membership
  // canceled" card with the reactivate CTA. Returns false for clients (no doc).
  const isCaregiverMember = await mirrorMembershipToCaregiverDoc(userId, 'canceled');

  // Proactively text via Evia — this used to be silent (in-app notice only),
  // so a client/caregiver whose membership fully lapsed had no way to find
  // out unless they happened to open the website. Mirrors the same dunning
  // pattern handleInvoicePaymentFailed already uses.
  try {
    const sessionSnap = await admin.firestore()
      .collection("agent_sessions")
      .where("userId", "==", userId)
      .where("optedOut", "==", false)
      .limit(1)
      .get();
    if (!sessionSnap.empty) {
      const phone = sessionSnap.docs[0].id;
      const billingUrl = appLink(isCaregiverMember ? "/caregiver/membership" : "/client/membership");
      const { sendViaInteractionAgent } = await import("./agents/caraAgent");
      await sendViaInteractionAgent(phone, {
        content:
          "Your Evia membership has been cancelled. " +
          `You can reactivate anytime at ${billingUrl} — reply HELP if you need a hand.`,
        urgency:     "immediate",
        sourceAgent: "billing",
        canDrop:     false,
        // Billing/legal notice — force SMS for reliable delivery, never iMessage.
        preferredService: "SMS",
      });
    }
  } catch (err) {
    console.error(`handleSubscriptionDeleted: failed to notify ${userId}:`, err);
  }

  await admin.firestore().collection('users').doc(userId).collection('notifications').add({
    userId,
    type: 'membership_cancelled',
    title: 'Membership Cancelled',
    body: 'Your Evia membership has been cancelled.',
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Subscription canceled for user: ${userId}`);
}

/**
 * Get user's subscription details
 */
export const getSubscriptionDetails = functions.https.onCall(async (data, context) => {
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
        currentPeriodEnd: subscription.current_period_end?.toDate(),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        priceId: subscription.price_id,
      },
    };
  } catch (error) {
    console.error('Error getting subscription details:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get subscription details');
  }
});

/**
 * Live check of whether the client actually has a usable payment method on
 * file — NOT the same as customers/{uid}.stripeCustomerId existing, which
 * gets written the moment checkout STARTS, before any card is entered. A
 * client who abandons checkout before submitting a card, or whose card was
 * later removed via the Billing Portal, would still have a stripeCustomerId
 * in Firestore with no actual charge-able card. This asks Stripe directly,
 * live, every call — no webhook/trigger needed, this is purely a read for
 * whoever is looking at the Payments page right now (Hamse, 2026-08-23).
 */
export const getPaymentMethodStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }
  const userId = context.auth.uid;

  try {
    const customerDoc = await admin.firestore().collection('customers').doc(userId).get();
    const customerId = customerDoc.data()?.stripeCustomerId as string | undefined;
    if (!customerId) return { hasCard: false };

    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
    if (customer.deleted) return { hasCard: false };

    let pm = customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | string | null | undefined;
    if (!pm || typeof pm === 'string') {
      // No default set on the customer — fall back to whether ANY card is
      // attached at all (e.g. attached during checkout but never explicitly
      // set as default).
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      pm = methods.data[0];
    }
    if (!pm || typeof pm === 'string') return { hasCard: false };

    return {
      hasCard: true,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
    };
  } catch (error) {
    console.error('Error getting payment method status:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get payment method status');
  }
});

/**
 * Cancel subscription
 */
// Shared core (2026-08-31, Membership page audit) — Evia's cancel_subscription
// MCP tool used to reimplement this exact Stripe call+lookup separately, which
// meant a future change here (extra validation, refund handling, etc.)
// wouldn't automatically apply to the SMS path. Both now call this one
// function. Deliberately writes NOTHING to Firestore itself — matches the
// website's own behavior exactly: the customer.subscription.updated webhook
// (handleSubscriptionUpdated) is the single source of truth for
// membershipStatus/subscriptionActive, whether the cancel came from the site
// or from Evia.
export interface CancelSubscriptionResult { alreadyCancelling?: boolean; cancelled?: boolean; periodEnd: string | null; subId?: string }
export async function cancelSubscriptionForUser(userId: string): Promise<CancelSubscriptionResult> {
  const subsSnap = await admin.firestore()
    .collection('customers').doc(userId).collection('subscriptions')
    .where('status', 'in', ['active', 'trialing']).limit(1).get();
  if (subsSnap.empty) throw new Error('No active subscription found');
  const subDoc  = subsSnap.docs[0];
  const subData = subDoc.data();
  const periodEnd = (subData.current_period_end as admin.firestore.Timestamp | undefined)?.toDate?.()?.toISOString?.() ?? null;
  if (subData.cancel_at_period_end === true) return { alreadyCancelling: true, periodEnd };
  await stripe.subscriptions.update(subDoc.id, { cancel_at_period_end: true });
  return { cancelled: true, periodEnd, subId: subDoc.id };
}

export const cancelSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  try {
    const result = await cancelSubscriptionForUser(context.auth.uid);
    return { success: true, ...result };
  } catch (error: any) {
    if (error instanceof Error && error.message === 'No active subscription found') {
      throw new functions.https.HttpsError('not-found', error.message);
    }
    console.error('Error canceling subscription:', error);
    throw new functions.https.HttpsError('internal', 'Failed to cancel subscription');
  }
});

/**
 * Create a Stripe Identity verification session and return the hosted URL.
 * Client should redirect the browser to `url`; Stripe sends the user back to
 * `returnUrl` once they finish (or abandon) the flow.
 */
export const createIdentityVerificationSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const userId = context.auth.uid;
  const { returnUrl } = data as { returnUrl?: string };

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
  } catch (error: any) {
    console.error('Error creating identity verification session:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Failed to create verification session');
  }
});

/**
 * Handle Stripe Identity webhook events — mirror session status onto the user doc
 * so the client can unblock gated actions as soon as the webhook lands.
 */
async function handleIdentityVerificationEvent(session: Stripe.Identity.VerificationSession) {
  const userId = session.metadata?.firebaseUID;
  const phone  = session.metadata?.phone;

  const statusMap: Record<string, string> = {
    verified:       'verified',
    processing:     'processing',
    requires_input: 'requires_input',
    canceled:       'canceled',
  };
  const status = statusMap[session.status] || session.status;

  // ── iMessage onboarding flow (phone metadata, no firebaseUID yet) ──────────
  if (phone) {
    const { advanceOnboardingStep } = await import('./agents/onboardingConversation');
    const { sendToPhone }           = await import('./linq/client');

    if (status === 'verified') {
      try {
        await advanceOnboardingStep(phone, 'identity', '');
      } catch (err) {
        console.error('advanceOnboardingStep(identity) error:', err);
      }
      // Clear the identity-gate-skipped flag (set when session creation once
      // failed and the flow fell back to payment) — the user is verified now.
      await admin.firestore().collection('agent_sessions').doc(phone).set({
        onboardingData: {
          needsIdentityVerification: false,
          identityVerifiedAt: new Date().toISOString(),
        },
      }, { merge: true }).catch((err: unknown) => console.error('clear needsIdentityVerification error:', err));
    } else if (status === 'requires_input' || status === 'canceled') {
      // Let the client retry — send a FRESH link (the original may have scrolled
      // off or been consumed), not just "tap the link above".
      await sendToPhone(phone,
        "Hmm, that ID check didn't go through — it happens. Here's a fresh link to try again:"
      ).catch((err: unknown) => console.error('identity retry message error:', err));
      try {
        const { sendOnboardingLink } = await import('./agents/onboardingConversation');
        await sendOnboardingLink(phone, 'client_identity');
      } catch (err) {
        console.error('identity retry link error:', err);
      }
    }
    // Don't return — also update Firestore users doc if firebaseUID is present
  }

  // ── Firebase user doc update (web-app flow or post-auth iMessage users) ─────
  if (!userId) {
    if (!phone) console.warn('Identity session missing both firebaseUID and phone metadata:', session.id);
    return;
  }

  const update: Record<string, unknown> = {
    identityCheckStatus:           status,
    stripeIdentityVerificationId:  session.id,
    updatedAt:                     admin.firestore.FieldValue.serverTimestamp(),
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
async function handleShiftPaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  const appointmentId = intent.metadata?.appointmentId
    || intent.metadata?.shiftHoursId;
  if (!appointmentId) return; // Not a shift charge — ignore.

  const ref = admin.firestore().collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const shift = snap.data()!;
  const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
  const intentGeneration = Math.max(1, Number(intent.metadata?.paymentGeneration ?? 1));
  if (intentGeneration !== generation || (shift.stripeChargeId && shift.stripeChargeId !== intent.id)) {
    console.warn(`Ignoring stale shift payment success for ${appointmentId}`, { intentId: intent.id, intentGeneration, generation });
    return;
  }

  await ref.update({
    chargeConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    stripeChargeStatus: 'succeeded',
  });

  // The charge has actually settled — complete the payout for a shift that was
  // held in 'charge_pending' because its charge settled asynchronously.
  // Idempotent: a shift already 'paid' is a no-op, and the transfer
  // idempotency key guards a duplicate webhook delivery. Dynamic import avoids
  // a module-load cycle between stripe.ts and shiftHours.ts.
  try {
    const { completeShiftPaymentAfterCharge } = await import('./shiftHours');
    await completeShiftPaymentAfterCharge(appointmentId, intent.id, intentGeneration);
  } catch (err) {
    console.error(`completeShiftPaymentAfterCharge failed for ${appointmentId}:`, err);
  }
}

async function handleShiftPaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const appointmentId = intent.metadata?.appointmentId
    || intent.metadata?.shiftHoursId;
  if (!appointmentId) return;

  const ref = admin.firestore().collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const shift = snap.data()!;
  const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
  const intentGeneration = Math.max(1, Number(intent.metadata?.paymentGeneration ?? 1));
  if (intentGeneration !== generation || (shift.stripeChargeId && shift.stripeChargeId !== intent.id)) {
    console.warn(`Ignoring stale shift payment failure for ${appointmentId}`, { intentId: intent.id, intentGeneration, generation });
    return;
  }

  const reason = intent.last_payment_error?.message || 'payment_intent.payment_failed';
  let transferReversed = false;
  let transferReversalFailed = false;

  // If a payout already went out (charge had settled, transfer was created) and
  // the charge LATER failed, the caregiver was paid from money we never
  // collected. Reverse the transfer; if reversal fails, escalate to admins —
  // never leave an un-reversed payout silently.
  if (shift.stripeTransferId) {
    try {
      const { reverseShiftTransfer } = await import('./shiftHours');
      await reverseShiftTransfer(appointmentId, shift);
      await ref.update({
        reversedStripeTransferId: shift.stripeTransferId,
        stripeTransferReversedAt: new Date().toISOString(),
        stripeTransferId: admin.firestore.FieldValue.delete(),
        stripeChargeId: admin.firestore.FieldValue.delete(),
        paymentGeneration: generation + 1,
        paymentAttemptCount: 0,
        nextPaymentAttemptAt: new Date().toISOString(),
        paymentHistory: admin.firestore.FieldValue.arrayUnion({
          generation,
          paymentIntentId: intent.id,
          transferId: shift.stripeTransferId,
          outcome: 'reversed_after_charge_failure',
          at: new Date().toISOString(),
        }),
      });
      transferReversed = true;
    } catch (err) {
      transferReversalFailed = true;
      console.error(`reverseShiftTransfer failed for ${appointmentId}:`, err);
      await admin.firestore().collection('admin_alerts').add({
        type: 'transfer_reversal_failed',
        appointmentId,
        caregiverId: shift.caregiverId ?? null,
        stripeTransferId: shift.stripeTransferId,
        errorMessage: err instanceof Error ? err.message : String(err),
        createdAt: new Date().toISOString(),
        resolved: false,
        severity: 'high',
      });
    }
  }

  const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await ref.update({
    status: transferReversalFailed ? 'requires_admin_review' : 'payment_failed',
    stripeFailureReason: reason,
    stripeChargeStatus: 'failed',
    nextPaymentAttemptAt: transferReversalFailed ? null : retryAt,
    autoApproveAt: transferReversalFailed ? null : shift.autoApproveAt ?? null,
    updatedAt: new Date().toISOString(),
  });

  const { shiftPaymentOperationKey, updateShiftPaymentOperation } = await import('./billing/paymentOperation');
  const operationKey = shiftPaymentOperationKey(appointmentId, generation);
  if (transferReversalFailed) {
    await updateShiftPaymentOperation(operationKey, 'requires_admin_review', {
      providerOperationId: intent.id,
      nextAttemptAt: null,
      lastErrorCode: 'transfer_reversal_failed',
    });
  } else if (transferReversed) {
    await updateShiftPaymentOperation(operationKey, 'completed', {
      providerOperationId: intent.id,
      outcome: 'reversed_after_charge_failure',
    });
  } else {
    await updateShiftPaymentOperation(operationKey, 'retry', {
      providerOperationId: intent.id,
      nextAttemptAt: retryAt,
      lastErrorCode: 'payment_intent_failed',
    });
  }
}

/**
 * Reactivate subscription
 */
// Shared core, same reasoning as cancelSubscriptionForUser above. Note the
// query is by `cancel_at_period_end==true` alone (no status filter) — this is
// the site's own original query; Evia's tool used to query by
// status in [active,trialing] first instead, a subtly different lookup now
// unified onto this one.
export interface ReactivateSubscriptionResult { reactivated: boolean; periodEnd: string | null }
export async function reactivateSubscriptionForUser(userId: string): Promise<ReactivateSubscriptionResult> {
  const subsSnap = await admin.firestore()
    .collection('customers').doc(userId).collection('subscriptions')
    .where('cancel_at_period_end', '==', true).limit(1).get();
  if (subsSnap.empty) throw new Error('No canceled subscription found');
  const subDoc  = subsSnap.docs[0];
  const subData = subDoc.data();
  await stripe.subscriptions.update(subDoc.id, { cancel_at_period_end: false });
  const periodEnd = (subData.current_period_end as admin.firestore.Timestamp | undefined)?.toDate?.()?.toISOString?.() ?? null;
  return { reactivated: true, periodEnd };
}

export const reactivateSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  try {
    const result = await reactivateSubscriptionForUser(context.auth.uid);
    return { success: true, ...result };
  } catch (error: any) {
    if (error instanceof Error && error.message === 'No canceled subscription found') {
      throw new functions.https.HttpsError('not-found', error.message);
    }
    console.error('Error reactivating subscription:', error);
    throw new functions.https.HttpsError('internal', 'Failed to reactivate subscription');
  }
});

/**
 * Create a Stripe Billing Portal session for a caregiver to manage their
 * membership subscription (update card, view invoices, cancel).
 */
export const createCaregiverBillingPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }

  const userId = context.auth.uid;
  const returnUrl = (data as any)?.returnUrl || appLink('/caregiver/payments');

  try {
    const customerDoc = await admin.firestore().collection('customers').doc(userId).get();
    const customerId = customerDoc.data()?.stripeCustomerId as string | undefined;

    if (!customerId) {
      throw new functions.https.HttpsError('not-found', 'No billing account found. Please purchase a membership first.');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  } catch (error: any) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error creating billing portal session:', error);
    throw new functions.https.HttpsError('internal', 'Failed to open billing portal');
  }
});

// ── Auto-retry booking tasks when client adds a payment method ────────────────

async function handlePaymentMethodAttached(pm: Stripe.PaymentMethod): Promise<void> {
  const customerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (!customerId) return;

  const db = admin.firestore();

  // Make the attached card the customer's default invoice payment method when
  // none is set yet. This is the linchpin of off-session shift charging:
  // processShiftPayment (shiftHours.ts) reads
  // customer.invoice_settings.default_payment_method, but neither subscription-
  // mode nor setup-mode Checkout sets that field automatically — subscription
  // mode only sets subscription.default_payment_method, and setup mode sets
  // nothing customer-level. Without this, a client who successfully added a card
  // would still hit "Client has no default payment method" and every shift would
  // fail to charge. Runs for ALL attaches (before the booking-task early-return)
  // and is idempotent — we never overwrite an existing default.
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (
      !customer.deleted &&
      !customer.invoice_settings?.default_payment_method &&
      !customer.default_source
    ) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pm.id },
      });
      console.log(`[handlePaymentMethodAttached] set default payment method ${pm.id} for customer ${customerId}`);
    }
  } catch (err) {
    console.error(`[handlePaymentMethodAttached] failed to set default payment method for ${customerId}:`, err);
  }

  // Find booking tasks awaiting payment setup for this customer
  const taskSnap = await db.collection("agent_tasks")
    .where("stripeCustomerId", "==", customerId)
    .where("status",           "==", "pending_payment_setup")
    .get();

  if (taskSnap.empty) return;

  for (const taskDoc of taskSnap.docs) {
    const task = taskDoc.data();
    const clientPhone: string | undefined = task.clientPhone;
    if (!clientPhone) continue;

    try {
      // The appointments were already created and the family already heard
      // "all booked" when the caregiver accepted — only the card was missing.
      // Re-running executeBookings/finalizeAcceptedBooking would DUPLICATE the
      // booking and the confirmation (executeBookings recreates appointments and
      // re-offers the shift; finalizeAcceptedBooking re-sends "all booked").
      // Also, executeBookings only proceeds on status "awaiting_approval", so the
      // old reset-to-"approved" was a silent no-op. Just finalize the task and
      // tell the family payment is active. Moving the status out of
      // pending_payment_setup also makes a webhook redelivery a no-op.
      await taskDoc.ref.update({
        status:                  "payment_complete",
        paymentSetupCompletedAt: new Date().toISOString(),
      });
      const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
      if (sessionSnap.exists) {
        const { sendMessage } = await import("./linq/client");
        await sendMessage(
          sessionSnap.data()!.chatId,
          "Your card's on file — you're all set. I'll charge automatically after each visit.",
        ).catch(() => {});
      }
      console.log(`[handlePaymentMethodAttached] finalized booking task ${taskDoc.id} for customer ${customerId}`);
    } catch (err) {
      console.error(`[handlePaymentMethodAttached] finalize failed for task ${taskDoc.id}:`, err);
    }
  }
}
