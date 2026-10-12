// Evia ↔ site awareness for the caregiver setup (founder, 2026-09-25: "site
// knows what evia is doing and evia knows what's happening thru the site all
// the way to the setup completion and steps").
//
// The site → Evia half: before Evia routes a caregiver's message during
// onboarding, look at caregivers/{uid} (the ONE record both channels write) and
// move her session cursor past anything the site already finished — the
// wizard's profile, the membership payment, the background-check consent, the
// payout setup. Without this a caregiver who finished a step on the site was
// walked through its link again by text.
//
// The rules are the SITE's (sweep C1/C2/C5, 2026-10-11): membership = the one
// caregiverAccessGate rule (active / trialing / past_due / payment_failed, or
// the legacy paid flag with no status — never membershipPaid:true on a
// canceled status); payouts live = payouts AND charges enabled on the private
// payout subdoc (the Payouts page); and a membership the site's webhook already
// parked on "authorize your background check" lands the cursor on the
// AWAITING-consent step (the caregiver was already told and linked by the
// membership_paid notice), so her next text is answered — not met with a
// second consent link.
//
// The Evia → site half needs no code here: every field Evia collects is
// mirrored to the same record as it is saved (caregiverProfileMirror.ts), the
// profile-complete/wizardStep stamps land at complete_collection, and the
// membership / Checkr / Stripe webhooks write the same fields for both
// channels — the dashboard's progress card is field-driven.
import * as admin from "firebase-admin";
import type { AgentSession } from "../linq/client";
import { collectionStepsForRole } from "./onboardingContract";
import { isCaregiverMembershipActive, caregiverPayoutsLive } from "./caregiverAccessGate";

const db = admin.firestore();

const MEMBERSHIP_STEPS = new Set(["caregiver_send_membership", "caregiver_awaiting_membership"]);
const BGCHECK_STEPS    = new Set(["caregiver_send_bgcheck", "caregiver_awaiting_bgcheck_consent", "caregiver_awaiting_bgcheck"]);
const STRIPE_STEPS     = new Set(["caregiver_send_stripe_connect", "caregiver_awaiting_stripe"]);

/** The site's payment webhook (bgcheckConsentRequest.ts) parked the record on "authorize your background check" — the caregiver has the consent link already. */
export function consentAlreadyRequested(cg: Record<string, any> | undefined): boolean {
  const bg = (cg?.backgroundCheckData ?? {}) as Record<string, any>;
  return bg.consentRequired === true || bg.invitationStatus === "awaiting_consent";
}

/** Pure decision: given the session cursor and the caregiver record, where should the cursor be? */
export function reconciledCaregiverStep(
  step: string,
  cg: Record<string, any> | undefined,
  payout?: Record<string, any> | undefined,
): string {
  if (!cg) return step;
  let cur = step;
  const membershipPaid = isCaregiverMembershipActive(cg);
  const bg = (cg.backgroundCheckData ?? {}) as Record<string, any>;
  const invitationLive = !!bg.checkrCandidateId && bg.invitationStatus !== "awaiting_consent" && bg.consentRequired !== true
    && bg.invitationStatus !== "expired" && bg.invitationStatus !== "canceled";
  const bgClear = cg.backgroundCheckStatus === "clear" || bg.status === "clear";
  const payoutsLive = caregiverPayoutsLive(payout);

  if (collectionStepsForRole("caregiver").includes(cur) && cg.onboardingStatus === "profile_complete") cur = "caregiver_send_membership";
  if (MEMBERSHIP_STEPS.has(cur) && membershipPaid) {
    // Paid on the site: the membership_paid notice already carried the consent
    // link, so the cursor lands on the awaiting step (the next text is read,
    // not answered with a second link). With no consent request on the record
    // yet, Evia still owes the link (caregiver_send_bgcheck).
    cur = consentAlreadyRequested(cg) ? "caregiver_awaiting_bgcheck_consent" : "caregiver_send_bgcheck";
  }
  if (BGCHECK_STEPS.has(cur)) {
    if (bgClear) cur = "caregiver_send_stripe_connect";
    else if (invitationLive && cur !== "caregiver_awaiting_bgcheck") cur = "caregiver_awaiting_bgcheck";
    else if (cur === "caregiver_send_bgcheck" && consentAlreadyRequested(cg)) cur = "caregiver_awaiting_bgcheck_consent";
  }
  if (STRIPE_STEPS.has(cur) && payoutsLive) cur = "complete";
  return cur;
}

/**
 * Move the session cursor past whatever the site already completed. Returns the
 * (possibly updated) session. Best-effort: any read failure leaves the cursor alone.
 */
export async function reconcileCaregiverOnboardingWithSite(phone: string, session: AgentSession): Promise<AgentSession> {
  const step = session.onboardingStep ?? "";
  if (session.userType !== "caregiver" || !step || step === "complete") return session;
  const uid = (session.caregiverId as string | undefined) ?? (session.userId as string | undefined);
  if (!uid) return session;
  try {
    const cgSnap = await db.collection("caregivers").doc(uid).get();
    if (!cgSnap.exists) return session;
    const cg = cgSnap.data() as Record<string, any>;
    let payout: Record<string, any> | undefined;
    if (STRIPE_STEPS.has(step)) {
      // The same read the Payouts page / get_payout_status make: the private
      // payout subdoc, falling back to the parent record's fields.
      const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
      payout = await getCaregiverPayoutFields(uid, cg).catch(() => undefined) as Record<string, any> | undefined;
    }
    const next = reconciledCaregiverStep(step, cg, payout);
    if (next === step) return session;
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: next, siteReconciledAt: new Date().toISOString() });
    console.info("caregiverSiteSync: cursor moved by site state", { phone, from: step, to: next });
    return { ...session, onboardingStep: next } as AgentSession;
  } catch (err) {
    console.warn("caregiverSiteSync: reconcile failed (leaving cursor):", err instanceof Error ? err.message : err);
    return session;
  }
}
