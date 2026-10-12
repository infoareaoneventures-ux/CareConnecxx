// Live caregiver account briefing (incident 2026-07-22: founder smoke test).
//
// Evia told a caregiver with name saved, membership paid, and a CLEARED
// background check: "I don't have your name saved yet", "you're currently
// awaiting your background check", and framed them as a family member.
// Root cause: caregiver answer paths (memory query, quick reply, main QA)
// grounded on conversation memory / Zep facts only — onboarding-era claims
// ("check is processing") outlived the live truth by two weeks.
//
// This module is the caregiver counterpart of describeWhoIsWho /
// describeSharedProfile on the client side: a deterministic, PII-light block
// of LIVE account facts read fresh from caregivers/{id} each turn. The rule
// it enforces (same as payout-permissions fix 2026-07-14): status claims come
// from live documents, never from memory. Fail-soft: any error returns "" so
// a Firestore blip never breaks an answer path.

import * as admin from "firebase-admin";
// The one caregiver membership rule (caregiverAccessGate.isCaregiverMembershipActive delegates to this pure leaf).
import { isCaregiverMembershipActiveForFamilies as isCaregiverMembershipActive } from "../utils/caregiverEligibility";

/** Deterministic rendering of the live fields — pure, unit-testable. */
export function renderCaregiverAccountStatus(cg: {
  name?: string;
  membershipPaid?: boolean;
  membershipStatus?: string;
  backgroundCheckStatus?: string;
  stripeAccountId?: string;
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  verified?: boolean;
  verificationStatus?: string;
  hourlyRate?: number;
  city?: string;
}): string {
  const lines: string[] = [];
  if (cg.name) lines.push(`- Their name: ${cg.name}`);
  lines.push(`- Role: professional CARE PROVIDER on the Evia platform (they are NOT a family member or care client — never describe them as caring for "their loved one")`);
  // The ONE membership rule (caregiverAccessGate, sweep C1 2026-10-11) — never the paid flag alone.
  lines.push(`- Care Provider membership: ${isCaregiverMembershipActive(cg as Record<string, unknown>) ? "active" : "not active"}`);

  const bg = (cg.backgroundCheckStatus ?? "").toLowerCase();
  if (bg === "clear") {
    lines.push("- Background check: CLEARED (done — never say it is pending or processing)");
  } else if (bg) {
    lines.push(`- Background check: ${cg.backgroundCheckStatus}`);
  } else {
    lines.push("- Background check: not started");
  }

  // The page's rule: connected only when payouts AND charges are enabled; an account id alone is "setup incomplete".
  lines.push(`- Payout account: ${cg.payoutsEnabled === true && cg.chargesEnabled === true ? "connected and ready" : cg.stripeAccountId ? "setup started, not finished (Stripe needs more information)" : "not set up yet"}`);
  if (cg.verified === true || cg.verificationStatus === "approved") {
    lines.push("- Profile: approved and visible to families");
  }
  if (typeof cg.hourlyRate === "number") lines.push(`- Rate: $${cg.hourlyRate}/hr`);
  if (cg.city) lines.push(`- City: ${cg.city}`);

  return (
    "## LIVE ACCOUNT FACTS (read fresh just now — these are the source of truth and OVERRIDE anything older memory or past conversation says)\n" +
    lines.join("\n")
  );
}

/**
 * Fresh-read the caregiver doc and render the live briefing. Empty string when
 * there is no caregiver id, the doc is missing, or the read fails (fail-soft —
 * callers keep their previous behavior, minus the live block).
 */
export async function describeCaregiverAccountStatus(
  caregiverId: string | undefined | null,
  opts?: { db?: admin.firestore.Firestore },
): Promise<string> {
  if (!caregiverId) return "";
  try {
    const db = opts?.db ?? admin.firestore();
    const snap = await db.collection("caregivers").doc(caregiverId).get();
    if (!snap.exists) return "";
    return renderCaregiverAccountStatus(snap.data() as Parameters<typeof renderCaregiverAccountStatus>[0]);
  } catch (err) {
    console.warn("describeCaregiverAccountStatus failed (fail-soft)", err instanceof Error ? err.message : String(err));
    return "";
  }
}
