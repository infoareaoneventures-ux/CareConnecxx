// ONE background-check authorization path (founder, 2026-09-25 — the same
// rule as the client side: whatever the site does, Evia calls the exact same
// function). Both consent surfaces land here:
//   - the site's dashboard modal → checkr.ts initiateCheckrCandidate (Auth uid)
//   - Evia's texted /bgcheck page → onboardingConversation.confirmBgcheckConsent (token → phone → uid)
// Before this, each had its own copy of "record consent, create the Checkr
// candidate, send the invitation" and fixes landed in one but not the other
// (the yearly re-consent existed only on the site's copy).
//
// What it does, once, for both: idempotency on a live invitation, package by
// profile (bundled criminal+MVR when Transportation is offered), candidate
// reuse on renewals, the FCRA consent stamp on caregivers/{uid} in the site's
// shape, identity PII to the private subcollection, the Checkr link texted to
// the caregiver, and the SMS session (if any) parked on the Checkr wait.
import * as admin from "firebase-admin";
import { createCheckrInvitation } from "./checkrApi";
import { assertMvrCheckConfig } from "./mvrConfig";
import { writeCaregiverBackgroundPII } from "./caregiverPrivate";

const db = admin.firestore();
const CHECKR_PACKAGE = process.env.CHECKR_PACKAGE || "checkrdirect_essential_criminal";

export interface BackgroundCheckConsentForm {
  legalFirstName: string;
  legalLastName:  string;
  zipCode:        string;
  state?:         string;
}

/**
 * The background check is part of the membership (flat fee, 2026-09-25). Both
 * consent surfaces land here, so this is the one place that refuses a check for
 * a caregiver whose membership is not active — the site's card only appears
 * after payment, but Evia's texted consent link could be tapped after a lapse
 * (founder live test, 2026-10-04). Callers map it to failed-precondition.
 */
export class MembershipRequiredError extends Error {
  code = "membership_required" as const;
  constructor() { super("Activate your membership first — the background check is included in it."); this.name = "MembershipRequiredError"; }
}

export interface AuthorizeBackgroundCheckResult {
  status:        "ok" | "already";
  candidateId:   string;
  invitationUrl: string | null;
}

function servicesOf(d: Record<string, any>): string[] {
  return Array.isArray(d.services) && d.services.length ? d.services : (Array.isArray(d.skills) ? d.skills : []);
}

/**
 * Record the caregiver's FCRA authorization and start the Checkr check.
 * `email` is the address Checkr invites (Auth email on the site path, the
 * collected email on Evia's); `phone` lets the Checkr link be texted and the
 * SMS session parked — resolved from the record when not given.
 */
