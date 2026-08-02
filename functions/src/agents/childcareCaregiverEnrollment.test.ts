// Front door STAGE 2 — the U5 wiring at funnel completion.
//
// Pins the invariants the SMS funnel must not be able to weaken, because it
// reaches the U5 server side directly instead of through the callable's App
// Check / Auth guards:
//   • the SAME document, at the SAME path, with the SAME schema the callable
//     writes (one enrollment regardless of surface);
//   • MANUAL approval is still required — a funnel turn can never grant it, and
//     Checkr "clear" never auto-approves (R27/R28);
//   • deferred categories are hard-blocked (U1 policy);
//   • screening runs on the SHARED base Checkr package (R26 as amended), with
//     Checkr candidate reuse and shared-base-report ADOPTION (AE21);
//   • consent-first: no Checkr call without an explicit consent;
//   • R24/R-FD6 — no senior field is written, and no senior verdict (approval,
//     verificationStatus, rating) crosses into the childcare vertical.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

import { makeFakeDb, type FakeDb } from "../childcare/__tests__/fakeFirestore";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { basePackage } from "../mvrConfig";
import {
  CHILDCARE_PROVIDER_SUMMARY_FIELD,
} from "../childcare/providerEligibility";
import {
  ensureChildcareCaregiverBaseDoc,
  startChildcareCaregiverScreening,
  upsertChildcareCaregiverProfileFromFunnel,
} from "./childcareCaregiverEnrollment";

const UID = "cg-enroll-1";
const PHONE = "+15550003333";
const PROFILE_PATH = `caregivers/${UID}/vertical_profiles/child`;
const SCREENING_PATH = `caregivers/${UID}/screenings/child`;
const NOW = new Date("2026-07-25T12:00:00.000Z");
const FLAGS_ON = {
  CHILDCARE_ENABLED: true,
  CHILDCARE_DISCOVERY_ENABLED: true,
  CHILDCARE_WRITES_ENABLED: true,
  CHILDCARE_PROACTIVE_ENABLED: false,
};

/** A senior-onboarded caregiver, complete with senior VERDICTS. */
const SENIOR_CAREGIVER = {
  uid: UID,
  name: "Maria Lopez",
  email: "maria@example.com",
  city: "San Jose",
  state: "CA",
  availability: { days: ["mon"], hours: "mornings" },
  hourlyRate: 30,
  specialties: ["dementia"],
  skills: ["dementia"],
  jobType: "part_time",
  bio: "Six years with dementia clients.",
  status: "active",
  onboardingStatus: "profile_complete",
  verificationStatus: "verified",
  rating: 4.9,
  reviewCount: 22,
  membershipPaid: true,
  stripeAccountId: "acct_1",
  payoutsEnabled: true,
};

const COLLECTED = {
  name: "Maria Lopez",
  city: "San Jose",
  email: "maria@example.com",
  yearsChildcareExperience: 6,
  childcareAgeBands: ["toddler", "school_age"],
  childcareServices: ["nanny_care", "after_school_care"],
  childcareCredentials: ["cpr", "first_aid"],
  adultAgeAttested: true,
  childcareTransport: true,
  availability: { days: ["mon"], hours: "mornings" },
  jobType: "nanny",
  hourlyRate: 34,
  bio: "Calm and steady with kids.",
};

