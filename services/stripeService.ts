import { loadStripe, Stripe } from '@stripe/stripe-js';
import { auth, db } from '../lib/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';

const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

if (!STRIPE_PUBLISHABLE_KEY) {
  console.warn('VITE_STRIPE_PUBLISHABLE_KEY is not configured. Stripe payments will be unavailable.');
}

let stripePromise: Promise<Stripe | null>;

export const getStripe = () => {
  if (!stripePromise) {
    stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY ?? '');
  }
  return stripePromise;
};

// Client monthly membership — $29.95/mo (live price ID)
export const MEMBERSHIP_PRICE_ID = import.meta.env.VITE_STRIPE_PRICE_ID || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO';

// Caregiver annual membership — ONE flat $69.99/yr (background check + MVR when transportation is offered)
// Display-only — the charge itself is resolved server-side (createCheckoutSession, plan 'caregiver_annual').
export const CAREGIVER_ANNUAL_PRICE = 69.99;

export interface SubscriptionStatus {
  status: 'active' | 'canceled' | 'incomplete' | 'past_due' | 'unpaid' | 'trialing' | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  priceId: string | null;
}

// Prevent concurrent checkout session creation
let isCreatingSession = false;

// Create checkout session for client monthly membership (uses default MEMBERSHIP_PRICE_ID)
export const createCheckoutSession = async (successUrl: string, cancelUrl: string): Promise<string | null> => {
  if (isCreatingSession) return null;
  isCreatingSession = true;
  try {
    if (!auth) throw new Error('Auth not initialized');
    const user = auth.currentUser;
    if (!user) throw new Error('User must be logged in');

    const functions = getFunctions();
    const createCheckoutSessionFn = httpsCallable(functions, 'v1-createCheckoutSession');
    const result = await createCheckoutSessionFn({
      priceId: MEMBERSHIP_PRICE_ID,
      successUrl,
      cancelUrl,
    });
    const { url } = (result.data as { url?: string }) ?? {};
    return url ?? null;
  } finally {
    isCreatingSession = false;
  }
};

// Create checkout session for the caregiver membership — ONE flat annual fee
// (founder, 2026-09-25) covering the background check and, for caregivers who
// offer transportation, the driving record (MVR) check. The server picks the
// price from `plan`, so no price id travels from the browser.
export const createCaregiverCheckoutSession = async (
  successUrl: string,
  cancelUrl: string,
): Promise<string | null> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');

  const functions = getFunctions();
  const createCheckoutSessionFn = httpsCallable(functions, 'v1-createCheckoutSession');
  const result = await createCheckoutSessionFn({
    plan: 'caregiver_annual',
    successUrl,
    cancelUrl,
  });
  const { url } = (result.data as { url?: string }) ?? {};
  return url ?? null;
};

// Open the Stripe Billing Portal for a caregiver to update their payment method
export const openCaregiverBillingPortal = async (returnUrl: string): Promise<void> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const functions = getFunctions();
  const fn = httpsCallable(functions, 'v1-createCaregiverBillingPortalSession');
  const result = await fn({ returnUrl });
  const { url } = result.data as { url?: string };
  if (!url) throw new Error('No billing portal URL returned');
  window.location.href = url;
};

/**
 * Start a Stripe Identity verification. Creates a verification session server-side
 * and redirects the browser to Stripe's hosted flow. Stripe will return the user
 * to `returnUrl` (which should include a `next` query param to resume the original
 * action). The user doc's `identityCheckStatus` is flipped to 'processing' server-side.
 */
export const startIdentityVerification = async (returnUrl: string): Promise<void> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const functions = getFunctions();
  const create = httpsCallable(functions, 'v1-createIdentityVerificationSession');
  const result = await create({ returnUrl });
  const { url } = result.data as { url?: string };
  if (!url) throw new Error('No verification URL returned');
  window.location.href = url;
};

// Get user's subscription status from Firestore
export const getSubscriptionStatus = async (): Promise<SubscriptionStatus> => {
  try {
    if (!auth || !db) {
      return { status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null };
    }
    const fdb = db;
    const user = auth.currentUser;
    if (!user) {
      return { status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null };
    }

    // The live (active/trialing) record first — a re-subscribed member also has an
    // old canceled record, and limit(1) alone could show its date (2026-10-03). Same
    // rule as listenToSubscriptionStatus, v1-getSubscriptionDetails and Evia's tab.
    const coll = fdb.collection('customers').doc(user.uid).collection('subscriptions');
    let doc = await coll.where('status', 'in', ['active', 'trialing']).limit(1).get();
    if (doc.empty) doc = await coll.limit(1).get();
    if (doc.empty) {
      return { status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null };
    }

    const subscription = doc.docs[0].data();
    return {
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end.seconds * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
      priceId: subscription.price_id || null
    };
  } catch (error) {
    console.error('Error getting subscription status:', error);
    return { status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null };
  }
};

// Listen to subscription changes in real-time
export const listenToSubscriptionStatus = (userId: string, callback: (status: SubscriptionStatus) => void) => {
  if (!db) return () => {};
  return db
    .collection('customers')
    .doc(userId)
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing'])
    .limit(1)
    .onSnapshot((snapshot) => {
      if (snapshot.empty) {
        callback({ status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, priceId: null });
        return;
      }

      const subscription = snapshot.docs[0].data();
      callback({
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end.seconds * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
        priceId: subscription.price_id || null
      });
    });
};

// Format price for display
export const formatPrice = (amount: number, currency: string = 'usd'): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
};

// Check if user has active membership
export const hasActiveMembership = (status: SubscriptionStatus): boolean => {
  return status.status === 'active' || status.status === 'trialing';
};

