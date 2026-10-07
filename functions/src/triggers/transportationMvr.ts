// Transportation added AFTER the background check → ask for consent, then the MVR-only check.
//
// Founder (2026-09-25): membership is one flat fee that covers the criminal
// check and, for anyone offering transportation, the driving record (MVR).
// A caregiver who picked Transportation at signup gets the bundled
// criminal+MVR Checkr package from the payment webhook. A caregiver who
// cleared the criminal-only check first and adds Transportation later (profile
// edit, settings, Evia) must get the MVR-only package — with no new charge.
// The former "Become an Approved Driver" $11.50 checkout is gone, so this
// Firestore trigger is what starts that path. Consent-first (founder, 2026-10-06:
// "isn't consent needed for the MVR run after they've already been cleared?"):
// the trigger only PARKS the record on mvrStatus 'awaiting_consent' and tells the
// caregiver (notifications/caregiverAccountEvents.ts mvr_consent_requested, with
// the consent page link). The SAME consent function both channels already use
// (backgroundCheckConsent.ts authorizeBackgroundCheck — the Settings / dashboard
// modal and Evia's texted /bgcheck page) sees that state and calls
// initiateMvrOnlyCheck. Nothing reaches Checkr before the caregiver authorizes.
// Idempotent by construction: every precondition below is re-read on each update.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { isCaregiverMembershipActiveForFamilies } from "../utils/caregiverEligibility";

const db = admin.firestore();

function servicesOf(d: Record<string, unknown> | undefined): string[] {
  if (!d) return [];
  const services = Array.isArray(d.services) && (d.services as unknown[]).length ? (d.services as string[]) : null;
  const skills = Array.isArray(d.skills) ? (d.skills as string[]) : [];
  return services ?? skills;
}

/** Pure decision: does this caregiver record need the MVR-only consent asked right now? */
export function needsMvrOnlyCheck(d: Record<string, any> | undefined): boolean {
  if (!d) return false;
  if (!servicesOf(d).includes("Transportation")) return false;
  // The membership covers the check — an ACTIVE one (2026-10-06: the legacy paid flag let a
  // lapsed caregiver start an MVR; same rule as every other membership gate).
  if (!isCaregiverMembershipActiveForFamilies(d)) return false;
  if (d.mvrStatus === "awaiting_consent") return false;        // already asked — waiting on her
  if (d.backgroundCheckData?.status !== "clear") return false;  // criminal check must be back first
  if (d.backgroundCheckData?.mvrIncluded === true) return false; // bundled report already carried the MVR
  if (d.isApprovedDriver === true) return false;
  if (d.mvrCheckInitiated === true) return false;
  if (d.mvrStatus === "pending") return false;
  return true;
}

export const startMvrOnTransportationAdded = functions.firestore
  .document("caregivers/{uid}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() as Record<string, any> | undefined;
    const after = change.after.data() as Record<string, any> | undefined;
    if (!needsMvrOnlyCheck(after)) return;
    // Only act on the transition — a doc that already needed it before this
    // write is being handled by the earlier invocation (or is mid-initiation).
    if (needsMvrOnlyCheck(before)) return;

    const uid = context.params.uid as string;
    try {
      await requestDrivingRecordConsent(uid);
    } catch (err) {
      console.error(`startMvrOnTransportationAdded: MVR-only check failed for ${uid}:`, err);
      await db.collection("admin_alerts").add({
        type:         "mvr_init_failed",
        caregiverId:  uid,
        errorMessage: err instanceof Error ? err.message : String(err),
        createdAt:    new Date().toISOString(),
        resolved:     false,
        severity:     "high",
      }).catch(() => {});
    }
  });

/**
 * Park the record on "authorize your driving record check" (mvrStatus 'awaiting_consent').
 * The caregiver is told ONCE by notifications/caregiverAccountEvents.ts (bell + text with the
 * consent page link) from this record change; the site's Settings / dashboard cards show the
 * Authorize button and Evia's card says "Reply AUTHORIZE". A stale cached Checkr link on the
 * text session is cleared so "send me the link again" mints the consent page, not last year's
 * invitation (same as bgcheckConsentRequest.ts).
 */
export async function requestDrivingRecordConsent(uid: string): Promise<void> {
  const ref = db.collection("caregivers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return;
  const cg = (snap.data() ?? {}) as Record<string, unknown>;
  if (cg.mvrStatus === "awaiting_consent") return;
  await ref.set({ mvrStatus: "awaiting_consent", mvrConsentRequestedAt: new Date().toISOString() }, { merge: true });
  const phone = typeof cg.phone === "string" ? cg.phone : undefined;
  if (phone) {
    await db.collection("agent_sessions").doc(phone)
      .update({ bgcheckInviteUrl: null, bgcheckInviteSentAt: null })
      .catch(() => { /* no text session for this caregiver */ });
  }
}