function armed(extra: Record<string, Record<string, unknown>> = {}): FakeDb {
  return makeFakeDb({
    "childcare_flags/global": FLAGS_ON,
    [`caregivers/${UID}`]: { ...SENIOR_CAREGIVER },
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bustChildcareFlagsCache();
});

// ── Vertical profile upsert ──────────────────────────────────────────────────

describe("upsertChildcareCaregiverProfileFromFunnel", () => {
  it("writes the U5 vertical-profile document, at the U5 path, with the U5 schema", async () => {
    const fake = armed();
    const r = await upsertChildcareCaregiverProfileFromFunnel({
      uid: UID, collected: COLLECTED, db: fake.db, now: NOW,
    });
    expect(r.ok).toBe(true);
    const doc = fake.get(PROFILE_PATH)!;
    expect(doc).toMatchObject({
      careVertical: "child",
      caregiverUid: UID,
      ageBands: ["toddler", "school_age"],
      services: ["nanny_care", "after_school_care"],
      yearsChildcareExperience: 6,
      hourlyRate: 34,
      jurisdictionState: "CA",
      adultAgeAttested: true,
      transport: { offersTransport: true },
      profileVersion: 1,
    });
    expect(doc.credentials).toEqual([
      { type: "cpr", issuedOn: null, expiresOn: null, reference: null },
      { type: "first_aid", issuedOn: null, expiresOn: null, reference: null },
    ]);
  });

  it("MANUAL approval is never granted by a funnel turn (R27/R28)", async () => {
    const fake = armed();
    const r = await upsertChildcareCaregiverProfileFromFunnel({
      uid: UID, collected: COLLECTED, db: fake.db, now: NOW,
    });
    expect(r.approvalPending).toBe(true);
    expect(fake.get(PROFILE_PATH)!.approval).toEqual({
      state: "none", decidedByUid: null, decidedAt: null, auditRef: null,
    });
    // ...and the derived visibility summary the projection reads is NOT visible.
    const summary = fake.get(`caregivers/${UID}`)![CHILDCARE_PROVIDER_SUMMARY_FIELD] as Record<string, unknown>;
    expect(summary.visible).toBe(false);
    expect(summary.approvalState).toBe("none");
  });

  it("an existing operator decision and suspension are PRESERVED, never rewritten", async () => {
    const fake = armed({
      [PROFILE_PATH]: {
        careVertical: "child", caregiverUid: UID, profileVersion: 4,
        approval: { state: "approved", decidedByUid: "op-1", decidedAt: "2026-07-01T00:00:00.000Z", auditRef: "ref-1" },
        suspension: { active: true, code: "operator_suspension", suspendedByUid: "op-2", suspendedAt: "2026-07-02T00:00:00.000Z" },
        acceptedPolicyVersion: "ca-old", acceptedPolicyAt: "2026-07-01T00:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    const doc = fake.get(PROFILE_PATH)!;
    expect(doc.approval).toMatchObject({ state: "approved", decidedByUid: "op-1" });
    expect(doc.suspension).toMatchObject({ active: true, suspendedByUid: "op-2" });
    expect(doc.profileVersion).toBe(5);
    expect(doc.createdAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("DEFERRED categories are refused, reported, and never stored", async () => {
    const fake = armed();
    const r = await upsertChildcareCaregiverProfileFromFunnel({
      uid: UID, db: fake.db, now: NOW,
      collected: {
        ...COLLECTED,
        childcareAgeBands: ["infant", "toddler"],
        childcareServices: ["nanny_care", "overnight_care", "medication_administration"],
      },
    });
    expect(r.refusedCategories.sort()).toEqual(
      ["infant_care", "medication_administration", "overnight_care"],
    );
    const doc = fake.get(PROFILE_PATH)!;
    expect(doc.ageBands).toEqual(["toddler"]);
    expect(doc.services).toEqual(["nanny_care"]);
  });

  it("R24: NOT ONE senior field on the parent doc changes (only the namespaced summary)", async () => {
    const fake = armed();
    const before = { ...(fake.get(`caregivers/${UID}`) as Record<string, unknown>) };
    await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    const after = fake.get(`caregivers/${UID}`) as Record<string, unknown>;
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    expect(changed).toEqual([CHILDCARE_PROVIDER_SUMMARY_FIELD]);
    // The childcare rate did NOT overwrite the senior rate — two independent
    // numbers, which is the whole point of R-FD6.
    expect(after.hourlyRate).toBe(30);
    expect(fake.get(PROFILE_PATH)!.hourlyRate).toBe(34);
  });

  it("R-FD6: no senior VERDICT crosses into the vertical profile", async () => {
    const fake = armed();
    await upsertChildcareCaregiverProfileFromFunnel({
      uid: UID, db: fake.db, now: NOW,
      // Even if the collected bag somehow carried senior verdicts, the doc shape
      // has nowhere to put them.
      collected: { ...COLLECTED, verificationStatus: "verified", rating: 4.9, approval: { state: "approved" } },
    });
    const doc = fake.get(PROFILE_PATH)!;
    expect(doc.verificationStatus).toBeUndefined();
    expect(doc.rating).toBeUndefined();
    expect((doc.approval as Record<string, unknown>).state).toBe("none");
    expect(doc.services).not.toContain("dementia");
  });

  it("R61: flags off, writes off, or a missing account all fail CLOSED", async () => {
    const noFlags = makeFakeDb({ [`caregivers/${UID}`]: { ...SENIOR_CAREGIVER } });
    expect((await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: noFlags.db, now: NOW })).reason)
      .toBe("childcare_disabled");
    expect(noFlags.get(PROFILE_PATH)).toBeUndefined();

    bustChildcareFlagsCache();
    const readOnly = makeFakeDb({
      "childcare_flags/global": { ...FLAGS_ON, CHILDCARE_WRITES_ENABLED: false },
      [`caregivers/${UID}`]: { ...SENIOR_CAREGIVER },
    });
    expect((await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: readOnly.db, now: NOW })).reason)
      .toBe("childcare_disabled");

    bustChildcareFlagsCache();
    const noAccount = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    expect((await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: noAccount.db, now: NOW })).reason)
      .toBe("no_caregiver_account");
  });

  it("R23: a versionless jurisdiction policy is NOT accepted on the caregiver's behalf", async () => {
    const fake = armed();
    const r = await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    expect(r.acceptedPolicyVersion).toBeNull();
    expect(fake.get(PROFILE_PATH)!.acceptedPolicyVersion).toBeNull();
    expect([...fake.docs.keys()].some((p) => p.startsWith("consent_receipts/"))).toBe(false);
  });

  it("a versioned policy IS accepted, with a versioned SMS consent receipt (R23)", async () => {
    const fake = armed({
      "jurisdiction_care_policies/CA": { state: "CA", policyVersion: "ca-2026.1" },
    });
    const r = await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    expect(r.acceptedPolicyVersion).toBe("ca-2026.1");
    expect(fake.get(PROFILE_PATH)).toMatchObject({
      acceptedPolicyVersion: "ca-2026.1",
      acceptedPolicyAt: NOW.toISOString(),
    });
    const receipts = [...fake.docs.entries()].filter(([p]) => p.startsWith("consent_receipts/"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0][1]).toMatchObject({ policyType: "childcarePolicy", channel: "sms" });
  });

  it("AE21: the result names the reused base fields so no surface re-asks them", async () => {
    const fake = armed();
    const r = await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    for (const reused of ["name", "email", "city", "state", "availability"]) {
      expect(r.reusedBaseFields).toContain(reused);
    }
    expect(r.missingBaseFields).not.toContain("name");
  });
});

// ── Base account for a childcare-first caregiver ─────────────────────────────

describe("ensureChildcareCaregiverBaseDoc", () => {
  it("creates identity/contact/logistics only — never senior capability or approval", async () => {
    const fake = makeFakeDb({ "childcare_flags/global": FLAGS_ON });
    const r = await ensureChildcareCaregiverBaseDoc({
      phone: PHONE,
      collected: { name: "Ana Diaz", email: "ana@x.com", city: "San Jose", availability: "weekdays", hourlyRate: 26, childcareServices: ["nanny_care"] },
      db: fake.db, now: NOW,
      resolveAuthUid: async () => UID,
    });
    expect(r).toMatchObject({ uid: UID, created: true });
    const doc = fake.get(`caregivers/${UID}`)!;
    expect(doc).toMatchObject({
      uid: UID, phone: PHONE, name: "Ana Diaz", email: "ana@x.com",
      city: "San Jose", state: "CA", status: "onboarding", onboardingStatus: "in_progress",
    });
    // R24/R-FD6: the childcare rate and childcare services never land in the
    // senior namespace, and no verdict is invented.
    for (const forbidden of ["hourlyRate", "services", "skills", "specialties", "jobType", "verificationStatus", "rating"]) {
      expect(doc[forbidden]).toBeUndefined();
    }
  });

  it("never demotes an already-progressed caregiver account", async () => {
    const fake = makeFakeDb({ [`caregivers/${UID}`]: { uid: UID, status: "active", verificationStatus: "verified" } });
    await ensureChildcareCaregiverBaseDoc({
      phone: PHONE, collected: { name: "Maria" }, existingUid: UID, db: fake.db, now: NOW,
    });
    const doc = fake.get(`caregivers/${UID}`)!;
    expect(doc.status).toBe("active");
    expect(doc.verificationStatus).toBe("verified");
  });

  it("fails closed when no auth uid can be resolved", async () => {
    const fake = makeFakeDb();
    const r = await ensureChildcareCaregiverBaseDoc({
      phone: PHONE, collected: {}, db: fake.db, now: NOW, resolveAuthUid: async () => null,
    });
    expect(r).toEqual({ uid: null, created: false, reason: "no_auth_uid" });
    expect([...fake.docs.keys()].filter((p) => p.startsWith("caregivers/"))).toEqual([]);
  });
});

// ── Screening ────────────────────────────────────────────────────────────────

describe("startChildcareCaregiverScreening", () => {
  const withProfile = (extra: Record<string, Record<string, unknown>> = {}, caregiver = SENIOR_CAREGIVER) =>
    makeFakeDb({
      "childcare_flags/global": FLAGS_ON,
      [`caregivers/${UID}`]: { ...caregiver },
      [PROFILE_PATH]: { careVertical: "child", caregiverUid: UID, jurisdictionState: "CA" },
      ...extra,
    });

  it("CONSENT-FIRST: no consent means no Checkr call, ever", async () => {
    const fake = withProfile();
    const createInvitation = vi.fn(async () => ({ candidateId: "c1", invitationUrl: "u" }));
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: false, db: fake.db, now: NOW, createInvitation,
    });
    expect(r).toMatchObject({ ok: false, mode: "consent_required" });
    expect(createInvitation).not.toHaveBeenCalled();
    expect(fake.get(SCREENING_PATH)).toBeUndefined();
  });

  it("uses the SHARED BASE Checkr package and reuses the existing candidate (R26 amended)", async () => {
    const fake = withProfile({}, { ...SENIOR_CAREGIVER, backgroundCheckData: { checkrCandidateId: "cand_existing" } } as never);
    const createInvitation = vi.fn(async (_args: Record<string, unknown>) => ({ candidateId: "cand_existing", invitationUrl: "https://apply/1" }));
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW, createInvitation,
    });
    expect(r).toMatchObject({ ok: true, mode: "invitation_sent", evidenceStatus: "pending", approvalPending: true });
    expect(createInvitation).toHaveBeenCalledTimes(1);
    const args = createInvitation.mock.calls[0][0];
    expect(args.packageSlug).toBe(basePackage());
    expect(args.candidateId).toBe("cand_existing"); // never a duplicate candidate
    expect(args.customId).toBe(UID);
    expect(args.workState).toBe("CA");
    const doc = fake.get(SCREENING_PATH)!;
    expect(doc).toMatchObject({
      careVertical: "child", packageSlug: basePackage(),
      packageRef: "shared-base-package", evidenceStatus: "pending",
      jurisdictionState: "CA",
    });
  });

  it("AE21: a current shared-base clear report is ADOPTED — no duplicate check is run", async () => {
    const fake = withProfile({}, {
      ...SENIOR_CAREGIVER,
      backgroundCheckData: {
        status: "clear",
        completedAt: "2026-06-01T00:00:00.000Z",
        checkrCandidateId: "cand_1",
        checkrReportId: "rep_1",
        mvrIncluded: false,
      },
    } as never);
    const createInvitation = vi.fn(async () => ({ candidateId: "x", invitationUrl: "y" }));
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW, createInvitation,
    });
    expect(r).toMatchObject({ ok: true, mode: "base_evidence_adopted", evidenceStatus: "clear" });
    expect(createInvitation).not.toHaveBeenCalled();
    expect(fake.get(SCREENING_PATH)).toMatchObject({
      evidenceStatus: "clear",
      evidenceSource: "shared_base_report_adoption",
      packageSlug: basePackage(),
    });
  });

  it("a BUNDLED criminal+MVR base report is NOT adopted (package policy mismatch)", async () => {
    const fake = withProfile({}, {
      ...SENIOR_CAREGIVER,
      backgroundCheckData: {
        status: "clear", completedAt: "2026-06-01T00:00:00.000Z",
        checkrCandidateId: "cand_1", mvrIncluded: true,
      },
    } as never);
    const createInvitation = vi.fn(async () => ({ candidateId: "cand_1", invitationUrl: "u" }));
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW, createInvitation,
    });
    expect(r.mode).toBe("invitation_sent");
    expect(createInvitation).toHaveBeenCalledTimes(1);
  });

  it("never mints a racing duplicate while an invitation is outstanding", async () => {
    const fake = withProfile({
      [SCREENING_PATH]: {
        careVertical: "child", caregiverUid: UID, jurisdictionState: "CA",
        packageSlug: basePackage(), evidenceStatus: "pending",
        checkr: { invitationStatus: "sent" }, eligibilityVersion: 1,
      },
    });
    const createInvitation = vi.fn(async () => ({ candidateId: "x", invitationUrl: "y" }));
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW, createInvitation,
    });
    expect(r.mode).toBe("invitation_outstanding");
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("clear evidence NEVER approves — approvalPending stays true and visibility stays false", async () => {
    const fake = withProfile({}, {
      ...SENIOR_CAREGIVER,
      backgroundCheckData: {
        status: "clear", completedAt: "2026-06-01T00:00:00.000Z",
        checkrCandidateId: "cand_1", mvrIncluded: false,
      },
    } as never);
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW,
      createInvitation: async () => ({ candidateId: "x", invitationUrl: "y" }),
    });
    expect(r.evidenceStatus).toBe("clear");
    expect(r.approvalPending).toBe(true);
    const summary = fake.get(`caregivers/${UID}`)![CHILDCARE_PROVIDER_SUMMARY_FIELD] as Record<string, unknown>;
    expect(summary.visible).toBe(false);
    expect(summary.approvalState).toBe("none");
    expect(fake.get(PROFILE_PATH)!.approval).toBeUndefined(); // untouched by screening
  });

  it("profile-before-screening, flags, and account guards all fail closed", async () => {
    const noProfile = makeFakeDb({
      "childcare_flags/global": FLAGS_ON, [`caregivers/${UID}`]: { ...SENIOR_CAREGIVER },
    });
    expect((await startChildcareCaregiverScreening({ uid: UID, screeningConsent: true, db: noProfile.db, now: NOW })).mode)
      .toBe("profile_before_screening");

    bustChildcareFlagsCache();
    const noFlags = makeFakeDb({ [`caregivers/${UID}`]: { ...SENIOR_CAREGIVER }, [PROFILE_PATH]: { jurisdictionState: "CA" } });
    expect((await startChildcareCaregiverScreening({ uid: UID, screeningConsent: true, db: noFlags.db, now: NOW })).mode)
      .toBe("childcare_disabled");
  });

  it("a Checkr failure never throws — the funnel must still be able to reply", async () => {
    const fake = withProfile();
    const r = await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW,
      createInvitation: async () => { throw new Error("checkr down"); },
    });
    expect(r).toMatchObject({ ok: false, mode: "screening_error", approvalPending: true });
  });
});

