// U6 matching gate tests (plan 2026-07-22-002 — R33/R34/R45/KTD11/AE12/AE13).
//
// Scenarios: hard eligibility precedes scoring (expired provider excluded;
// policy drift mid-flow excluded; recheck error fails closed per candidate);
// age-band/category/transport/distance/availability fit; transport admits
// ONLY MVR-evidence-capable providers; exact public field sets for jobs and
// applications; child-sensitive payload assertion; sanitized explanations;
// no-eligible-results is empty, not an error; childcare intake delegate maps
// to the senior ScoredMatch shape with zero senior-derived features.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (U3 pattern + dotted-path where filters) ────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, path: string): unknown =>
    path.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
    }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(
          ([p]) =>
            p.startsWith(`${collPath}/`) &&
            p.split("/").length === collPath.split("/").length + 1,
        )
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, _raw: d }))
        .filter((r) => filters.every((f) => valueAt(r._raw, f.field) === f.value));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${docs.size}`}`),
      where: q.where,
      limit: q.limit,
      get: q.get,
    };
  };

  return { docs, makeCollRef, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({ collection: (p: string) => hoisted.makeCollRef(p) });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

// providerEligibility is mocked so the R29 seam is controllable per test.
const recheckMock = vi.hoisted(() => vi.fn());
const loadProfileMock = vi.hoisted(() => vi.fn());
vi.mock("./providerEligibility", () => ({
  recheckChildcareProviderEligibility: recheckMock,
  loadChildcareVerticalProfile: loadProfileMock,
}));

import {
  CHILDCARE_JOB_OPEN_STATUS,
  CHILDCARE_JOB_PUBLIC_FIELDS,
  CHILDCARE_APPLICATION_PUBLIC_FIELDS,
  MAX_CHILDCARE_MATCH_DISTANCE_MILES,
  assertChildSafeOutboundPayload,
  evaluateChildcareJobFit,
  filterEligibleChildcareCandidates,
  rankEligibleChildcareCandidates,
  projectChildcareJobPublic,
  projectChildcareApplicationPublic,
  computeChildcareMatchesForIntake,
  isChildcareVerticalDoc,
  jobScheduleToOverlapShape,
  matchingSourceBelongsToAssignment,
  resolveMatchingSourceContract,
  type ChildcareJobFitTarget,
  type ChildcareCandidateFacts,
} from "./matchingEligibility";

describe("matching source binding", () => {
  it("requires an exact vertical-specific source for child assignments", () => {
    expect(resolveMatchingSourceContract({
      careVertical: "child",
      clientId: "family-1",
    })).toBeNull();
    expect(resolveMatchingSourceContract({
      careVertical: "child",
      sourceRef: "job_posts/child-job-1",
    })).toEqual({
      careVertical: "child",
      collection: "job_posts",
      id: "child-job-1",
    });
    expect(resolveMatchingSourceContract({
      careVertical: "child",
      sourceRef: "caregivers/cg-1",
    })).toBeNull();
  });

  it("keeps latest-intake fallback senior-only", () => {
    expect(resolveMatchingSourceContract({ careVertical: "senior" })).toEqual({
      careVertical: "senior",
      legacyLatest: true,
    });
    expect(resolveMatchingSourceContract({ intakeId: "senior-intake-1" })).toEqual({
      careVertical: "senior",
      collection: "clientIntakes",
      id: "senior-intake-1",
    });
  });

  it("rejects cross-user and cross-vertical source documents", () => {
    const child = resolveMatchingSourceContract({
      careVertical: "child",
      sourceRef: "job_posts/child-job-1",
    })!;
    expect(matchingSourceBelongsToAssignment(child, {
      careVertical: "child",
      clientId: "family-1",
    }, "family-1")).toBe(true);
    expect(matchingSourceBelongsToAssignment(child, {
      careVertical: "senior",
      clientId: "family-1",
    }, "family-1")).toBe(false);
    expect(matchingSourceBelongsToAssignment(child, {
      careVertical: "child",
      clientId: "other-family",
    }, "family-1")).toBe(false);
  });
});

const ELIGIBLE = (transport = false) => ({
  eligible: true,
  issues: [],
  eligibilityVersion: "childcare-provider-eligibility-test",
  evidenceVersion: 3,
  capabilities: { transport },
  evidenceLabels: ["background_check_current"],
  renewal: { expiresAt: null, due: false, overdue: false },
});

const INELIGIBLE = (code: string) => ({
  eligible: false,
  issues: [{ code, field: "x", detail: "d" }],
  eligibilityVersion: "childcare-provider-eligibility-test",
  evidenceVersion: 3,
  capabilities: { transport: false },
  evidenceLabels: [],
  renewal: { expiresAt: null, due: false, overdue: false },
});

const JOB: ChildcareJobFitTarget = {
  ageBands: ["toddler", "preschool"],
  serviceCategories: ["babysitting"],
  transportRequired: false,
  approxLat: 37.33,
  approxLng: -121.89,
  schedule: { days: ["monday", "wednesday"], timeOfDay: ["afternoon"] },
};

const FACTS = (over: Partial<ChildcareCandidateFacts> = {}): ChildcareCandidateFacts => ({
  caregiverUid: "cg-1",
  ageBands: ["toddler", "preschool", "school_age"],
  services: ["babysitting", "date_night_care"],
  transportCapable: false,
  lat: 37.34,
  lng: -121.9,
  weeklyAvailability: {
    monday: [{ start: "12:00", end: "18:00" }],
    wednesday: [{ start: "12:00", end: "18:00" }],
  },
  yearsChildcareExperience: 4,
  ...over,
});

beforeEach(() => {
  hoisted.reset();
  recheckMock.mockReset();
  loadProfileMock.mockReset();
});

// ── Pure fit checks ──────────────────────────────────────────────────────────

describe("evaluateChildcareJobFit", () => {
  it("fits a fully capable candidate", () => {
    const fit = evaluateChildcareJobFit(JOB, FACTS());
    expect(fit.fits).toBe(true);
    expect(fit.issues).toEqual([]);
    expect(fit.distanceMiles).toBeLessThan(5);
    expect(fit.availabilityOverlap).toBeGreaterThan(0);
  });

  it("excludes an uncovered age band (multiple children/age bands)", () => {
    const fit = evaluateChildcareJobFit(JOB, FACTS({ ageBands: ["toddler"] }));
    expect(fit.fits).toBe(false);
    expect(fit.issues).toContain("age_band_uncovered");
  });

  it("excludes an uncovered service category", () => {
    const fit = evaluateChildcareJobFit(JOB, FACTS({ services: ["date_night_care"] }));
    expect(fit.issues).toContain("category_uncovered");
  });

  it("AE13: transport-required job excludes providers without transport capability", () => {
    const job = { ...JOB, transportRequired: true };
    expect(evaluateChildcareJobFit(job, FACTS({ transportCapable: false })).issues)
      .toContain("transport_capability_missing");
    expect(evaluateChildcareJobFit(job, FACTS({ transportCapable: true })).fits).toBe(true);
  });

  it("excludes on distance beyond the cap", () => {
    // ~7 degrees of latitude away — far beyond 25 miles.
    const fit = evaluateChildcareJobFit(JOB, FACTS({ lat: 44.0, lng: -121.89 }));
    expect(fit.issues).toContain("distance_exceeded");
    expect(MAX_CHILDCARE_MATCH_DISTANCE_MILES).toBe(25);
  });

  it("excludes on a hard availability conflict (zero overlap)", () => {
    const fit = evaluateChildcareJobFit(
      JOB,
      FACTS({ weeklyAvailability: { friday: [{ start: "08:00", end: "10:00" }] } }),
    );
    expect(fit.issues).toContain("availability_conflict");
  });

  it("missing coords/schedule never fabricate a conflict — stated requirements still enforced", () => {
    const fit = evaluateChildcareJobFit(
      { ...JOB, approxLat: null, approxLng: null, schedule: null },
      FACTS({ lat: undefined, lng: undefined, weeklyAvailability: undefined }),
    );
    expect(fit.fits).toBe(true);
  });

  it("jobScheduleToOverlapShape maps coarse days/timeOfDay to the scorer shape", () => {
    expect(jobScheduleToOverlapShape({ days: ["Monday"], timeOfDay: ["Afternoon"] }))
      .toEqual({ monday: ["afternoon"] });
    expect(jobScheduleToOverlapShape({ days: [], timeOfDay: ["afternoon"] })).toBeNull();
    expect(jobScheduleToOverlapShape(null)).toBeNull();
  });
});

// ── Hard filter (eligibility BEFORE fit/scoring) ─────────────────────────────

describe("filterEligibleChildcareCandidates (KTD11)", () => {
  const loadFacts = async (uid: string) => FACTS({ caregiverUid: uid });

  it("expired provider is excluded (discovery/application/interview contexts share the seam)", async () => {
    recheckMock.mockImplementation(async (uid: string) =>
      uid === "cg-expired" ? INELIGIBLE("screening_expired") : ELIGIBLE(),
    );
    for (const context of ["discovery", "application", "interview"] as const) {
      const result = await filterEligibleChildcareCandidates({
        jobFit: JOB,
        candidateUids: ["cg-expired", "cg-ok"],
        context,
        loadFacts,
      });
      expect(result.eligible.map((c) => c.caregiverUid)).toEqual(["cg-ok"]);
      expect(result.excludedCount).toBe(1);
    }
    // The recheck context is passed through verbatim (R29 seam contexts).
    expect(recheckMock).toHaveBeenCalledWith("cg-expired", expect.objectContaining({ context: "discovery" }));
    expect(recheckMock).toHaveBeenCalledWith("cg-ok", expect.objectContaining({ context: "interview" }));
  });

  it("policy change mid-flow (eligibility version drift) excludes at the recheck", async () => {
    recheckMock.mockResolvedValue(INELIGIBLE("policy_acceptance_stale"));
    const result = await filterEligibleChildcareCandidates({
      jobFit: JOB,
      candidateUids: ["cg-1"],
      context: "application",
      loadFacts,
    });
    expect(result.eligible).toEqual([]);
    expect(result.excludedCount).toBe(1);
  });

  it("a recheck error fails closed for that candidate (never admits)", async () => {
    recheckMock.mockImplementation(async (uid: string) => {
      if (uid === "cg-err") throw new Error("firestore down");
      return ELIGIBLE();
    });
    const result = await filterEligibleChildcareCandidates({
      jobFit: JOB,
      candidateUids: ["cg-err", "cg-ok"],
      context: "discovery",
      loadFacts,
    });
    expect(result.eligible.map((c) => c.caregiverUid)).toEqual(["cg-ok"]);
  });

  it("transport capability comes from the ELIGIBILITY result (MVR-evidence), not self-declared facts", async () => {
    recheckMock.mockImplementation(async (uid: string) => ELIGIBLE(uid === "cg-mvr"));
    const result = await filterEligibleChildcareCandidates({
      jobFit: { ...JOB, transportRequired: true },
      candidateUids: ["cg-mvr", "cg-selfclaimed"],
      context: "discovery",
      // Both candidates CLAIM transport in their facts; only cg-mvr has the
      // MVR-evidence-backed capability from eligibility.
      loadFacts: async (uid) => FACTS({ caregiverUid: uid, transportCapable: true }),
    });
    expect(result.eligible.map((c) => c.caregiverUid)).toEqual(["cg-mvr"]);
  });

  it("no eligible results is an EMPTY set, not an error", async () => {
    recheckMock.mockResolvedValue(INELIGIBLE("manual_approval_missing"));
    const result = await filterEligibleChildcareCandidates({
      jobFit: JOB,
      candidateUids: ["a", "b", "c"],
      context: "discovery",
      loadFacts,
    });
    expect(result.eligible).toEqual([]);
    expect(result.excludedCount).toBe(3);
  });
});

// ── Ranking (approved features, sanitized reasons) ───────────────────────────

describe("rankEligibleChildcareCandidates", () => {
  it("scores eligible candidates and sorts descending with sanitized reasons", async () => {
    recheckMock.mockResolvedValue(ELIGIBLE());
    const { eligible } = await filterEligibleChildcareCandidates({
      jobFit: JOB,
      candidateUids: ["near", "far"],
      context: "discovery",
      loadFacts: async (uid) =>
        FACTS(uid === "far" ? { caregiverUid: uid, lat: 37.5, lng: -122.0 } : { caregiverUid: uid }),
    });
    const ranked = rankEligibleChildcareCandidates(JOB, eligible);
    expect(ranked.map((r) => r.caregiverId)).toEqual(["near", "far"]);
    for (const r of ranked) {
      // Explanations are allowlisted scorer phrases — no eligibility codes,
      // no evidence, no child facts (spot-check for prohibited substrings).
      for (const reason of r.reasons) {
        expect(reason).not.toMatch(/screening|checkr|custody|pickup|allerg|address|child_/i);
      }
    }
  });
});

// ── Public projections (exact field sets — R33/AE12) ─────────────────────────

const RAW_JOB_DOC = {
  careVertical: "child",
  clientId: "family-1",
  source: "childcare_callable",
  title: "Childcare for 2 children",
  status: CHILDCARE_JOB_OPEN_STATUS,
  disclosurePhase: "public_listing",
  childRequirements: {
    childCount: 2,
    ageBands: ["preschool", "toddler"],
    serviceCategories: ["babysitting"],
    requiredCredentials: ["cpr_first_aid"],
    transportRequired: false,
  },
  schedule: { startDate: "2026-08-01", days: ["monday"], timeOfDay: ["afternoon"], daysPerWeek: 1, frequency: "weekly" },
  rate: 28,
  rateFlexible: false,
  areaLabel: "San Jose, CA",
  approxLat: 37.33,
  approxLng: -121.89,
  jurisdictionState: "CA",
  policyVersion: "ca-2026-07",
  matchingVersion: "childcare-matching-test",
  applicantCount: 1,
  notifiedCount: 4,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

describe("public projections (R33/AE12 — exact field sets)", () => {
  it("job projection exposes EXACTLY the public field set", () => {
    const projection = projectChildcareJobPublic("job-1", RAW_JOB_DOC);
    expect(Object.keys(projection).sort()).toEqual([...CHILDCARE_JOB_PUBLIC_FIELDS].sort());
    // Internal fields never leak:
    expect(projection).not.toHaveProperty("clientId");
    expect(projection).not.toHaveProperty("policyVersion");
    expect(projection).not.toHaveProperty("notifiedCount");
    // AE12: bands + approximate area, never identifying detail.
    expect(projection.ageBands).toEqual(["preschool", "toddler"]);
    expect(projection.areaLabel).toBe("San Jose, CA");
  });

  it("application projection exposes EXACTLY the public field set", () => {
    const projection = projectChildcareApplicationPublic("app-1", {
      careVertical: "child",
      jobId: "job-1",
      caregiverId: "cg-1",
      clientId: "family-1",
      status: "pending",
      disclosurePhase: "application",
      appliedAt: "2026-07-23T00:00:00.000Z",
      jobTitle: "Childcare for 2 children",
      areaLabel: "San Jose, CA",
      rate: 28,
      rateFlexible: false,
      eligibilityVersion: "v",
      evidenceVersion: 3,
    });
    expect(Object.keys(projection).sort()).toEqual([...CHILDCARE_APPLICATION_PUBLIC_FIELDS].sort());
    expect(projection).not.toHaveProperty("clientId");
    expect(projection).not.toHaveProperty("eligibilityVersion");
    expect(projection).not.toHaveProperty("phone");
  });

  it("assertChildSafeOutboundPayload rejects every prohibited key, nested and in arrays", () => {
    const bads = [
      { childName: "Ava" },
      { nested: { exactAddress: "1 Main St" } },
      { list: [{ custodyNotes: "x" }] },
      { pickup: "gate 3" },
      { emergencyContacts: [] },
      { allergies: ["peanut"] },
      { dateOfBirth: "2020-01-01" },
      { phone: "+15550001111" },
      { displayLabel: "A." },
    ];
    for (const bad of bads) {
      expect(() => assertChildSafeOutboundPayload(bad, "test")).toThrow(/prohibited key/);
    }
    // The real job doc passes by construction.
    expect(() => assertChildSafeOutboundPayload(RAW_JOB_DOC, "test")).not.toThrow();
  });

  it("isChildcareVerticalDoc guards typed-vertical branching", () => {
    expect(isChildcareVerticalDoc(RAW_JOB_DOC)).toBe(true);
    expect(isChildcareVerticalDoc({ status: "open" })).toBe(false);
    expect(isChildcareVerticalDoc(null)).toBe(false);
  });
});

// ── Intake delegate (the matchJob/aiMatching guarded-branch target) ──────────

describe("computeChildcareMatchesForIntake", () => {
  it("retrieves candidates server-side, hard-filters, and maps to the senior ScoredMatch shape", async () => {
    hoisted.docs.set("caregivers/cg-visible", {
      childcareProvider: { visible: true },
      latitude: 37.34,
      longitude: -121.9,
      weeklyAvailability: { monday: [{ start: "12:00", end: "18:00" }] },
    });
    hoisted.docs.set("caregivers/cg-stale", {
      childcareProvider: { visible: true }, // stale summary — recheck says no
      latitude: 37.34,
      longitude: -121.9,
    });
    hoisted.docs.set("caregivers/cg-hidden", { childcareProvider: { visible: false } });

    recheckMock.mockImplementation(async (uid: string) =>
      uid === "cg-visible" ? ELIGIBLE() : INELIGIBLE("screening_expired"),
    );
    loadProfileMock.mockImplementation(async (uid: string) =>
      uid === "cg-hidden"
        ? null
        : { ageBands: ["toddler", "preschool"], services: ["babysitting"], yearsChildcareExperience: 4 },
    );

    const matches = await computeChildcareMatchesForIntake("intake-1", {
      careVertical: "child",
      childRequirements: { ageBands: ["toddler"], serviceCategories: ["babysitting"], transportRequired: false },
      approxLat: 37.33,
      approxLng: -121.89,
      schedule: { days: ["monday"], timeOfDay: ["afternoon"] },
    });

    // A STALE derived summary cannot admit — the recheck is authoritative.
    expect(matches.map((m) => m.caregiverId)).toEqual(["cg-visible"]);
    const m = matches[0];
    // Senior ScoredMatch shape, zero senior-derived features.
    expect(m.semanticScore).toBe(0);
    expect(m.redFlags).toEqual([]);
    expect(m.source).toBe("fallback");
    expect(m.score).toBeGreaterThan(0);
    expect(Object.keys(m).sort()).toEqual([
      "availabilityScore", "caregiverId", "confidence", "distanceScore",
      "experienceScore", "hardSkillsScore", "ratingScore", "reasons",
      "redFlags", "score", "semanticScore", "source",
    ]);
  });

  it("returns an empty list (not an error) when nobody is eligible", async () => {
    hoisted.docs.set("caregivers/cg-1", { childcareProvider: { visible: true } });
    recheckMock.mockResolvedValue(INELIGIBLE("manual_approval_missing"));
    const matches = await computeChildcareMatchesForIntake("intake-2", {
      careVertical: "child",
      childRequirements: { ageBands: [], serviceCategories: [], transportRequired: false },
    });
    expect(matches).toEqual([]);
  });
});
