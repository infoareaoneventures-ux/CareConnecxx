// ONE "find or create the caregiver's Stripe Connect (Express) account" path,
// shared by the site's Setup Payouts button (stripeConnect.createStripeConnectAccount)
// and every link Evia texts (onboardingConversation: the onboarding step, the
// /stripe-refresh re-mint, and the SETUP / send_onboarding_link resend).
//
// The caregiver RECORD (caregivers/{id}/private/payout, parent fallback) is the
// only source of the account id. Before 2026-10-03 Evia looked only in the SMS
// session's draft data, which the site never writes, so a caregiver who connected
// their bank on the site and later texted SETUP got a SECOND, bare Express account
// that then overwrote the connected one on their record.
import * as admin from "firebase-admin";
import { getCaregiverPayoutFields, writeCaregiverPayoutPrivate } from "./caregiverPrivate";

/** The slice of a Stripe client this module needs (lets callers pass the dry-run stub). */
export interface ConnectAccountClient {
  accounts: { create(params: Record<string, unknown>): Promise<{ id: string }> };
}

export interface EnsureConnectAccountOptions {
  /** Prefill for a brand-new account (the site passes the signed-in email; Evia the draft's). */
  email?: string;
  /** The caregiver doc's data when the caller already loaded it (saves a read). */
  parentData?: Record<string, unknown> | null;
  /** A last-resort account id the caller already knows (Evia's SMS draft, for sessions
   *  older than the record mirror). Used ONLY when the record carries none, and then
   *  mirrored onto the record — it can never replace an account the record has. */
  knownAccountId?: string | null;
  /** Writes the new account onto the record. Defaults to `persistNewConnectAccount`;
   *  Evia wraps the same writer in its dry-run guard. */
  persist?: (accountId: string, created: boolean) => Promise<void>;
}

export interface EnsureConnectAccountResult {
  accountId: string;
  /** true when `stripe.accounts.create` ran on this call. */
  created: boolean;
}

/** The fields a brand-new Express account writes onto the record (parent + private/payout). */
export function newConnectAccountFields(accountId: string): Record<string, unknown> {
  return {
    stripeAccountId: accountId,
    stripeOnboardingComplete: false,
    payoutsEnabled: false,
    chargesEnabled: false,
    detailsSubmitted: false,
    stripeAccountCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * Write a Connect account onto the caregiver record: dual-write parent +
 * private/payout (which also maintains the stripe_accounts reverse map the
 * Connect webhook resolves caregivers by). A NEW account writes the full
 * not-yet-onboarded flag set; an account the caller merely re-discovered
 * (`created: false`) writes only its id, so live flags are never reset.
 */
export async function persistNewConnectAccount(
  caregiverId: string,
  accountId: string,
  created: boolean,
  extraParentFields: Record<string, unknown> = {},
): Promise<void> {
  const fields = created ? newConnectAccountFields(accountId) : { stripeAccountId: accountId };
  await admin.firestore().collection("caregivers").doc(caregiverId)
    .set({ ...fields, ...extraParentFields }, { merge: true });
  await writeCaregiverPayoutPrivate(caregiverId, fields);
}

/**
 * Find the caregiver's Express account on the record, or create one the way the
 * site does (card_payments + transfers, individual, caregiverId in metadata) and
 * write it onto the record. Returns the account id and whether it was created.
 */
export async function ensureConnectAccount(
  stripe: ConnectAccountClient,
  caregiverId: string,
  opts: EnsureConnectAccountOptions = {},
): Promise<EnsureConnectAccountResult> {
  const persist = opts.persist ?? ((id: string, created: boolean) => persistNewConnectAccount(caregiverId, id, created));

  const payout = await getCaregiverPayoutFields(caregiverId, opts.parentData);
  const onRecord = payout.stripeAccountId;
  if (typeof onRecord === "string" && onRecord) return { accountId: onRecord, created: false };

  if (typeof opts.knownAccountId === "string" && opts.knownAccountId) {
    await persist(opts.knownAccountId, false);
    return { accountId: opts.knownAccountId, created: false };
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: "US",
    ...(opts.email ? { email: opts.email } : {}),
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: "individual",
    metadata: { caregiverId, platform: "evia" },
  });
  await persist(account.id, true);
  return { accountId: account.id, created: true };
}

// ── Live account status + onboarding link (shared by the site callables and Evia) ──

export interface ConnectStatusClient {
  accounts: { retrieve(id: string): Promise<{ charges_enabled?: boolean | null; payouts_enabled?: boolean | null; details_submitted?: boolean | null }> };
}
export interface ConnectLinkClient {
  accountLinks: { create(params: any): Promise<{ url: string }> };
}

export interface ConnectAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  stripeOnboardingComplete: boolean;
}

/**
 * Read the account's REAL state from Stripe and write it onto the record
 * (parent + private/payout) — the same writes the Connect webhook makes on
 * account.updated. This is what makes a record honest again when something
 * else (the admin "Approved" button, a missed webhook) left it saying
 * "connected" for an account Stripe considers unfinished.
 */
export async function syncConnectAccountStatus(
  stripe: ConnectStatusClient,
  accountId: string,
  caregiverId?: string | null,
): Promise<ConnectAccountStatus> {
  const account = await stripe.accounts.retrieve(accountId);
  const chargesEnabled = !!account.charges_enabled;
  const payoutsEnabled = !!account.payouts_enabled;
  const detailsSubmitted = !!account.details_submitted;
  const complete = chargesEnabled && payoutsEnabled;
  let target = caregiverId || null;
  if (!target) {
    const { resolveCaregiverByStripeAccount } = await import("./caregiverPrivate");
    target = await resolveCaregiverByStripeAccount(accountId);
  }
  if (target) {
    const update: Record<string, unknown> = { chargesEnabled, payoutsEnabled, detailsSubmitted, stripeOnboardingComplete: complete };
    if (complete) update.stripeOnboardingCompletedAt = admin.firestore.FieldValue.serverTimestamp();
    await admin.firestore().collection("caregivers").doc(target).set(update, { merge: true });
    await writeCaregiverPayoutPrivate(target, update);
  }
  return { chargesEnabled, payoutsEnabled, detailsSubmitted, stripeOnboardingComplete: complete };
}

/** Stripe refuses a dashboard login link for an Express account that has not finished onboarding. */
export function isConnectOnboardingIncompleteError(err: unknown): boolean {
  const e = err as { type?: string; rawType?: string; message?: string } | null;
  if (!e) return false;
  const invalid = e.type === "StripeInvalidRequestError" || e.rawType === "invalid_request_error";
  return invalid && /not completed onboarding/i.test(e.message ?? "");
}

/** A fresh Connect onboarding (account) link — the Setup Payouts button's link. */
export async function createConnectOnboardingLink(
  stripe: ConnectLinkClient,
  accountId: string,
  urls: { returnUrl: string; refreshUrl: string },
): Promise<string> {
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    return_url: urls.returnUrl,
    refresh_url: urls.refreshUrl,
  });
  return link.url;
}
