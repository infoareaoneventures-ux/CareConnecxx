// ── Childcare caregiver enrollment: the U5 wiring for the SMS funnel ─────────
//
// Front door Stage 2 deliverable 4: at funnel completion, upsert the childcare
// vertical profile, record policy acceptance, and start childcare screening
// through the existing shared-package path.
//
// WHY THIS IS NOT A CALLABLE INVOCATION
// The U5 server side lives in childcare/providerVerticalCallables.ts as v1
// `onCall` functions wrapped by `childcareOnCall`, whose first two acts are
// `requireAppCheck(context, …)` and `requireAuth(context)`. An SMS turn has no
// App Check token and no CallableContext — synthesizing one would mean forging
// exactly the attestation those guards exist to check. So this module reuses the
// U5 SERVER SIDE (the modules the callables are built from) rather than the HTTP
// surface, and reuses it whole:
//
//   childcare/providerEligibility.ts   childcareVerticalProfileRef,
//                                      ChildcareVerticalProfileDoc,
//                                      computeMissingChildcareFields (THE
//                                      single "what's missing" definition),
//                                      recomputeChildcareProviderVisibility
//   childcare/screeningPolicy.ts       adoptableBaseEvidence,
//                                      buildScreeningFromBaseEvidence,
//                                      buildScreeningForInvitation,
//                                      childcareScreeningRef,
//                                      evaluateScreeningEvidence
//   childcare/jurisdictionPolicy.ts    loadJurisdictionPolicy, normalizeStateCode,
//                                      resolveChildcareCheckrPackage (the SHARED
//                                      base Checkr package — R26 as amended),
//                                      assertEnableableChildcareCategory
//   childcare/consentReceipts.ts       writeChildcareConsentReceipts
//   checkrApi.ts                       createCheckrInvitation (candidate reuse)
//
// The document written is the SAME doc at the SAME path with the SAME schema the
// callable writes, so the U11 web page, the U6-U8 recheck seam, and the operator
// review queue all see one enrollment regardless of which surface produced it.
//
// INVARIANTS THIS MODULE MUST NOT WEAKEN
//   • MANUAL APPROVAL IS ALWAYS STILL REQUIRED. `approval` is a preserved
//     server-owned field — read, never written. A Checkr "clear" is EVIDENCE,
//     never an approval (R27/R28). `approvalPending` in the result is a constant
//     `true` for exactly that reason.
//   • DEFERRED CATEGORIES ARE HARD-BLOCKED. Services pass through
//     `assertEnableableChildcareCategory`, same as the callable.
//   • CONSENT-FIRST SCREENING. `startChildcareScreening` refuses without
//     `screeningConsent === true`; this module refuses the same way, so a Checkr
//     invitation can never precede an explicit consent turn.
//   • SENIOR FIELDS ARE NEVER TOUCHED (R24). The only parent-doc field written is
//     the namespaced derived summary, and that write happens inside
//     recomputeChildcareProviderVisibility, not here.
//   • FLAGS GATE EVERYTHING (R61). Writes require `writesEnabled`; a flag read
//     failure fails closed.

import * as admin from "firebase-admin";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import {
  childcareVerticalProfileRef,
  computeMissingChildcareFields,
  loadChildcareVerticalProfile,
  recomputeChildcareProviderVisibility,
  type ChildcareVerticalProfileDoc,
} from "../childcare/providerEligibility";
import {
  adoptableBaseEvidence,
  buildScreeningForInvitation,
  buildScreeningFromBaseEvidence,
  childcareScreeningRef,
  evaluateScreeningEvidence,
  loadChildcareScreening,
  type ProviderCredential,
} from "../childcare/screeningPolicy";
import {
  assertEnableableChildcareCategory,
  loadJurisdictionPolicy,
  normalizeStateCode,
  resolveChildcareCheckrPackage,
} from "../childcare/jurisdictionPolicy";
import { writeChildcareConsentReceipts } from "../childcare/consentReceipts";
import {
  CHILDCARE_CAREGIVER_AGE_BANDS,
  normalizeChildcareAgeBands,
  normalizeChildcareServices,
} from "./childcareCaregiverFunnel";