// ── Dual vertical: two independent profiles ─────────────────────────────────

describe("R-FD6 dual vertical: two independent profiles, no bleed", () => {
  it("childcare enrollment leaves senior bookability and ratings untouched", async () => {
    const fake = armed({ "jurisdiction_care_policies/CA": { state: "CA", policyVersion: "ca-2026.1" } });
    await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    await startChildcareCaregiverScreening({
      uid: UID, screeningConsent: true, db: fake.db, now: NOW,
      createInvitation: async () => ({ candidateId: "c", invitationUrl: "u" }),
    });
    const parent = fake.get(`caregivers/${UID}`)!;
    // Senior side: exactly as it was.
    expect(parent).toMatchObject({
      status: "active", onboardingStatus: "profile_complete",
      verificationStatus: "verified", rating: 4.9, reviewCount: 22, hourlyRate: 30,
      specialties: ["dementia"],
    });
    // Childcare side: its own rate, its own screening, its own (absent) approval.
    expect(fake.get(PROFILE_PATH)!.hourlyRate).toBe(34);
    expect(fake.get(SCREENING_PATH)!.careVertical).toBe("child");
    expect((fake.get(PROFILE_PATH)!.approval as Record<string, unknown>).state).toBe("none");
    // And the childcare summary does NOT inherit senior visibility.
    expect((parent[CHILDCARE_PROVIDER_SUMMARY_FIELD] as Record<string, unknown>).visible).toBe(false);
  });

  it("the two verticals live in separate documents (no shared mutable state)", async () => {
    const fake = armed();
    await upsertChildcareCaregiverProfileFromFunnel({ uid: UID, collected: COLLECTED, db: fake.db, now: NOW });
    const childcareDocs = [...fake.docs.keys()].filter((p) => p.startsWith(`caregivers/${UID}/`));
    expect(childcareDocs).toEqual([PROFILE_PATH]);
    // Nothing was written to a senior subcollection.
    expect(childcareDocs.every((p) => p.includes("/vertical_profiles/") || p.includes("/screenings/"))).toBe(true);
  });
});
