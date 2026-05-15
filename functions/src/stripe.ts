import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

// Initialize Stripe with secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

// Webhook secret for verifying Stripe events
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

// Price ID for $29.95/month membership (legacy fallback)
const MEMBERSHIP_PRICE_ID = process.env.STRIPE_MEMBERSHIP_PRICE_ID || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO';

// Allowed price IDs for all three plans + caregiver membership
const ALLOWED_PRICE_IDS = [
  process.env.STRIPE_PRICE_MONTHLY        || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO',
  process.env.STRIPE_PRICE_QUARTERLY      || '',
  process.env.STRIPE_PRICE_ANNUAL         || '',
  process.env.STRIPE_CAREGIVER_ANNUAL     || 'price_1TO8L6L7Ss5iuUb7Vrbea2tg',
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

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error handling webhook event:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * Handle checkout.session.completed
 * For caregiver payments: auto-initiate Checkr background check + set verificationStatus submitted
 */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  // Cara iMessage onboarding — advance step when client finishes payment setup
  if (session.metadata?.task === 'client_payment_setup' && session.metadata?.phone) {
    try {
      const { advanceOnboardingStep } = await import('./agents/onboardingConversation');
      await advanceOnboardingStep(session.metadata.phone, 'payment', '');
    } catch (err) {
      console.error('advanceOnboardingStep(payment) error:', err);
    }
    return;
  }

  const userId = session.metadata?.firebaseUID;
  if (!userId) return;

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
    const CHECKR_PKG_BASE = process.env.CHECKR_PACKAGE || 'driver_pro';
    const CHECKR_PKG_MVR = process.env.CHECKR_PACKAGE_MVR || CHECKR_PKG_BASE;
    const CHECKR_PKG = includeMVRFlag ? CHECKR_PKG_MVR : CHECKR_PKG_BASE;
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    const dateKey = new Date().toISOString().slice(0, 10);
    const workLocations = state ? [{ country: 'US', state: state.toUpperCase() }] : [];

    const candidateBody: Record<string, unknown> = {
      first_name: firstName, last_name: lastName, email,
      zipcode: zipCode, custom_id: userId,
    };
    if (workLocations.length) candidateBody.work_locations = workLocations;

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
    const candidateId: string = candidate.id;

    const invBody: Record<string, unknown> = { candidate_id: candidateId, package: CHECKR_PKG };
    if (workLocations.length) invBody.work_locations = workLocations;

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

    await admin.firestore().collection('caregivers').doc(userId).set({
      membershipPaid: true,
      ...(includeMVRFlag && { mvrPaid: true }),
      verificationStatus: 'submitted',
      backgroundCheckData: {
        checkrCandidateId: candidateId,
        legalFirstName: firstName,
        legalLastName: lastName,
        zip: zipCode,
        submittedAt: new Date().toISOString(),
        status: 'pending',
        invitationStatus: invOk ? 'sent' : 'error',
        initiatedVia: 'stripe_webhook',
        ...(includeMVRFlag && { mvrIncluded: true }),
      },
    }, { merge: true });

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
 * Handle invoice.payment_succeeded
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
  const userId = subscription.metadata?.firebaseUID;
  
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

  console.log(`Payment succeeded for user: ${userId}`);
}

/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId as string);
  const userId = subscription.metadata?.firebaseUID;
  
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
async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.firebaseUID;
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
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.firebaseUID;
  if (!userId) return;

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
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.firebaseUID;
  if (!userId) return;

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
 * Cancel subscription
 */
export const cancelSubscription = functions.https.onCall(async (data, context) => {
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
  } catch (error) {
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
    } else if (status === 'requires_input' || status === 'canceled') {
      // Let the client retry
      await sendToPhone(phone,
        "It looks like we need a little more info to verify you — tap the link above and try again."
      ).catch((err: unknown) => console.error('identity retry message error:', err));
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

  await ref.update({
    chargeConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    stripeChargeStatus: 'succeeded',
  });
}

async function handleShiftPaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const appointmentId = intent.metadata?.appointmentId
    || intent.metadata?.shiftHoursId;
  if (!appointmentId) return;

  const ref = admin.firestore().collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const reason = intent.last_payment_error?.message || 'payment_intent.payment_failed';
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
export const reactivateSubscription = functions.https.onCall(async (data, context) => {
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
  } catch (error) {
    console.error('Error reactivating subscription:', error);
    throw new functions.https.HttpsError('internal', 'Failed to reactivate subscription');
  }
});
