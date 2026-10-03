// ONE path for everything the caregiver Payments › Membership tab does with
// Stripe, shared by the site's callables (stripe.ts) and every text Evia sends
// (onboardingConversation.ts, agents/caregiverMembership.ts):
//
//   · the Activate Membership checkout (customer reused from customers/{uid},
//     the server-picked flat annual price, both origins' metadata),
//   · what the record gets when a membership is paid (the same fields whether
//     the Stripe webhook saw a site checkout or an Evia one),
//   · the Manage button (Stripe Billing Portal),
//   · the subscription record the tab reads (live first, else whatever exists).
//
// Before 2026-10-03 Evia minted its own checkout (no customer reuse, a different
// price-env precedence, and a silent /done link when the price was missing) and
// its payment step wrote fewer record fields than the site's webhook, so an
// Evia-paid caregiver was missing from the admin verification queue and saw a
// different background-check card until she consented.
import * as admin from "firebase-admin";

const db = () => admin.firestore();

/** The flat annual caregiver membership price — the server picks it, never the browser. */
export function resolveCaregiverAnnualPriceId(): string {
  return process.env.STRIPE_CAREGIVER_ANNUAL
    || process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID
    || "price_1UJRHKL7Ss5iuUb7jUeIva1L";
}

/** The slice of a Stripe client this module needs (lets callers pass the dry-run stub). */
// Parameter types are `any` so the real Stripe client (strict param types) and the
// dry-run / test stubs both satisfy the interface.
export interface MembershipStripeClient {
  customers: { create(params: any): Promise<{ id: string }> };
  checkout: { sessions: { create(params: any): Promise<{ id: string; url: string | null }> } };
  billingPortal: { sessions: { create(params: any): Promise<{ url: string }> } };
}

