// Transportation added AFTER the background check → run the MVR-only check.
//
// Founder (2026-09-25): membership is one flat fee that covers the criminal
// check and, for anyone offering transportation, the driving record (MVR).
// A caregiver who picked Transportation at signup gets the bundled
// criminal+MVR Checkr package from the payment webhook. A caregiver who
// cleared the criminal-only check first and adds Transportation later (profile
// edit, settings, Evia) must get the MVR-only package — with no new charge.
// The former "Become an Approved Driver" $11.50 checkout is gone, so this
// Firestore trigger is what starts that check. Idempotent by construction:
// initiateMvrOnlyCheck refuses to run twice (mvrCheckInitiated), and every
// precondition below is re-read from the doc on each update.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

function servicesOf(d: Record<string, unknown> | undefined): string[] {
  if (!d) return [];
  const services = Array.isArray(d.services) && (d.services as unknown[]).length ? (d.services as string[]) : null;
  const skills = Array.isArray(d.skills) ? (d.skills as string[]) : [];
  return services ?? skills;
}

/** Pure decision: does this caregiver record need an MVR-only check started right now? */
export function needsMvrOnlyCheck(d: Record<string, any> | undefined): boolean {
  if (!d) return false;
  if (!servicesOf(d).includes("Transportation")) return false;
  if (d.membershipPaid !== true) return false;                 // the flat fee is what covers the check
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
      const { initiateMvrOnlyCheck } = await import("../checkr");
      await initiateMvrOnlyCheck(uid);
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
