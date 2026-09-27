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
  const bg = (cg.backgroundCheckData ?? {}) as Record<string, any>;
  const existingCandidateId: string | undefined = bg.checkrCandidateId;
  const invitationStatus: string | undefined = bg.invitationStatus;

  // Idempotent: a live invitation already exists and nobody is waiting on a
  // (re-)consent — a double-tap must not mint a second candidate.
  const awaitingConsent = invitationStatus === "awaiting_consent" || bg.consentRequired === true;
  if (existingCandidateId && !awaitingConsent && !args.reconsent && invitationStatus !== "expired" && invitationStatus !== "canceled") {
    return { status: "already", candidateId: existingCandidateId, invitationUrl: (bg.invitationUrl as string | undefined) ?? null };
  }

  // Flat membership (2026-09-25): the MVR rides along whenever the profile
  // offers Transportation (the payment webhook stamps mvrPaid from the same
  // rule; read the profile too in case Transportation was added since).
  const mvrIncluded = cg.mvrPaid === true || servicesOf(cg).includes("Transportation");
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
  const recordPatch: Record<string, unknown> = {
    uid,
    ...(mvrIncluded && { mvrPaid: true }),
    verificationStatus: "submitted",
    "backgroundCheckData.checkrCandidateId": inv.candidateId,
    "backgroundCheckData.consentGiven":      true,
    "backgroundCheckData.consentGivenAt":    consentAt,
    "backgroundCheckData.consentRequired":   false,
    "backgroundCheckData.submittedAt":       consentAt,
    "backgroundCheckData.status":            "pending",
    "backgroundCheckData.invitationStatus":  "sent",
    "backgroundCheckData.invitationUrl":     invitationUrl,
    "backgroundCheckData.initiatedVia":      consentReason === "renewal" ? "annual_renewal" : "consent_form",
    "backgroundCheckData.mvrIncluded":       mvrIncluded,
    "backgroundCheckData.checkrClearedAt":   null,
  };
  try {
    await ref.update(recordPatch);
  } catch {
    // No record yet (cannot normally happen — both callers ensure it) → create it.
    await ref.set({
      uid, ...(mvrIncluded && { mvrPaid: true }), verificationStatus: "submitted",
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
