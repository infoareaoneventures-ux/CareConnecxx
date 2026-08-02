// U5 (childcare marketplace plan 2026-07-22-002): screening evidence per
// amended R26 — the shared Checkr base package is childcare-accepted, while
// evaluation, renewal, adverse-action state, and eligibility version stay
// independent per vertical. Wrong-package scenarios ARE policy-mismatch
// scenarios. Checkr states are EVIDENCE, never approval (R27/AE10): nothing
// in this module can flip a visibility/approval flag.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CA_PILOT_POLICY_SEED,
  type JurisdictionCarePolicy,
} from "./jurisdictionPolicy";
import {
  adoptableBaseEvidence,
  addMonthsIso,
  applyCheckrEventToChildcareScreening,
  buildScreeningForInvitation,
  buildScreeningFromBaseEvidence,
  computeScreeningRenewal,
  evaluateCredentialRequirements,
  evaluateScreeningEvidence,
  eventMatchesScreening,
  mapReportPayloadToEvidenceStatus,
  nextAdverseActionState,
  CHILDCARE_SCREENING_POLICY_VERSION,
  type ChildcareScreeningDoc,
} from "./screeningPolicy";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const BASE_PKG = "checkrdirect_essential_criminal";

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.CHECKR_PACKAGE = BASE_PKG;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
});

function policy(overrides: Partial<JurisdictionCarePolicy> = {}): Partial<JurisdictionCarePolicy> {
  return { ...CA_PILOT_POLICY_SEED, ...overrides };
}