export async function authorizeBackgroundCheck(args: {
  uid: string;
  email: string;
  form: BackgroundCheckConsentForm;
  phone?: string;
  /** The caller already established this is a deliberate re-authorization (Evia's
   *  consent page after a restart / expired invite) — skip the live-invitation
   *  short-circuit and mint a fresh invitation on the existing candidate. */
  reconsent?: boolean;
}): Promise<AuthorizeBackgroundCheckResult> {
  const { uid, email, form } = args;
  const ref = db.collection("caregivers").doc(uid);
  const snap = await ref.get();
  const cg = (snap.data() ?? {}) as Record<string, any>;
  {
    // caregivers/{uid} first, then the users record the same webhook writes
    // (caregiverMembershipBilling.markCaregiverMembershipPaid sets both).
    const { isCaregiverMembershipActive } = await import("./agents/caregiverAccessGate");
    if (!isCaregiverMembershipActive(cg)) {
      const userSnap = await db.collection("users").doc(uid).get().catch(() => null);
      const u = (userSnap?.data() ?? {}) as Record<string, any>;
      // The same one rule on the users mirror (sweep C1, 2026-10-11); subscriptionActive is what markCaregiverMembershipPaid also writes there.
      const userActive = isCaregiverMembershipActive(u) || u.subscriptionActive === true;
      if (!userActive) throw new MembershipRequiredError();
    }
  }
  const bg = (cg.backgroundCheckData ?? {}) as Record<string, any>;
  const existingCandidateId: string | undefined = bg.checkrCandidateId;
  const invitationStatus: string | undefined = bg.invitationStatus;

  // Later MVR, consent-first (founder, 2026-10-06): Transportation added after the criminal
  // check cleared parks the record on mvrStatus 'awaiting_consent' (triggers/transportationMvr.ts).
  // This authorization — the same page and the same function, from Settings, the dashboard or
  // Evia's texted link — is what starts the MVR-only check on the existing candidate. The
  // criminal record is left exactly as it is (no re-submission, no status reset).
  const bgAwaiting = bg.consentRequired === true || invitationStatus === "awaiting_consent";
  if (cg.mvrStatus === "awaiting_consent" && !bgAwaiting) {
    const consentAtMvr = new Date().toISOString();
    await writeCaregiverBackgroundPII(uid, { legalFirstName: form.legalFirstName, legalLastName: form.legalLastName, zip: form.zipCode });
    await ref.update({ mvrConsentGivenAt: consentAtMvr, "backgroundCheckData.mvrConsentGivenAt": consentAtMvr });
    const { initiateMvrOnlyCheck } = await import("./checkr");
    // The consent form's state is the work location Checkr requires (the record may have none).
    await initiateMvrOnlyCheck(uid, { workState: form.state || (cg.state as string | undefined), workCity: cg.city as string | undefined }); // sets mvrPaid / mvrCheckInitiated / mvrStatus 'pending'; admin alert if no candidate
    return { status: "ok", candidateId: existingCandidateId ?? "", invitationUrl: null };
  }

  // Idempotent: a live invitation already exists and nobody is waiting on a
  // (re-)consent — a double-tap must not mint a second candidate.
  const awaitingConsent = invitationStatus === "awaiting_consent" || bg.consentRequired === true;
  if (existingCandidateId && !awaitingConsent && !args.reconsent && invitationStatus !== "expired" && invitationStatus !== "canceled") {
    return { status: "already", candidateId: existingCandidateId, invitationUrl: (bg.invitationUrl as string | undefined) ?? null };
  }

  // Flat membership (2026-09-25): the MVR rides along whenever the profile
  // offers Transportation (the payment webhook stamps mvrPaid from the same
  // rule; read the profile too in case Transportation was added since).
  // Decided from the live profile only (2026-10-06): the stamp is written from this, never read into it.
  const mvrIncluded = servicesOf(cg).includes("Transportation");
  const packageSlug = mvrIncluded ? assertMvrCheckConfig("bundled") : CHECKR_PACKAGE;

  const workState = (form.state?.trim() || (cg.state as string | undefined) || "").toUpperCase();
  const inv = await createCheckrInvitation({
    firstName:   form.legalFirstName,
    lastName:    form.legalLastName,
    email,
    zipCode:     form.zipCode || (cg.zipCode as string | undefined),
    workState:   workState || undefined,
    workCity:    (cg.city as string | undefined) || undefined,
    packageSlug,
    customId:    uid,
    // Renewal / re-invite: reuse the candidate Checkr already knows.
    candidateId: existingCandidateId,
  });
  const invitationUrl = inv.invitationUrl || null;

  // Identity PII (legal name, ZIP) → owner/admin-only private subcollection,
  // never the world-readable parent doc.
  await writeCaregiverBackgroundPII(uid, { legalFirstName: form.legalFirstName, legalLastName: form.legalLastName, zip: form.zipCode });

  const consentAt = new Date().toISOString();
  const consentReason = (bg.consentReason as string | undefined) ?? "initial";
  // Dotted-path update: re-points ONLY these fields (the webhook matches on
  // checkrCandidateId, so the doc must follow the invitation the caregiver
  // will actually complete) and leaves the rest of backgroundCheckData alone.
  // Renewal (founder, 2026-10-06): the refresh runs while the caregiver stays cleared — no
  // re-submission, no pending status, the current clear date stays until the new one lands.
  const renewing = consentReason === "renewal";
  const recordPatch: Record<string, unknown> = {
    uid,
    mvrPaid: mvrIncluded, // 2026-10-06: written to match the live decision, never left sticky
    ...(renewing ? { "renewalRefresh.status": "running", "renewalRefresh.authorizedAt": consentAt } : { verificationStatus: "submitted", "backgroundCheckData.status": "pending", "backgroundCheckData.checkrClearedAt": null }),
    "backgroundCheckData.checkrCandidateId": inv.candidateId,
    "backgroundCheckData.consentGiven":      true,
    "backgroundCheckData.consentGivenAt":    consentAt,
    "backgroundCheckData.consentRequired":   false,
    "backgroundCheckData.submittedAt":       consentAt,
    "backgroundCheckData.invitationStatus":  "sent",
    "backgroundCheckData.invitationUrl":     invitationUrl,
    "backgroundCheckData.initiatedVia":      renewing ? "annual_renewal" : "consent_form",
    "backgroundCheckData.mvrIncluded":       mvrIncluded,
  };
  try {
    await ref.update(recordPatch);
  } catch {
    // No record yet (cannot normally happen — both callers ensure it) → create it.
    await ref.set({
      uid, mvrPaid: mvrIncluded, verificationStatus: "submitted",
      backgroundCheckData: {
        checkrCandidateId: inv.candidateId, consentGiven: true, consentGivenAt: consentAt, consentRequired: false,
        submittedAt: consentAt, status: "pending", invitationStatus: "sent", invitationUrl,
        initiatedVia: consentReason === "renewal" ? "annual_renewal" : "consent_form", mvrIncluded, checkrClearedAt: null,
      },
    }, { merge: true });
  }

  // Text the Checkr link (Checkr also emails it; an SMS-first caregiver may
  // never see that email) and park the SMS session on the Checkr wait.
  const phone = (args.phone ?? String(cg.phone ?? "")).trim();
  if (phone) {
    const sessRef = db.collection("agent_sessions").doc(phone);
    const sessSnap = await sessRef.get().catch(() => null);
    if (sessSnap?.exists) {
      const step = (sessSnap.data()?.onboardingStep as string | undefined) ?? "";
      const patch: Record<string, unknown> = {};
      if (invitationUrl) { patch.bgcheckInviteUrl = invitationUrl; patch.bgcheckInviteSentAt = consentAt; }
      if (step === "caregiver_send_bgcheck" || step === "caregiver_awaiting_bgcheck_consent") patch.onboardingStep = "caregiver_awaiting_bgcheck";
      if (Object.keys(patch).length) await sessRef.update(patch).catch(() => {});
    }
    // The link is delivered ONCE — bell + text — by onCaregiverAccountChange when
    // the record flips to invitationStatus 'sent' with the URL (2026-09-27).
  }

  return { status: "ok", candidateId: inv.candidateId, invitationUrl };
}