/** customers/{uid}.stripeCustomerId — reused when present, created once otherwise (the site's rule). */
export async function getOrCreateStripeCustomer(
  stripe: Pick<MembershipStripeClient, "customers">,
  uid: string,
  opts: { email?: string | null; phone?: string | null } = {},
): Promise<string> {
  const ref = db().collection("customers").doc(uid);
  const snap = await ref.get();
  const existing = snap.data()?.stripeCustomerId as string | undefined;
  if (existing) return existing;
  let email = opts.email ?? undefined;
  if (!email) {
    try { email = (await admin.auth().getUser(uid)).email ?? undefined; } catch { /* no auth record yet */ }
  }
  if (!email) {
    try { email = ((await db().collection("users").doc(uid).get()).data()?.email as string | undefined) ?? undefined; } catch { /* ignore */ }
  }
  const customer = await stripe.customers.create({
    ...(email ? { email } : {}),
    ...(opts.phone ? { phone: opts.phone } : {}),
    metadata: { firebaseUID: uid },
  });
  await ref.set({
    stripeCustomerId: customer.id,
    ...(email ? { email } : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return customer.id;
}

export interface CaregiverMembershipCheckoutOptions {
  /** The caregiver's uid when the record exists (site: always; Evia: once the account is created). */
  uid?: string | null;
  /** Evia's phone-keyed session, so the payment webhook advances the text conversation. */
  phone?: string | null;
  successUrl: string;
  cancelUrl: string;
  /** Tells the webhook to run the bundled criminal+MVR package (Transportation offered). */
  includeMVR?: boolean;
}

/**
 * The Activate Membership checkout, identical for the site's button and Evia's
 * texted link: mode subscription, the flat annual price, the customer reused
 * from customers/{uid}, and metadata the webhook understands from either origin
 * (task + phone for Evia's session; firebaseUID for the record).
 */
export async function createCaregiverMembershipCheckout(
  stripe: MembershipStripeClient,
  opts: CaregiverMembershipCheckoutOptions,
): Promise<{ id: string; url: string | null }> {
  const uid = opts.uid || undefined;
  const phone = opts.phone || undefined;
  let customerId: string | undefined;
  if (uid) {
    try {
      customerId = await getOrCreateStripeCustomer(stripe, uid, { phone });
    } catch (err) {
      // Checkout still works without a pre-made customer (Stripe creates one and
      // the webhook writes it back) — never block a payment on this.
      console.error(`createCaregiverMembershipCheckout: customer lookup failed for ${uid} (continuing without):`, err);
    }
  }
  const identity = {
    ...(uid ? { firebaseUID: uid } : {}),
    ...(phone ? { phone } : {}),
  };
  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: resolveCaregiverAnnualPriceId(), quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    ...(customerId ? { customer: customerId } : {}),
    metadata: { ...identity, task: "caregiver_membership", includeMVR: opts.includeMVR ? "true" : "false" },
    subscription_data: { metadata: { ...identity, kind: "caregiver_membership" } },
  });
}

export interface MembershipPaidDetails {
  subscriptionId?: string | null;
  customerId?: string | null;
  /** Evia's session phone — kept on the parent doc so the Checkr / Connect webhooks can find the conversation. */
  phone?: string | null;
}

/**
 * What a paid membership writes onto the record — the same from both origins:
 * caregivers/{uid}: membershipPaid, mvrPaid when the profile offers Transportation
 *   (the flat fee covers the MVR), verificationStatus 'submitted', the subscription id;
 * users/{uid}: membershipStatus active + subscription fields + verificationStatus;
 * customers/{uid}: the Stripe customer (what the Manage button resolves);
 * then the account is parked on "authorize your background check"
 * (bgcheckConsentRequest.requestBackgroundCheckConsent — consent BEFORE any Checkr call).
 * Founder rule (2026-10-03): paying the membership IS the rerun of the background
 * check — a caregiver with a prior check (renewal, or a rejoin after a lapse) is
 * asked again as a 'renewal' (not bookable until the new check clears); a first
 * payment is the 'initial' ask.
 */
export async function markCaregiverMembershipPaid(uid: string, details: MembershipPaidDetails = {}): Promise<void> {
  const cgRef = db().collection("caregivers").doc(uid);
  const cg = ((await cgRef.get()).data() ?? {}) as Record<string, unknown>;
  const services: string[] = Array.isArray(cg.services) && (cg.services as unknown[]).length
    ? (cg.services as string[])
    : (Array.isArray(cg.skills) ? (cg.skills as string[]) : []);
  const includeMVR = services.includes("Transportation");

  await cgRef.set({
    uid,
    ...(details.phone ? { phone: details.phone } : {}),
    membershipPaid: true,
    ...(includeMVR ? { mvrPaid: true } : {}),
    verificationStatus: "submitted",
    ...(details.subscriptionId ? { membershipSubscriptionId: details.subscriptionId } : {}),
  }, { merge: true });

  await db().collection("users").doc(uid).set({
    membershipStatus: "active",
    subscriptionActive: true,
    verificationStatus: "submitted",
    ...(details.subscriptionId ? { subscriptionId: details.subscriptionId } : {}),
    ...(details.customerId ? { stripeCustomerId: details.customerId } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (details.customerId) {
    await db().collection("customers").doc(uid)
      .set({ stripeCustomerId: details.customerId }, { merge: true })
      .catch((err) => console.error(`markCaregiverMembershipPaid(${uid}): customers mirror failed:`, err));
  }

  const bg = (cg.backgroundCheckData ?? {}) as Record<string, unknown>;
  const hadCheck = !!bg.checkrCandidateId || cg.backgroundCheckStatus === "clear" || cg.verified === true;
  const reason = hadCheck ? "renewal" : "initial";
  const { requestBackgroundCheckConsent } = await import("./bgcheckConsentRequest");
  await requestBackgroundCheckConsent(uid, reason)
    .catch((err) => console.error(`requestBackgroundCheckConsent(${reason}) failed for ${uid}:`, err));
}

export class NoBillingAccountError extends Error {
  constructor() { super("No billing account found. Please purchase a membership first."); this.name = "NoBillingAccountError"; }
}

/** The Manage button: a Stripe Billing Portal session for the caregiver's customer (customers/{uid}). */
export async function createCaregiverBillingPortalUrl(
  stripe: Pick<MembershipStripeClient, "billingPortal">,
  uid: string,
  returnUrl: string,
): Promise<string> {
  const snap = await db().collection("customers").doc(uid).get();
  const customerId = snap.data()?.stripeCustomerId as string | undefined;
  if (!customerId) throw new NoBillingAccountError();
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return session.url;
}

/** The tab's subscription record: the live (active/trialing) one first, else whatever exists. */
export async function readCaregiverSubscriptionRecord(uid: string): Promise<Record<string, unknown> | null> {
  const coll = db().collection("customers").doc(uid).collection("subscriptions");
  const live = await coll.where("status", "in", ["active", "trialing"]).limit(1).get();
  if (!live.empty) return live.docs[0].data() as Record<string, unknown>;
  const any = await coll.limit(1).get();
  return any.empty ? null : (any.docs[0].data() as Record<string, unknown>);
}