// Initiate Stripe Connect onboarding for the signed-in caregiver. Returns a
// Stripe-hosted URL to redirect the user to. If an account already exists we
// regenerate a fresh account link so returning / incomplete caregivers can
// resume onboarding.
export const initiateOnboarding = async (): Promise<{ url: string }> => {
  if (!auth) throw new Error('Firebase not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');

  // Always go through v1-createStripeConnectAccount — it reuses an existing
  // account server-side and mints a fresh link, so the client never needs to
  // read stripeAccountId (which moved off the world-readable caregiver doc to
  // caregivers/{id}/private/payout).
  const fns = getFunctions();
  const create = httpsCallable(fns, 'v1-createStripeConnectAccount');
  const res = await create({ email: user.email });
  const { onboardingUrl } = (res.data as { onboardingUrl?: string }) ?? {};
  if (!onboardingUrl) throw new Error('No onboarding URL returned');
  return { url: onboardingUrl };
};

export interface ConnectAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  stripeOnboardingComplete: boolean;
}

// Force a refresh of Stripe Connect account status on Firestore. Used on
// return from the Stripe-hosted onboarding flow as a fallback to the webhook.
// accountId is optional — omitted, the server resolves the caller's own
// account from caregivers/{uid}/private/payout.
export const checkOnboardingStatus = async (accountId?: string): Promise<ConnectAccountStatus> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const fns = getFunctions();
  const fn = httpsCallable(fns, 'v1-checkStripeAccountStatus');
  const res = await fn(accountId ? { accountId } : {});
  return res.data as ConnectAccountStatus;
};

export interface PayoutResult {
  success: boolean;
  amount: number;
  fee: number;
  payoutId: string;
  arrivalDate?: number;
  message?: string;
}

export const requestInstantPayout = async (): Promise<PayoutResult> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const fns = getFunctions();
  const fn = httpsCallable(fns, 'v1-requestInstantPayout');
  const res = await fn({});
  return res.data as PayoutResult;
};

export interface PayoutBalance {
  connected: boolean;
  instantAvailable: number;  // dollars, instantly payable right now
  pending: number;           // dollars, still settling — auto-pays out daily
  onboardingIncomplete?: boolean; // with { loginLink: true }: Stripe refused the dashboard — the account never finished onboarding (record re-synced)
  onboardingUrl?: string;         // …and here is the Setup link to finish it
  loginUrl?: string;         // with { loginLink: true }: a one-time, signed-in link to the caregiver's Stripe dashboard
}

// Standard payouts are automatic (Stripe daily schedule) — there is no
// requestStandardPayout anymore. Instant payout is the only on-demand path.
export const getPayoutBalance = async (opts: { loginLink?: boolean } = {}): Promise<PayoutBalance> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const fns = getFunctions();
  const fn = httpsCallable(fns, 'v1-getPayoutBalance');
  const res = await fn(opts.loginLink ? { loginLink: true } : {});
  return res.data as PayoutBalance;
};

/**
 * Shared helper — creates a Stripe Billing Portal session for any user.
 * Reads stripeCustomerId from customers/{uid} (same collection used by checkout).
 */
const createBillingPortalSession = async (returnPath: string): Promise<string> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const fns = getFunctions();
  const fn = httpsCallable<{ returnUrl: string }, { url: string }>(
    fns,
    'v1-createCaregiverBillingPortalSession',
  );
  const res = await fn({ returnUrl: `${window.location.origin}${returnPath}` });
  return res.data.url;
};

/** Caregiver: manage membership subscription via Stripe portal. */
export const getCaregiverBillingPortalUrl = (): Promise<string> =>
  createBillingPortalSession('/caregiver/payments');

/** Client: manage payment method / subscription via Stripe portal. */
export const getClientBillingPortalUrl = (): Promise<string> =>
  createBillingPortalSession('/client/payments');

export interface PaymentMethodStatus {
  hasCard: boolean;
  brand?: string | null;
  last4?: string | null;
}

// Live check against Stripe — NOT the same as customers/{uid}.stripeCustomerId
// existing, which is set the moment checkout starts, before any card is
// entered. See functions/src/stripe.ts's getPaymentMethodStatus for why.
export const getClientPaymentMethodStatus = async (): Promise<PaymentMethodStatus> => {
  if (!auth) throw new Error('Auth not initialized');
  const user = auth.currentUser;
  if (!user) throw new Error('User must be logged in');
  const fns = getFunctions();
  const fn = httpsCallable<Record<string, never>, PaymentMethodStatus>(fns, 'v1-getPaymentMethodStatus');
  const res = await fn({});
  return res.data;
};

// Stripe service object for backward compatibility
export const stripeService = {
  getStripe,
  createCheckoutSession,
  getSubscriptionStatus,
  listenToSubscriptionStatus,
  cancelSubscription: async () => {
    if (!auth) throw new Error('Auth not initialized');
    const user = auth.currentUser;
    if (!user) throw new Error('User not authenticated');
    const functions = (await import('firebase/functions')).getFunctions();
    const cancelFn = (await import('firebase/functions')).httpsCallable(functions, 'v1-cancelSubscription');
    await cancelFn({});
  },
  reactivateSubscription: async () => {
    if (!auth) throw new Error('Auth not initialized');
    const user = auth.currentUser;
    if (!user) throw new Error('User not authenticated');
    const functions = (await import('firebase/functions')).getFunctions();
    const reactivateFn = (await import('firebase/functions')).httpsCallable(functions, 'v1-reactivateSubscription');
    await reactivateFn({});
  },
  initiateOnboarding,
  checkOnboardingStatus,
  requestInstantPayout,
  getPayoutBalance,
  formatPrice,
  hasActiveMembership,
  MEMBERSHIP_PRICE_ID,
};