type Db = admin.firestore.Firestore;

/**
 * The pilot jurisdiction. Derived from the SERVICE AREA, not from anything the
 * caregiver typed — a state code a person types is not evidence of where they
 * work, and the service-area gate has already confirmed Santa Clara County
 * before the funnel could collect a city at all.
 */
export const CHILDCARE_CAREGIVER_PILOT_STATE = "CA";

export interface ChildcareEnrollmentInput {
  uid: string;
  /** The funnel's collected data (childcare allowlist keys only). */
  collected: Record<string, unknown>;
  db?: Db;
  now?: Date;
  jurisdictionState?: string;
}

export interface ChildcareProfileUpsertResult {
  ok: boolean;
  reason: string;
  profileVersion: number;
  /** Base fields reused from the adult profile — never re-asked (AE21). */
  reusedBaseFields: string[];
  missingBaseFields: string[];
  missingChildcareFields: string[];
  /** Deferred categories the caller asked for and this module REFUSED. */
  refusedCategories: string[];
  /** ALWAYS true: a profile upsert never approves anybody (R27/R28). */
  approvalPending: true;
  /** Policy version accepted, or null when the jurisdiction has none yet. */
  acceptedPolicyVersion: string | null;
}

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").match(/\d+(\.\d+)?/)?.[0]);
  if (!Number.isFinite(n)) return null;
  return n >= min && n <= max ? n : null;
}

function credentialList(raw: unknown): ProviderCredential[] {
  const out: ProviderCredential[] = [];
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;/]/) : [];
  for (const entry of entries.slice(0, 20)) {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const type = String(e.type ?? "").trim().slice(0, 200);
      if (!type) continue;
      out.push({
        type,
        issuedOn: typeof e.issuedOn === "string" && Number.isFinite(Date.parse(e.issuedOn)) ? e.issuedOn : null,
        expiresOn: typeof e.expiresOn === "string" && Number.isFinite(Date.parse(e.expiresOn)) ? e.expiresOn : null,
        reference: typeof e.reference === "string" ? e.reference.trim().slice(0, 200) : null,
      });
      continue;
    }
    const type = String(entry ?? "").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 200);
    if (!type || type === "none") continue;
    if (!out.some((c) => c.type === type)) {
      out.push({ type, issuedOn: null, expiresOn: null, reference: null });
    }
  }
  return out;
}