/** A current, policy-matching, clear screening doc (evidence-current fixture). */
function clearScreening(overrides: Partial<ChildcareScreeningDoc> = {}): ChildcareScreeningDoc {
  return {
    careVertical: "child",
    caregiverUid: "cg-1",
    packageSlug: BASE_PKG,
    packageRef: "shared-base-package",
    jurisdictionState: "CA",
    requiredComponents: [...CA_PILOT_POLICY_SEED.screening.components],
    renewalMonths: 12,
    checkr: {
      candidateId: "cand_1",
      invitationId: "inv_1",
      reportId: "rep_1",
      invitationStatus: "completed",
      invitationExpiresAt: null,
    },
    evidenceStatus: "clear",
    evidenceSource: "checkr_webhook",
    reportCompletedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2027-07-01T00:00:00.000Z",
    adverseAction: { state: "none", updatedAt: null },
    policyVersion: "CA-2026-07-22.1",
    eligibilityVersion: 3,
    appliedEventIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function codes(
  screening: Partial<ChildcareScreeningDoc> | null,
  pol: Partial<JurisdictionCarePolicy> | null = policy(),
): string[] {
  return evaluateScreeningEvidence(screening, pol, { now: NOW }).issues.map((i) => i.code);
}

// ── evaluateScreeningEvidence ────────────────────────────────────────────────

describe("evaluateScreeningEvidence — amended R26 evidence evaluation", () => {
  it("a current, policy-matching, clear screening evaluates with ZERO issues", () => {
    const result = evaluateScreeningEvidence(clearScreening(), policy(), { now: NOW });
    expect(result.issues).toEqual([]);
    expect(result.current).toBe(true);
    expect(result.policyVersion).toBe(CHILDCARE_SCREENING_POLICY_VERSION);
    expect(result.evidenceVersion).toBe(3);
  });

  it("no screening doc → screening_absent (fail closed)", () => {
    expect(codes(null)).toContain("screening_absent");
  });

  it("wrong package = POLICY MISMATCH (bundled MVR / MVR-only / anything non-base)", () => {
    expect(codes(clearScreening({ packageSlug: "checkrdirect_essential_criminal_mvr" }))).toContain(
      "package_policy_mismatch",
    );
    expect(codes(clearScreening({ packageSlug: "mvr_only_pkg" }))).toContain("package_policy_mismatch");
  });

  it("wrong jurisdiction → jurisdiction_mismatch", () => {
    expect(codes(clearScreening({ jurisdictionState: "NV" }))).toContain("jurisdiction_mismatch");
  });

  it("a policy adding a component invalidates old evidence (component_missing — policy change)", () => {
    const stricter = policy({
      screening: {
        ...CA_PILOT_POLICY_SEED.screening,
        components: [...CA_PILOT_POLICY_SEED.screening.components, "child_abuse_registry_search"],
      },
    });
    expect(codes(clearScreening(), stricter)).toContain("component_missing");
  });

  it("clear but past expiry → report_expired (R31)", () => {
    const stale = clearScreening({
      reportCompletedAt: "2025-06-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
    expect(codes(stale)).toContain("report_expired");
  });

  it("pending / consider / suspended / disputed / canceled each carry their own code and none is current", () => {
    expect(codes(clearScreening({ evidenceStatus: "pending" }))).toContain("evidence_pending");
    expect(codes(clearScreening({ evidenceStatus: "consider" }))).toContain("evidence_consider");
    expect(codes(clearScreening({ evidenceStatus: "suspended" }))).toContain("evidence_suspended");
    expect(codes(clearScreening({ evidenceStatus: "disputed" }))).toContain("evidence_disputed");
    expect(codes(clearScreening({ evidenceStatus: "canceled" }))).toContain("evidence_canceled");
    for (const s of ["pending", "consider", "suspended", "disputed", "canceled"] as const) {
      expect(evaluateScreeningEvidence(clearScreening({ evidenceStatus: s }), policy(), { now: NOW }).current).toBe(false);
    }
  });

  it("invitation expiry surfaces while evidence is pending", () => {
    const doc = clearScreening({
      evidenceStatus: "pending",
      checkr: { candidateId: "cand_1", invitationId: "inv_1", reportId: null, invitationStatus: "expired" },
    });
    expect(codes(doc)).toContain("invitation_expired");
  });

  it("ANY active adverse-action state blocks currency (R27 — human process owns it)", () => {
    for (const state of ["pre_adverse", "dispute", "post_adverse"] as const) {
      const doc = clearScreening({ adverseAction: { state, updatedAt: "2026-07-10T00:00:00.000Z" } });
      expect(codes(doc)).toContain("adverse_action_active");
    }
  });

  it("clear NEVER evaluates to an approval — the result carries no approval/visibility field", () => {
    const result = evaluateScreeningEvidence(clearScreening(), policy(), { now: NOW });
    expect(result).not.toHaveProperty("approved");
    expect(result).not.toHaveProperty("visible");
    expect(result).not.toHaveProperty("verificationStatus");
  });
});

// ── Renewal lifecycle ────────────────────────────────────────────────────────

describe("computeScreeningRenewal — annual default + 30-day warning window", () => {
  it("outside the window: not due", () => {
    const r = computeScreeningRenewal(clearScreening({ expiresAt: "2027-07-01T00:00:00.000Z" }), NOW);
    expect(r).toEqual({ expiresAt: "2027-07-01T00:00:00.000Z", due: false, overdue: false });
  });

  it("inside the 30-day window: due but not overdue", () => {
    const r = computeScreeningRenewal(clearScreening({ expiresAt: "2026-08-10T00:00:00.000Z" }), NOW);
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(false);
  });

  it("past expiry: due AND overdue", () => {
    const r = computeScreeningRenewal(clearScreening({ expiresAt: "2026-07-01T00:00:00.000Z" }), NOW);
    expect(r.due).toBe(true);
    expect(r.overdue).toBe(true);
  });

  it("no accepted report: nothing due", () => {
    expect(computeScreeningRenewal(clearScreening({ expiresAt: null }), NOW)).toEqual({
      expiresAt: null, due: false, overdue: false,
    });
  });
});

// ── Credential lifecycle ─────────────────────────────────────────────────────

describe("evaluateCredentialRequirements — jurisdiction credential lifecycle", () => {
  const requiring = policy({
    credentialRules: { requiredCredentials: ["child_safety_cert"], renewalMonths: 24 },
  });

  it("no jurisdiction requirements (CA pilot) ⇒ no issues", () => {
    expect(evaluateCredentialRequirements([], policy(), { now: NOW })).toEqual([]);
  });

  it("missing required credential → credential_missing", () => {
    const issues = evaluateCredentialRequirements([], requiring, { now: NOW });
    expect(issues.map((i) => i.code)).toContain("credential_missing");
  });

  it("expired required credential → credential_expired", () => {
    const issues = evaluateCredentialRequirements(
      [{ type: "child_safety_cert", expiresOn: "2026-01-01T00:00:00.000Z" }],
      requiring,
      { now: NOW },
    );
    expect(issues.map((i) => i.code)).toContain("credential_expired");
  });

  it("current (or unexpiring) required credential passes", () => {
    expect(
      evaluateCredentialRequirements([{ type: "child_safety_cert", expiresOn: "2027-01-01T00:00:00.000Z" }], requiring, { now: NOW }),
    ).toEqual([]);
    expect(
      evaluateCredentialRequirements([{ type: "child_safety_cert", expiresOn: null }], requiring, { now: NOW }),
    ).toEqual([]);
  });
});

// ── Adverse-action state machine ─────────────────────────────────────────────

describe("nextAdverseActionState — FCRA-shaped transitions", () => {
  it("none → pre_adverse → post_adverse", () => {
    expect(nextAdverseActionState("none", "report.pre_adverse_action")).toBe("pre_adverse");
    expect(nextAdverseActionState("pre_adverse", "report.post_adverse_action")).toBe("post_adverse");
  });

  it("dispute is reachable from any state; post_adverse never regresses to pre", () => {
    expect(nextAdverseActionState("pre_adverse", "report.disputed")).toBe("dispute");
    expect(nextAdverseActionState("post_adverse", "report.disputed")).toBe("dispute");
    expect(nextAdverseActionState("post_adverse", "report.pre_adverse_action")).toBe("post_adverse");
  });

  it("unrelated events keep the current state", () => {
    expect(nextAdverseActionState("pre_adverse", "report.updated")).toBe("pre_adverse");
    expect(nextAdverseActionState("none", "invitation.created")).toBe("none");
  });
});

// ── Base-evidence adoption (AE21 / amended R26) ──────────────────────────────

describe("adoptableBaseEvidence — reuse exactly-verified evidence, never re-ask", () => {
  const freshBase = {
    backgroundCheckData: {
      status: "clear",
      completedAt: "2026-06-01T00:00:00.000Z",
      checkrCandidateId: "cand_9",
      checkrReportId: "rep_9",
    },
  };

  it("clear, in-window, base-package report is adoptable", () => {
    const r = adoptableBaseEvidence(freshBase, policy(), { now: NOW });
    expect(r.adoptable).toBe(true);
    expect(r.candidateId).toBe("cand_9");
  });

  it("non-clear base evidence is not adoptable", () => {
    const r = adoptableBaseEvidence(
      { backgroundCheckData: { status: "consider", completedAt: "2026-06-01T00:00:00.000Z" } },
      policy(),
      { now: NOW },
    );
    expect(r).toMatchObject({ adoptable: false, reason: "base_evidence_not_clear" });
  });

  it("bundled criminal+MVR report (mvrIncluded) = package mismatch, NOT adoptable", () => {
    const r = adoptableBaseEvidence(
      { backgroundCheckData: { ...freshBase.backgroundCheckData, mvrIncluded: true } },
      policy(),
      { now: NOW },
    );
    expect(r).toMatchObject({ adoptable: false, reason: "base_evidence_bundled_package_mismatch" });
  });

  it("expired base report (older than the renewal window) is not adoptable", () => {
    const r = adoptableBaseEvidence(
      { backgroundCheckData: { status: "clear", completedAt: "2025-05-01T00:00:00.000Z" } },
      policy(),
      { now: NOW },
    );
    expect(r).toMatchObject({ adoptable: false, reason: "base_evidence_expired" });
  });

  it("adoption builds a CLEAR childcare screening with independent expiry", () => {
    const doc = buildScreeningFromBaseEvidence({
      caregiverUid: "cg-1",
      jurisdictionState: "CA",
      policy: policy(),
      now: NOW,
      candidateId: "cand_9",
      reportId: "rep_9",
      completedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(doc.evidenceStatus).toBe("clear");
    expect(doc.evidenceSource).toBe("shared_base_report_adoption");
    expect(doc.expiresAt).toBe(addMonthsIso("2026-06-01T00:00:00.000Z", 12));
    expect(doc.packageSlug).toBe(BASE_PKG);
    // Evidence, not approval: nothing approval-shaped on the doc.
    expect(doc).not.toHaveProperty("approval");
    expect(doc).not.toHaveProperty("visible");
  });

  it("invitation build starts pending with the candidate reference", () => {
    const doc = buildScreeningForInvitation({
      caregiverUid: "cg-1",
      jurisdictionState: "CA",
      policy: policy(),
      now: NOW,
      candidateId: "cand_9",
    });
    expect(doc.evidenceStatus).toBe("pending");
    expect(doc.checkr.candidateId).toBe("cand_9");
    expect(doc.checkr.invitationStatus).toBe("sent");
  });
});

// ── Webhook provider-reference matching (KTD10) ──────────────────────────────

describe("eventMatchesScreening — updates only from matching provider references", () => {
  const screening = clearScreening();

  it("report events match by report id or candidate+package", () => {
    expect(eventMatchesScreening(screening, "report.completed", { id: "rep_1" })).toBe(true);
    expect(
      eventMatchesScreening(screening, "report.completed", {
        id: "rep_new", candidate_id: "cand_1", package: BASE_PKG,
      }),
    ).toBe(true);
  });

  it("MVR-only and bundled-MVR reports NEVER match (different package)", () => {
    expect(
      eventMatchesScreening(screening, "report.completed", {
        id: "rep_mvr", candidate_id: "cand_1", package: "mvr_only_pkg",
      }),
    ).toBe(false);
  });

  it("another candidate's events never match", () => {
    expect(
      eventMatchesScreening(screening, "report.completed", {
        id: "rep_x", candidate_id: "cand_OTHER", package: BASE_PKG,
      }),
    ).toBe(false);
    expect(eventMatchesScreening(screening, "candidate.updated", { id: "cand_OTHER" })).toBe(false);
  });

  it("invitation events match by invitation id, or candidate+package when unset", () => {
    expect(eventMatchesScreening(screening, "invitation.expired", { id: "inv_1" })).toBe(true);
    const noInv = clearScreening({
      checkr: { candidateId: "cand_1", invitationId: null, reportId: null, invitationStatus: "sent" },
    });
    expect(
      eventMatchesScreening(noInv, "invitation.created", { id: "inv_9", candidate_id: "cand_1", package: BASE_PKG }),
    ).toBe(true);
    expect(
      eventMatchesScreening(noInv, "invitation.created", { id: "inv_9", candidate_id: "cand_1", package: "mvr_only_pkg" }),
    ).toBe(false);
  });

  it("mapReportPayloadToEvidenceStatus mirrors the assessment-first senior mapping", () => {
    expect(mapReportPayloadToEvidenceStatus({ assessment: "eligible" })).toBe("clear");
    expect(mapReportPayloadToEvidenceStatus({ result: "consider" })).toBe("consider");
    expect(mapReportPayloadToEvidenceStatus({ status: "suspended" })).toBe("suspended");
    expect(mapReportPayloadToEvidenceStatus({})).toBe("pending");
  });
});

// ── Event application (idempotent, out-of-order-safe, senior-wall) ──────────

/** Dot-path-aware fake Firestore (update() with "a.b" keys, like the Admin SDK). */
function makeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(initial));
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const applyDotPath = (target: Record<string, unknown>, key: string, value: unknown) => {
    const parts = key.split(".");
    let obj: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = obj[parts[i]];
      obj[parts[i]] = existing && typeof existing === "object" ? { ...(existing as object) } : {};
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  };
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => {
      writes.push({ path, data });
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`);
      writes.push({ path, data });
      const next = { ...(docs.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) applyDotPath(next, k, v);
      docs.set(path, next);
    },
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (collPath: string): any => ({
    doc: (id: string) => makeDocRef(`${collPath}/${id}`),
  });
  return {
    db: { collection: (c: string) => makeColl(c) } as any,
    docs,
    writes,
    screeningPath: "caregivers/cg-1/screenings/child",
  };
}

describe("applyCheckrEventToChildcareScreening — idempotent, out-of-order-safe", () => {
  const SCREENING_PATH = "caregivers/cg-1/screenings/child";

  it("no screening doc → no-op (senior-only caregivers are untouched)", async () => {
    const { db, writes } = makeDb({ "caregivers/cg-1": { name: "Jane" } });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_1", type: "report.completed",
      payload: { id: "rep_1", candidate_id: "cand_1", result: "clear" }, db, now: NOW,
    });
    expect(r).toMatchObject({ applied: false, reason: "no_screening_doc" });
    expect(writes).toEqual([]);
  });

  it("non-matching provider references → no-op", async () => {
    const { db, writes } = makeDb({ [SCREENING_PATH]: clearScreening() as any });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_1", type: "report.completed",
      payload: { id: "rep_other", candidate_id: "cand_OTHER", package: "mvr_only_pkg", result: "clear" },
      db, now: NOW,
    });
    expect(r).toMatchObject({ applied: false, reason: "no_provider_ref_match" });
    expect(writes).toEqual([]);
  });

  it("report.completed(clear) records evidence + expiry + version bump — and ONLY on the screening doc", async () => {
    const pending = clearScreening({
      evidenceStatus: "pending", reportCompletedAt: null, expiresAt: null,
      checkr: { candidateId: "cand_1", invitationId: "inv_1", reportId: null, invitationStatus: "completed" },
      eligibilityVersion: 1,
    });
    const { db, docs, writes } = makeDb({
      [SCREENING_PATH]: pending as any,
      "caregivers/cg-1": { verified: false, verificationStatus: "pending" },
    });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_clear", type: "report.completed",
      payload: { id: "rep_1", candidate_id: "cand_1", package: BASE_PKG, result: "clear" },
      db, now: NOW,
    });
    expect(r).toMatchObject({ applied: true });
    const doc = docs.get(SCREENING_PATH)! as any;
    expect(doc.evidenceStatus).toBe("clear");
    expect(doc.checkr.reportId).toBe("rep_1");
    expect(doc.reportCompletedAt).toBe(NOW.toISOString());
    expect(doc.expiresAt).toBe(addMonthsIso(NOW.toISOString(), 12));
    expect(doc.eligibilityVersion).toBe(2);
    expect(doc.appliedEventIds).toContain("evt_clear");
    // R24/R27 WALL: the parent caregiver doc was never written — clear is
    // evidence, not approval, and no senior field moved.
    expect(writes.every((w) => w.path === SCREENING_PATH)).toBe(true);
    expect(docs.get("caregivers/cg-1")).toEqual({ verified: false, verificationStatus: "pending" });
  });

  it("duplicate event id is a doc-level no-op (idempotency beyond the event ledger)", async () => {
    const doc = clearScreening({ appliedEventIds: ["evt_dup"], eligibilityVersion: 5 });
    const { db, docs } = makeDb({ [SCREENING_PATH]: doc as any });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_dup", type: "report.completed",
      payload: { id: "rep_1", result: "clear" }, db, now: NOW,
    });
    expect(r).toMatchObject({ applied: false, reason: "duplicate_event" });
    expect((docs.get(SCREENING_PATH) as any).eligibilityVersion).toBe(5);
  });

  it("OUT-OF-ORDER: invitation.expired after report-derived evidence updates invitation bookkeeping but never regresses evidence", async () => {
    const { db, docs } = makeDb({ [SCREENING_PATH]: clearScreening() as any });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_late_inv", type: "invitation.expired",
      payload: { id: "inv_1" }, db, now: NOW,
    });
    expect(r).toMatchObject({ applied: true });
    const doc = docs.get(SCREENING_PATH)! as any;
    expect(doc.checkr.invitationStatus).toBe("expired");
    expect(doc.evidenceStatus).toBe("clear"); // never regressed
  });

  it("OUT-OF-ORDER: a stray non-completed event for an unknown report never clobbers valid report evidence", async () => {
    const { db, docs } = makeDb({ [SCREENING_PATH]: clearScreening() as any });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_stray", type: "report.updated",
      payload: { id: "rep_unknown", candidate_id: "cand_1", package: BASE_PKG, result: "consider" },
      db, now: NOW,
    });
    expect(r).toMatchObject({ applied: false, reason: "superseded_by_report_evidence" });
    expect((docs.get(SCREENING_PATH) as any).evidenceStatus).toBe("clear");
  });

  it("consider / suspended / disputed / canceled all record evidence states (never approval)", async () => {
    for (const [type, payload, expected] of [
      ["report.completed", { id: "rep_1", result: "consider" }, "consider"],
      ["report.suspended", { id: "rep_1", status: "suspended" }, "suspended"],
      ["report.disputed", { id: "rep_1" }, "disputed"],
      ["report.canceled", { id: "rep_1" }, "canceled"],
    ] as const) {
      const { db, docs } = makeDb({ [SCREENING_PATH]: clearScreening() as any });
      const r = await applyCheckrEventToChildcareScreening({
        caregiverUid: "cg-1", eventId: `evt_${expected}`, type, payload: payload as any, db, now: NOW,
      });
      expect(r.applied).toBe(true);
      expect((docs.get(SCREENING_PATH) as any).evidenceStatus).toBe(expected);
    }
  });

  it("adverse-action events drive the state machine; a fresh clear resolves a dispute but never post_adverse", async () => {
    const { db, docs } = makeDb({ [SCREENING_PATH]: clearScreening() as any });
    await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "e1", type: "report.pre_adverse_action", payload: { id: "rep_1" }, db, now: NOW,
    });
    expect((docs.get(SCREENING_PATH) as any).adverseAction.state).toBe("pre_adverse");
    await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "e2", type: "report.disputed", payload: { id: "rep_1" }, db, now: NOW,
    });
    expect((docs.get(SCREENING_PATH) as any).adverseAction.state).toBe("dispute");
    await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "e3", type: "report.completed",
      payload: { id: "rep_1", result: "clear" }, db, now: NOW,
    });
    expect((docs.get(SCREENING_PATH) as any).adverseAction.state).toBe("none");

    // post_adverse stands until the human process says otherwise.
    const { db: db2, docs: docs2 } = makeDb({
      [SCREENING_PATH]: clearScreening({ adverseAction: { state: "post_adverse", updatedAt: "2026-07-10T00:00:00.000Z" } }) as any,
    });
    await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "e4", type: "report.completed",
      payload: { id: "rep_1", result: "clear" }, db: db2, now: NOW,
    });
    expect((docs2.get(SCREENING_PATH) as any).adverseAction.state).toBe("post_adverse");
  });

  it("renewal: a NEW completed report supersedes the stored one", async () => {
    const { db, docs } = makeDb({
      [SCREENING_PATH]: clearScreening({
        evidenceStatus: "expired", eligibilityVersion: 4,
      }) as any,
    });
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_renew", type: "report.completed",
      payload: { id: "rep_2", candidate_id: "cand_1", package: BASE_PKG, result: "clear" },
      db, now: NOW,
    });
    expect(r.applied).toBe(true);
    const doc = docs.get(SCREENING_PATH)! as any;
    expect(doc.checkr.reportId).toBe("rep_2");
    expect(doc.evidenceStatus).toBe("clear");
    expect(doc.eligibilityVersion).toBe(5);
  });

  it("never throws — an internal failure is contained (senior webhook path protected)", async () => {
    const explodingDb: any = {
      collection: () => { throw new Error("boom"); },
    };
    const r = await applyCheckrEventToChildcareScreening({
      caregiverUid: "cg-1", eventId: "evt_x", type: "report.completed",
      payload: { id: "rep_1" }, db: explodingDb, now: NOW,
    });
    expect(r).toMatchObject({ applied: false, reason: "error" });
  });
});