function boundedStrings(raw: unknown, max = 20): string[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? [raw] : [];
  const out: string[] = [];
  for (const e of entries.slice(0, max)) {
    const s = String(e ?? "").trim().slice(0, 200);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Upsert the caregiver's childcare vertical profile + record policy acceptance.
 * Mirrors `upsertChildcareVerticalProfile` + `acceptChildcarePolicy` field for
 * field, including the PRESERVED server-owned fields: a funnel turn can never
 * grant itself approval, clear a suspension, or fabricate a policy acceptance.
 */
export async function upsertChildcareCaregiverProfileFromFunnel(
  input: ChildcareEnrollmentInput,
): Promise<ChildcareProfileUpsertResult> {
  const db = input.db ?? admin.firestore();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const collected = input.collected ?? {};

  const fail = (reason: string): ChildcareProfileUpsertResult => ({
    ok: false,
    reason,
    profileVersion: 0,
    reusedBaseFields: [],
    missingBaseFields: [],
    missingChildcareFields: [],
    refusedCategories: [],
    approvalPending: true,
    acceptedPolicyVersion: null,
  });

  // R61: writes require writesEnabled; a flag read failure fails CLOSED.
  const flags = await getChildcareFlags({ db }).catch(() => null);
  if (!flags?.enabled || !flags?.writesEnabled) return fail("childcare_disabled");
  if (!input.uid) return fail("no_uid");

  const cgSnap = await db.collection("caregivers").doc(input.uid).get();
  if (!cgSnap.exists) return fail("no_caregiver_account");
  const caregiver = (cgSnap.data() ?? {}) as Record<string, unknown>;

  const jurisdictionState = normalizeStateCode(
    String(input.jurisdictionState ?? CHILDCARE_CAREGIVER_PILOT_STATE),
  );
  if (!jurisdictionState) return fail("no_jurisdiction");

  const bands = normalizeChildcareAgeBands(collected.childcareAgeBands);
  const services = normalizeChildcareServices(collected.childcareServices);
  const refusedCategories = [...new Set([...bands.refusedCategories, ...services.refusedCategories])];
  // Redundant belt to the allowlists above — the same hard block the callable
  // applies, so a deferred category cannot reach Firestore by any route.
  for (const service of services.accepted) assertEnableableChildcareCategory(service);
  for (const band of bands.accepted) {
    if (!CHILDCARE_CAREGIVER_AGE_BANDS.includes(band)) return fail("invalid_age_band");
  }

  const ref = childcareVerticalProfileRef(input.uid, db);
  const existingSnap = await ref.get();
  const existing = existingSnap.exists
    ? ((existingSnap.data() ?? {}) as Partial<ChildcareVerticalProfileDoc>)
    : null;

  const doc: ChildcareVerticalProfileDoc = {
    careVertical: "child",
    caregiverUid: input.uid,
    ageBands: bands.accepted.length ? bands.accepted : existing?.ageBands ?? [],
    services: services.accepted.length ? services.accepted : existing?.services ?? [],
    yearsChildcareExperience:
      num(collected.yearsChildcareExperience, 0, 80) ?? existing?.yearsChildcareExperience ?? null,
    references: boundedStrings(collected.childcareReferences).length
      ? boundedStrings(collected.childcareReferences)
      : existing?.references ?? [],
    credentials: credentialList(collected.childcareCredentials).length
      ? credentialList(collected.childcareCredentials)
      : existing?.credentials ?? [],
    // R24/R-FD6: the childcare rate lives on the VERTICAL profile. The value may
    // start out equal to the senior rate (one question, AE21), but from here the
    // two are independent documents and can diverge forever after.
    hourlyRate: num(collected.hourlyRate, 15, 200) ?? existing?.hourlyRate ?? null,
    availabilityOverrides: existing?.availabilityOverrides ?? null,
    transport: { offersTransport: collected.childcareTransport === true },
    limitations: boundedStrings(collected.childcareLimitations).length
      ? boundedStrings(collected.childcareLimitations)
      : existing?.limitations ?? [],
    jurisdictionState,
    adultAgeAttested: collected.adultAgeAttested === true || existing?.adultAgeAttested === true,
    // PRESERVED server-owned fields — never granted by a funnel turn.
    acceptedPolicyVersion: existing?.acceptedPolicyVersion ?? null,
    acceptedPolicyAt: existing?.acceptedPolicyAt ?? null,
    approval: existing?.approval ?? { state: "none", decidedByUid: null, decidedAt: null, auditRef: null },
    suspension: existing?.suspension ?? { active: false, code: null, suspendedByUid: null, suspendedAt: null },
    profileVersion: (existing?.profileVersion ?? 0) + 1,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  await ref.set(doc);

  // Policy acceptance (acceptChildcarePolicy parity). A versionless policy
  // cannot be accepted — R23 — so it stays pending rather than being faked. The
  // U1 readiness evaluator keeps activation blocked in that state anyway.
  const policy = await loadJurisdictionPolicy(jurisdictionState, db).catch(() => null);
  const policyVersion = typeof policy?.policyVersion === "string" ? policy.policyVersion.trim() : "";
  let acceptedPolicyVersion: string | null = null;
  if (policyVersion) {
    acceptedPolicyVersion = policyVersion;
    await ref.set(
      { acceptedPolicyVersion: policyVersion, acceptedPolicyAt: nowIso, updatedAt: nowIso },
      { merge: true },
    );
    await writeChildcareConsentReceipts({
      adultUid: input.uid,
      jurisdictionState,
      // The acceptance happened over SMS, and the receipt must say so.
      channel: "sms",
      source: "childcare_provider_policy_acceptance",
      policyTypes: ["childcarePolicy"],
      db,
      now,
    }).catch(() => {});
  }

  await recomputeChildcareProviderVisibility(input.uid, { db, now }).catch(() => {});

  const missing = computeMissingChildcareFields(caregiver, {
    ...doc,
    ...(acceptedPolicyVersion ? { acceptedPolicyVersion } : {}),
  });
  await logAudit({
    eventType: "childcare_vertical_profile_upserted",
    userId: input.uid,
    data: {
      profileVersion: doc.profileVersion,
      missingChildcareFieldCount: missing.missingChildcareFields.length,
      source: "sms_caregiver_funnel",
      refusedCategoryCount: refusedCategories.length,
    },
  }).catch(() => {});

  return {
    ok: true,
    reason: "upserted",
    profileVersion: doc.profileVersion,
    reusedBaseFields: missing.reusedBaseFields,
    missingBaseFields: missing.missingBaseFields,
    missingChildcareFields: missing.missingChildcareFields,
    refusedCategories,
    approvalPending: true,
    acceptedPolicyVersion,
  };
}

// ── Base account for a caregiver who arrived through CHILDCARE ───────────────

export interface EnsureBaseDocResult {
  uid: string | null;
  created: boolean;
  reason: string;
}

/**
 * Make sure a childcare-first caregiver has the uid-keyed `caregivers/{uid}` base
 * document the U5 stack requires, WITHOUT inventing senior state.
 *
 * What it writes: identity + contact + logistics only (name, email, city, state,
 * zip, availability, languages, gender, canDrive) plus `status: "onboarding"` —
 * invisible to senior matching and to FindCaregivers, exactly like the senior
 * flow's own gate pre-create.
 *
 * What it deliberately does NOT write (R24/R-FD6): `hourlyRate`, `services`,
 * `skills`, `specialties`, `jobType`, `verificationStatus`, `onboardingStatus:
 * profile_complete`, or anything else that would assert senior capability or
 * senior approval for somebody who only signed up to watch kids. The childcare
 * rate and childcare services live on the vertical profile.
 */
export async function ensureChildcareCaregiverBaseDoc(args: {
  phone: string;
  collected: Record<string, unknown>;
  existingUid?: string | null;
  db?: Db;
  now?: Date;
  jurisdictionState?: string;
  /** Test seam — defaults to Firebase Auth create-or-find by phone. */
  resolveAuthUid?: (phone: string, displayName: string) => Promise<string | null>;
}): Promise<EnsureBaseDocResult> {
  const db = args.db ?? admin.firestore();
  const now = args.now ?? new Date();
  const collected = args.collected ?? {};
  const name = String(collected.name ?? "").trim();

  let uid = String(args.existingUid ?? "").trim();
  if (!uid) {
    const resolve = args.resolveAuthUid ?? (async (phone: string, displayName: string) => {
      try {
        const user = await admin.auth().createUser({ phoneNumber: phone, displayName: displayName || undefined });
        return user.uid;
      } catch (err) {
        if ((err as { code?: string })?.code !== "auth/phone-number-already-exists") return null;
        const existing = await admin.auth().getUserByPhoneNumber(phone).catch(() => null);
        return existing?.uid ?? null;
      }
    });
    uid = (await resolve(args.phone, name).catch(() => null)) ?? "";
  }
  if (!uid) return { uid: null, created: false, reason: "no_auth_uid" };

  const ref = db.collection("caregivers").doc(uid);
  const snap = await ref.get();
  const keepStatus = snap.exists &&
    ["active", "pending_review"].includes(String((snap.data() ?? {}).status ?? ""));

  const base: Record<string, unknown> = {
    phone: args.phone,
    uid,
    ...(name ? { name } : {}),
    ...(typeof collected.email === "string" && collected.email ? { email: collected.email } : {}),
    ...(typeof collected.city === "string" && collected.city ? { city: collected.city } : {}),
    state: normalizeStateCode(String(args.jurisdictionState ?? CHILDCARE_CAREGIVER_PILOT_STATE)),
    ...(collected.zipCode ? { zipCode: String(collected.zipCode) } : {}),
    ...(collected.availability ? { availability: collected.availability } : {}),
    ...(collected.languages ? { languages: collected.languages } : {}),
    ...(collected.gender ? { gender: collected.gender } : {}),
    ...(collected.canDrive === true || collected.canDrive === false ? { canDrive: collected.canDrive } : {}),
    ...(keepStatus ? {} : { status: "onboarding", onboardingStatus: "in_progress" }),
    ...(snap.exists ? {} : { createdAt: now.toISOString() }),
    updatedAt: now.toISOString(),
  };
  await ref.set(base, { merge: true });
  return { uid, created: !snap.exists, reason: snap.exists ? "existing" : "created" };
}

// ── Screening (startChildcareScreening parity, shared base package) ──────────

export interface ChildcareScreeningStartResult {
  ok: boolean;
  /** already_current | invitation_outstanding | base_evidence_adopted | invitation_sent | <failure> */
  mode: string;
  evidenceStatus: string;
  invitationUrl?: string;
  /** ALWAYS true — a clear report is evidence, never an approval (R27). */
  approvalPending: true;
}

export interface StartChildcareScreeningArgs {
  uid: string;
  /** Consent-first: the funnel's explicit YES. Anything else refuses. */
  screeningConsent: boolean;
  db?: Db;
  now?: Date;
  /** Test seam for the Checkr invitation (defaults to the real checkrApi). */
  createInvitation?: (args: {
    firstName: string;
    lastName: string;
    email: string;
    packageSlug: string;
    customId: string;
    candidateId?: string;
    workState?: string;
    workCity?: string;
  }) => Promise<{ candidateId: string; invitationUrl: string }>;
}

/**
 * Start (or reuse) the caregiver's CHILDCARE screening. Same order of operations
 * as the U5 callable: consent receipt → current-evidence short-circuit →
 * outstanding-invitation short-circuit → shared-base-report ADOPTION (AE21) →
 * fresh invitation on the shared base package with Checkr candidate reuse.
 *
 * Never throws: the funnel must still be able to reply.
 */
export async function startChildcareCaregiverScreening(
  args: StartChildcareScreeningArgs,
): Promise<ChildcareScreeningStartResult> {
  const db = args.db ?? admin.firestore();
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const deny = (mode: string): ChildcareScreeningStartResult => ({
    ok: false, mode, evidenceStatus: "none", approvalPending: true,
  });

  // Consent-first — NEVER a pre-consent Checkr call.
  if (args.screeningConsent !== true) return deny("consent_required");

  const flags = await getChildcareFlags({ db }).catch(() => null);
  if (!flags?.enabled || !flags?.writesEnabled) return deny("childcare_disabled");
  if (!args.uid) return deny("no_uid");

  try {
    const cgSnap = await db.collection("caregivers").doc(args.uid).get();
    if (!cgSnap.exists) return deny("no_caregiver_account");
    const caregiver = (cgSnap.data() ?? {}) as Record<string, unknown>;

    const profile = await loadChildcareVerticalProfile(args.uid, db);
    if (!profile?.jurisdictionState) return deny("profile_before_screening");
    const state = normalizeStateCode(profile.jurisdictionState);
    const policy = await loadJurisdictionPolicy(state, db).catch(() => null);

    // Versioned screening-disclosure consent receipt (R23).
    await writeChildcareConsentReceipts({
      adultUid: args.uid,
      jurisdictionState: state,
      channel: "sms",
      source: "childcare_provider_screening_consent",
      policyTypes: ["screeningDisclosure"],
      db,
      now,
    }).catch(() => {});

    const existing = await loadChildcareScreening(args.uid, db);
    if (existing) {
      const evaluation = evaluateScreeningEvidence(existing, policy, { now });
      if (evaluation.current) {
        return {
          ok: true, mode: "already_current",
          evidenceStatus: String(existing.evidenceStatus ?? "clear"), approvalPending: true,
        };
      }
      if (existing.evidenceStatus === "pending" && existing.checkr?.invitationStatus === "sent") {
        return { ok: true, mode: "invitation_outstanding", evidenceStatus: "pending", approvalPending: true };
      }
    }

    const ref = childcareScreeningRef(args.uid, db);

    // AE21 evidence reuse: a current, provably-shared-base-package clear report
    // is ADOPTED as childcare evidence — no duplicate check, no duplicate cost.
    const adoption = adoptableBaseEvidence(caregiver, policy, { now });
    if (adoption.adoptable && adoption.completedAt) {
      const bg = (caregiver.backgroundCheckData ?? {}) as Record<string, unknown>;
      const doc = buildScreeningFromBaseEvidence({
        caregiverUid: args.uid,
        jurisdictionState: state,
        policy,
        now,
        candidateId: adoption.candidateId,
        reportId: typeof bg.checkrReportId === "string" ? bg.checkrReportId : null,
        completedAt: adoption.completedAt,
      });
      if (existing) {
        doc.createdAt = typeof existing.createdAt === "string" ? existing.createdAt : nowIso;
        doc.eligibilityVersion = (existing.eligibilityVersion ?? 0) + 1;
      }
      await ref.set(doc);
      await recomputeChildcareProviderVisibility(args.uid, { db, now }).catch(() => {});
      await logAudit({
        eventType: "childcare_screening_evidence_adopted",
        userId: args.uid,
        data: { jurisdiction: state, source: "shared_base_report_adoption", channel: "linq" },
      }).catch(() => {});
      return { ok: true, mode: "base_evidence_adopted", evidenceStatus: "clear", approvalPending: true };
    }

    const bg = (caregiver.backgroundCheckData ?? {}) as Record<string, unknown>;
    const existingCandidateId =
      typeof bg.checkrCandidateId === "string" && bg.checkrCandidateId ? bg.checkrCandidateId : undefined;
    const email = typeof caregiver.email === "string" ? caregiver.email : "";
    const name = typeof caregiver.name === "string" ? caregiver.name.trim() : "";
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(" ");
    if (!existingCandidateId && (!email || !firstName || !lastName)) {
      return deny("base_profile_incomplete");
    }

    const createInvitation = args.createInvitation ?? (async (p) => {
      const { createCheckrInvitation } = await import("../checkrApi");
      return createCheckrInvitation(p) as Promise<{ candidateId: string; invitationUrl: string }>;
    });
    const invitation = await createInvitation({
      firstName: firstName || "Caregiver",
      lastName: lastName || "Provider",
      email,
      // R26 as amended: the SHARED base Checkr package, resolved (never a literal).
      packageSlug: resolveChildcareCheckrPackage(),
      customId: args.uid,
      ...(existingCandidateId ? { candidateId: existingCandidateId } : {}),
      workState: state,
      ...(typeof caregiver.city === "string" ? { workCity: caregiver.city } : {}),
    });

    const doc = buildScreeningForInvitation({
      caregiverUid: args.uid,
      jurisdictionState: state,
      policy,
      now,
      candidateId: invitation.candidateId,
    });
    if (existing) {
      doc.createdAt = typeof existing.createdAt === "string" ? existing.createdAt : nowIso;
      doc.eligibilityVersion = (existing.eligibilityVersion ?? 0) + 1;
    }
    await ref.set(doc);
    await recomputeChildcareProviderVisibility(args.uid, { db, now }).catch(() => {});
    await logAudit({
      eventType: "childcare_screening_invitation_sent",
      userId: args.uid,
      data: { jurisdiction: state, candidateReused: !!existingCandidateId, channel: "linq" },
    }).catch(() => {});

    return {
      ok: true,
      mode: "invitation_sent",
      evidenceStatus: "pending",
      invitationUrl: invitation.invitationUrl,
      approvalPending: true,
    };
  } catch (err) {
    console.error(
      "[childcareCaregiverEnrollment] screening start failed (funnel still replies):",
      err instanceof Error ? err.message : err,
    );
    return deny("screening_error");
  }
}
