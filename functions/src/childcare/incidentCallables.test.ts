// U12 (childcare marketplace plan 2026-07-22-002): v1 operator callables.
// Scenarios: scope allow/deny through the callables (childSafety vs general vs
// broad-isAdmin-only vs none — AE18), reason missing → denied, stale
// auth_time → denied, sanitized queue vs detail (exact response field sets),
// marker/report creation dedupe (AE24), status/assignment workflow,
// exclude-party via the action callable, authority-dispute surfacing,
// provider-redaction surfacing (U3), review moderation (only the pinned
// fields move; removal reason audited), emergency-off operation, App Check
// enforce, rate limiting, and the adminResolveShiftHours generalOperator gate
// (source characterization — its module binds Stripe at load).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── In-memory Firestore mock (providerVerticalCallables.test.ts idiom) ───────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  let autoId = 0;
  let rateAllowed = true;

  const dotGet = (obj: any, p: string): unknown =>
    p.split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), obj);

  const makeDocRef = (p: string): any => ({
    id: p.split("/").pop(),
    path: p,
    get: async () => ({ exists: docs.has(p), id: p.split("/").pop(), data: () => docs.get(p), ref: makeDocRef(p) }),
    set: async (data: any, opts?: any) => {
      docs.set(p, opts?.merge ? { ...(docs.get(p) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(p)) throw new Error(`NOT_FOUND: ${p}`);
      docs.set(p, { ...(docs.get(p) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${p}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = []): any => ({
    where: (field: string, _op: string, value: any) => makeQuery(collPath, [...filters, { field, value }]),
    get: async () => {
      const rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === collPath.split("/").length + 1)
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => dotGet(r._raw, f.field) === f.value));
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (p: string): any => {
    const q = makeQuery(p);
    return {
      doc: (id?: string) => makeDocRef(`${p}/${id ?? `auto-${autoId++}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${p}/auto-${autoId++}`);
        docs.set(ref.path, { ...data });
        return ref;
      },
      where: q.where,
      get: q.get,
    };
  };

  const runTransaction = async (fn: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => { void ref.set(data, opts); },
      update: (ref: any, data: any) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); },
    };
    return fn(tx);
  };

  const holdChildcareShiftPayout = vi.fn(
    async (_appointmentId?: string, _reason?: string, _opts?: unknown) => ({
      held: true,
      alreadyPaidOut: false,
    }),
  );

  return {
    docs,
    makeCollRef,
    runTransaction,
    holdChildcareShiftPayout,
    setRateAllowed: (v: boolean) => { rateAllowed = v; },
    isRateAllowed: () => rateAllowed,
    reset: () => { docs.clear(); rateAllowed = true; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (p: string) => hoisted.makeCollRef(p),
    runTransaction: hoisted.runTransaction,
  });
  firestore.Timestamp = { fromMillis: (ms: number) => ({ toMillis: () => ms }) };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

const auditEvents: Array<{ eventType: string; userId: string; data: any }> = [];
vi.mock("../observability/auditLog", () => ({
  logAudit: vi.fn(async (e: any) => { auditEvents.push(e); }),
}));
vi.mock("../rateLimit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: hoisted.isRateAllowed() })),
}));
vi.mock("./shiftPayments", () => ({
  holdChildcareShiftPayout: (id: string, reason: string, opts?: any) =>
    hoisted.holdChildcareShiftPayout(id, reason, opts),
}));

import {
  createChildcareIncident as _create,
  listChildcareIncidents as _list,
  getChildcareIncidentDetail as _detail,
  updateChildcareIncidentStatus as _updateStatus,
  assignChildcareIncident as _assign,
  applyChildcareIncidentAction as _action,
  resolveChildcareAuthorityDispute as _resolveDispute,
  markProviderRedactionComplete as _markRedaction,
  flagChildcareReview as _flagReview,
  removeChildcareReview as _removeReview,
} from "./incidentCallables";
import { CHILDCARE_INCIDENT_QUEUE_ROW_KEYS, incidentCaseIdFromMarker } from "./incidentPolicy";
import { CHILDCARE_OPERATORS_COLLECTION } from "../admin/requireOperatorScope";

/* eslint-disable @typescript-eslint/no-explicit-any */
const create = _create as any;
const list = _list as any;
const detail = _detail as any;
const updateStatus = _updateStatus as any;
const assign = _assign as any;
const action = _action as any;
const resolveDispute = _resolveDispute as any;
const markRedaction = _markRedaction as any;
const flagReview = _flagReview as any;
const removeReview = _removeReview as any;

const freshAuthTime = () => Math.floor(Date.now() / 1000) - 5;
const staleAuthTime = () => Math.floor(Date.now() / 1000) - 3600;
const PHONE = "+14085551234";

function ctx(uid: string, opts: { authTime?: number; app?: boolean } = {}): any {
  return {
    auth: { uid, token: { auth_time: opts.authTime ?? freshAuthTime() } },
    ...(opts.app === false ? {} : { app: { appId: "test-app" } }),
  };
}

function grantOperator(uid: string, scopes: string[]) {
  hoisted.docs.set(`${CHILDCARE_OPERATORS_COLLECTION}/${uid}`, {
    operatorUid: uid,
    scopes,
    active: true,
  });
}

function seedMarker(category = "injury", at = "2026-07-23T11:00:00.000Z") {
  hoisted.docs.set(`agent_sessions/${PHONE}`, {
    childcareIncidentMarker: category,
    childcareIncidentAt: at,
  });
  return at;
}

async function seedCaseViaMarker(operator = "op-safety"): Promise<string> {
  seedMarker();
  const res = await create({ fromMarker: { phone: PHONE } }, ctx(operator));
  return res.caseId;
}

beforeEach(() => {
  hoisted.reset();
  auditEvents.length = 0;
  vi.clearAllMocks();
  grantOperator("op-safety", ["childSafetyOperator"]);
  grantOperator("op-gen", ["generalOperator"]);
  grantOperator("op-support", ["childSupportOperator"]);
  hoisted.docs.set("users/admin-1", { userType: "admin", isAdmin: true });
  hoisted.docs.set("users/nobody", { userType: "caregiver" });
});

afterEach(() => {
  delete process.env.CHILDCARE_APPCHECK_MODE;
});

// ── Scope matrix through the callables (AE18) ────────────────────────────────

describe("scope matrix (childSafety vs general vs broad-admin-only vs none)", () => {
  it("detail: childSafety+reason allowed; general, broad-admin-only, and none DENIED (AE18)", async () => {
    const caseId = await seedCaseViaMarker();
    const ok = await detail({ caseId, reason: "incident_investigation" }, ctx("op-safety"));
    expect(ok.success).toBe(true);
    for (const uid of ["op-gen", "admin-1", "nobody"]) {
      await expect(
        detail({ caseId, reason: "incident_investigation" }, ctx(uid)),
      ).rejects.toMatchObject({ code: "permission-denied" });
    }
  });

  it("queue: child-safety and child-support can list; broad admin and unrelated scopes cannot", async () => {
    await seedCaseViaMarker();
    for (const uid of ["op-safety", "op-support"]) {
      const res = await list({}, ctx(uid));
      expect(res.success).toBe(true);
      expect(res.incidents).toHaveLength(1);
    }
    await expect(list({}, ctx("nobody"))).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("status/assignment mutations are childSafety-only", async () => {
    const caseId = await seedCaseViaMarker();
    await expect(
      updateStatus({ caseId, status: "investigating", reason: "incident_triage" }, ctx("op-gen")),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      assign({ caseId, ownerUid: "op-safety", reason: "incident_triage" }, ctx("admin-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Reason + recent auth (R56) ───────────────────────────────────────────────

describe("reason-for-access and recent auth", () => {
  it("detail without a reason → denied AFTER the scope check (failed-precondition)", async () => {
    const caseId = await seedCaseViaMarker();
    await expect(detail({ caseId }, ctx("op-safety"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    await expect(detail({ caseId, reason: "   " }, ctx("op-safety"))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("a granted detail read writes the R56 immutable access record (actor/object/reason/timestamp)", async () => {
    const caseId = await seedCaseViaMarker();
    await detail({ caseId, reason: "incident_investigation" }, ctx("op-safety"));
    const row = [...hoisted.docs.entries()].find(
      ([p, d]) => p.startsWith("agent_audit_log/") && d.eventType === "childcare_operator_access",
    );
    expect(row).toBeTruthy();
    expect(row![1].userId).toBe("op-safety");
    expect(row![1].data).toMatchObject({
      scope: "childSafetyOperator",
      action: "incident_detail_read",
      objectRef: caseId,
      reasonCode: "incident_investigation",
    });
    expect(typeof row![1].timestamp).toBe("string");
  });

  it("stale auth_time → denied on child-sensitive operations", async () => {
    const caseId = await seedCaseViaMarker();
    await expect(
      detail({ caseId, reason: "incident_investigation" }, ctx("op-safety", { authTime: staleAuthTime() })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(
      updateStatus({ caseId, status: "investigating", reason: "incident_triage" }, ctx("op-safety", { authTime: staleAuthTime() })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(
      create({ fromMarker: { phone: PHONE } }, ctx("op-safety", { authTime: staleAuthTime() })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

// ── Creation + dedupe (AE24) ─────────────────────────────────────────────────

describe("createChildcareIncident", () => {
  it("from marker: duplicate creates converge on ONE case (AE24)", async () => {
    const at = seedMarker("abuse");
    const first = await create({ fromMarker: { phone: PHONE } }, ctx("op-safety"));
    expect(first).toMatchObject({ success: true, created: true, duplicate: false });
    expect(first.caseId).toBe(incidentCaseIdFromMarker(PHONE, at));
    const second = await create({ fromMarker: { phone: PHONE } }, ctx("op-support"));
    expect(second).toMatchObject({ success: true, created: false, duplicate: true, caseId: first.caseId });
    expect([...hoisted.docs.keys()].filter((k) => k.startsWith("childcare_incidents/"))).toHaveLength(1);
  });

  it("direct report: valid operator category required; idempotency key convergence", async () => {
    const a = await create(
      { category: "policy_violation", idempotencyKey: "k1", summary: "s" },
      ctx("op-support"),
    );
    expect(a.created).toBe(true);
    const b = await create({ category: "policy_violation", idempotencyKey: "k1" }, ctx("op-support"));
    expect(b).toMatchObject({ created: false, duplicate: true, caseId: a.caseId });
    await expect(
      create({ category: "not_a_category", idempotencyKey: "k2" }, ctx("op-support")),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("a marker-less phone is an enumeration-safe permission-denied", async () => {
    await expect(
      create({ fromMarker: { phone: "+15550000000" } }, ctx("op-safety")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Sanitized queue vs detail (exact response field sets — AE18) ─────────────

describe("queue and detail response field sets", () => {
  it("queue rows carry EXACTLY the pinned keys; detail carries the full case for childSafety", async () => {
    const caseId = await seedCaseViaMarker();
    const q = await list({}, ctx("op-support"));
    expect(Object.keys(q.incidents[0]).sort()).toEqual([...CHILDCARE_INCIDENT_QUEUE_ROW_KEYS].sort());
    expect(JSON.stringify(q.incidents[0])).not.toContain(PHONE);

    const d = await detail({ caseId, reason: "incident_investigation" }, ctx("op-safety"));
    expect(d.incident.subject.sessionPhone).toBe(PHONE); // detail-only content
    expect(d.incident.transitions).toEqual([]);
  });

  it("status filter validates against the transition map", async () => {
    await expect(list({ status: "bogus" }, ctx("op-support"))).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});

// ── Workflow via callables ───────────────────────────────────────────────────

describe("updateChildcareIncidentStatus / assignChildcareIncident", () => {
  it("moves the case through the deterministic map and rejects invalid transitions", async () => {
    const caseId = await seedCaseViaMarker();
    const r = await updateStatus({ caseId, status: "investigating", reason: "incident_triage" }, ctx("op-safety"));
    expect(r).toMatchObject({ success: true, status: "investigating" });
    await expect(
      updateStatus({ caseId, status: "corrected", reason: "incident_triage" }, ctx("op-safety")),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "invalid_transition" } });
  });

  it("assigns a case owner", async () => {
    const caseId = await seedCaseViaMarker();
    const r = await assign({ caseId, ownerUid: "op-safety", reason: "incident_triage" }, ctx("op-safety"));
    expect(r).toMatchObject({ success: true, ownerUid: "op-safety" });
  });
});

// ── applyChildcareIncidentAction ─────────────────────────────────────────────

describe("applyChildcareIncidentAction", () => {
  it("exclude_party unions the booking excludedUids (reason required, childSafety only)", async () => {
    const caseId = await seedCaseViaMarker();
    hoisted.docs.set("booking_requests/cbook_1", {
      careVertical: "child",
      excludedUids: [],
    });
    await expect(
      action({ caseId, action: "exclude_party", suspectUid: "cg-sus", bookingId: "cbook_1" }, ctx("op-safety")),
    ).rejects.toMatchObject({ code: "failed-precondition" }); // no reason
    const r = await action(
      { caseId, action: "exclude_party", suspectUid: "cg-sus", bookingId: "cbook_1", reason: "incident_investigation" },
      ctx("op-safety"),
    );
    expect(r).toMatchObject({ success: true, suspectedPartyCount: 1 });
    expect(hoisted.docs.get("booking_requests/cbook_1").excludedUids).toEqual(["cg-sus"]);
    await expect(
      action({ caseId, action: "exclude_party", suspectUid: "x", reason: "incident_investigation" }, ctx("op-gen")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("payout_hold delegates to U8's rail with the incident-stamped reason", async () => {
    const caseId = await seedCaseViaMarker();
    const r = await action(
      { caseId, action: "payout_hold", appointmentId: "cshift_1", reason: "payout_hold_review" },
      ctx("op-safety"),
    );
    expect(r).toMatchObject({ success: true, held: true });
    expect(hoisted.holdChildcareShiftPayout).toHaveBeenCalledWith(
      "cshift_1",
      `incident:${caseId}`,
      expect.anything(),
    );
  });

  it("litigation_hold / release_litigation_hold flip the child legal hold", async () => {
    const caseId = await seedCaseViaMarker();
    hoisted.docs.set("child_profiles/child-1", {
      childId: "child-1",
      householdId: "hh_1",
      state: "active",
      accessVersion: 1,
      legalHold: null,
    });
    const on = await action(
      { caseId, action: "litigation_hold", childId: "child-1", reason: "safety_review" },
      ctx("op-safety"),
    );
    expect(on).toMatchObject({ success: true, litigationHoldActive: true });
    expect(hoisted.docs.get("child_profiles/child-1").legalHold?.active).toBe(true);
    const off = await action(
      { caseId, action: "release_litigation_hold", childId: "child-1", reason: "safety_review" },
      ctx("op-safety"),
    );
    expect(off.success).toBe(true);
    expect(hoisted.docs.get("child_profiles/child-1").legalHold?.active).toBe(false);
  });

  it("unknown actions are rejected", async () => {
    const caseId = await seedCaseViaMarker();
    await expect(
      action({ caseId, action: "eject", reason: "incident_investigation" }, ctx("op-safety")),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

// ── resolveChildcareAuthorityDispute (U2 surfacing) ──────────────────────────

describe("resolveChildcareAuthorityDispute", () => {
  function seedDispute(childId = "child-1", adultUid = "aunt-1") {
    hoisted.docs.set(`guardian_authorities/${childId}__${adultUid}`, {
      authorityId: `${childId}__${adultUid}`,
      householdId: "hh_1",
      childId,
      adultUid,
      scopes: ["view"],
      state: "dispute_hold",
      accessVersion: 3,
      disputeHold: {
        pendingAction: "revoke",
        openedAt: "2026-07-22T00:00:00.000Z",
        openedByUid: "parent-1",
        reason: null,
        noticeOutboxId: "o1",
        resolvedAt: null,
        resolvedByUid: null,
        resolution: null,
      },
    });
  }

  it("childSafety + reason resolves the dispute (applied → revoke lands)", async () => {
    seedDispute();
    const r = await resolveDispute(
      { childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied", reason: "authority_dispute_review" },
      ctx("op-safety"),
    );
    expect(r).toMatchObject({ success: true, state: "revoked", accessVersion: 4 });
    const doc = hoisted.docs.get("guardian_authorities/child-1__aunt-1");
    expect(doc.disputeHold.resolvedByUid).toBe("op-safety");
  });

  it("restored returns the authority to active", async () => {
    seedDispute();
    const r = await resolveDispute(
      { childId: "child-1", targetAdultUid: "aunt-1", resolution: "restored", reason: "authority_dispute_review" },
      ctx("op-safety"),
    );
    expect(r).toMatchObject({ success: true, state: "active" });
  });

  it("generalOperator, broad admin, reason-less, and unknown-authority calls are denied", async () => {
    seedDispute();
    for (const uid of ["op-gen", "admin-1"]) {
      await expect(
        resolveDispute(
          { childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied", reason: "authority_dispute_review" },
          ctx(uid),
        ),
      ).rejects.toMatchObject({ code: "permission-denied" });
    }
    await expect(
      resolveDispute({ childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied" }, ctx("op-safety")),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(
      resolveDispute(
        { childId: "ghost", targetAdultUid: "aunt-1", resolution: "applied", reason: "authority_dispute_review" },
        ctx("op-safety"),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("an authority NOT in dispute is failed-precondition (authorized operators get the real state)", async () => {
    hoisted.docs.set("guardian_authorities/child-1__aunt-1", {
      authorityId: "child-1__aunt-1",
      childId: "child-1",
      adultUid: "aunt-1",
      state: "active",
      accessVersion: 1,
    });
    await expect(
      resolveDispute(
        { childId: "child-1", targetAdultUid: "aunt-1", resolution: "applied", reason: "authority_dispute_review" },
        ctx("op-safety"),
      ),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "not_in_dispute" } });
  });
});

// ── markProviderRedactionComplete (U3 surfacing) ─────────────────────────────

describe("markProviderRedactionComplete", () => {
  function seedLifecycleRequest() {
    hoisted.docs.set("data_lifecycle_requests/req-1", {
      requestId: "req-1",
      scope: "delete",
      childId: "child-1",
      householdId: "hh_1",
      requesterUid: "parent-1",
      state: "awaiting_provider",
      tasks: [
        { taskId: "t1", kind: "firestore_delete", state: "completed", attemptCount: 1, completedAt: "x" },
        { taskId: "t2", kind: "stripe_identity_redaction", state: "awaiting_provider", attemptCount: 1 },
      ],
      proof: { counts: {}, startedAt: "x", completedAt: null, retainedRecordReasons: [] },
    });
  }

  it("childSupportOperator completes the provider task; broad admin is denied", async () => {
    seedLifecycleRequest();
    const r = await markRedaction(
      { requestId: "req-1", taskId: "t2", providerRef: "vs_redacted_1", reason: "privacy_request" },
      ctx("op-support"),
    );
    expect(r).toMatchObject({ success: true, state: "completed" });
    const doc = hoisted.docs.get("data_lifecycle_requests/req-1");
    expect(doc.tasks[1]).toMatchObject({ state: "completed" });
    expect(doc.tasks[1].proof).toMatchObject({ providerExecuted: true, completedByOperatorUid: "op-support" });

    seedLifecycleRequest();
    await expect(
      markRedaction(
        { requestId: "req-1", taskId: "t2", reason: "privacy_request" },
        ctx("admin-1"),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("requires recent auth and denies non-operators + unknown requests enumeration-safely", async () => {
    seedLifecycleRequest();
    await expect(
      markRedaction({ requestId: "req-1", taskId: "t2", reason: "privacy_request" }, ctx("op-support", { authTime: staleAuthTime() })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(
      markRedaction({ requestId: "req-1", taskId: "t2", reason: "privacy_request" }, ctx("nobody")),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      markRedaction({ requestId: "ghost", taskId: "t2", reason: "privacy_request" }, ctx("op-support")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Review moderation (U8 seam) ──────────────────────────────────────────────

describe("flagChildcareReview / removeChildcareReview", () => {
  function seedReview(id = "crev_1", overrides: Record<string, unknown> = {}) {
    hoisted.docs.set(`reviews/${id}`, {
      careVertical: "child",
      childcareBookingId: "cbook_1",
      caregiverId: "cg-1",
      clientId: "parent-1",
      reviewerUid: "parent-1",
      reviewerRole: "family",
      rating: 2,
      comment: "…",
      moderationState: "published",
      isPublic: true,
      createdAt: "2026-07-23T00:00:00.000Z",
      ...overrides,
    });
  }

  it("childSafetyOperator flags a childcare review — only pinned fields move", async () => {
    seedReview();
    const before = { ...hoisted.docs.get("reviews/crev_1") };
    const r = await flagReview({ reviewId: "crev_1" }, ctx("op-safety"));
    expect(r).toMatchObject({ success: true, moderationState: "flagged" });
    const after = hoisted.docs.get("reviews/crev_1");
    expect(after.moderationState).toBe("flagged");
    expect(after.isPublic).toBe(true); // flagged stays visible pending review
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort()); // no new fields on a world-readable doc
  });

  it("remove: requires a reason; sets removed + isPublic=false; reason lands in the audit log only", async () => {
    seedReview();
    await expect(removeReview({ reviewId: "crev_1" }, ctx("op-safety"))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "removal_reason_required" },
    });
    const r = await removeReview({ reviewId: "crev_1", reason: "harassing content" }, ctx("op-safety"));
    expect(r).toMatchObject({ success: true, moderationState: "removed" });
    const doc = hoisted.docs.get("reviews/crev_1");
    expect(doc).toMatchObject({ moderationState: "removed", isPublic: false });
    expect(JSON.stringify(doc)).not.toContain("harassing content"); // reason NEVER on the public doc
    const audit = auditEvents.find((e) => e.eventType === "childcare_review_moderated");
    expect(audit).toMatchObject({ userId: "op-safety", data: { reviewId: "crev_1", reason: "harassing content" } });
  });

  it("senior reviews and unknown reviews are enumeration-safe denials; non-operators denied", async () => {
    seedReview("senior_rev", { careVertical: undefined });
    hoisted.docs.set("reviews/senior_rev", { clientId: "c1", rating: 5, isPublic: true });
    await expect(flagReview({ reviewId: "senior_rev" }, ctx("op-safety"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(flagReview({ reviewId: "ghost" }, ctx("op-safety"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    seedReview();
    await expect(flagReview({ reviewId: "crev_1" }, ctx("nobody"))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });
});

// ── Emergency-off + App Check + rate limits ──────────────────────────────────

describe("operational middleware", () => {
  it("EMERGENCY-OFF: every incident callable works with emergencyOff set (safety ops never dark)", async () => {
    hoisted.docs.set("childcare_flags/global", { emergencyOff: true });
    const caseId = await seedCaseViaMarker();
    expect((await list({}, ctx("op-support"))).incidents).toHaveLength(1);
    expect((await detail({ caseId, reason: "incident_investigation" }, ctx("op-safety"))).success).toBe(true);
    expect((await updateStatus({ caseId, status: "investigating", reason: "incident_triage" }, ctx("op-safety"))).success).toBe(true);
  });

  it("App Check enforce mode fails closed on a token-less call", async () => {
    process.env.CHILDCARE_APPCHECK_MODE = "enforce";
    await expect(list({}, ctx("op-support", { app: false }))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("rate limiting rejects with resource-exhausted", async () => {
    await seedCaseViaMarker();
    hoisted.setRateAllowed(false);
    await expect(list({}, ctx("op-support"))).rejects.toMatchObject({ code: "resource-exhausted" });
  });
});

// ── adminResolveShiftHours generalOperator gate (source characterization) ────
//
// shiftHours.ts constructs a Stripe client at module load, so the additive
// U12 gate is pinned by source scan (u8VerticalGuards.test.ts idiom).

describe("adminResolveShiftHours U12 gate (source characterization)", () => {
  it("keeps requireAdmin as the outer gate and adds the generalOperator scope check", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "shiftHours.ts"),
      "utf8",
    );
    const fnStart = src.indexOf("export const adminResolveShiftHours");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf("export const", fnStart + 10));
    const adminGate = fnBody.indexOf("await requireAdmin(context.auth.uid)");
    const scopeGate = fnBody.indexOf("requireOperatorScope(context, OPERATOR_SCOPE_GENERAL");
    expect(adminGate).toBeGreaterThan(-1);
    expect(scopeGate).toBeGreaterThan(adminGate); // additive, requireAdmin stays outer
    // Both gates run before the shiftHours doc is read (no data before authz).
    expect(fnBody.indexOf("collection('shiftHours')")).toBeGreaterThan(scopeGate);
  });

  it("AE18 billing rows: the childcare shiftHours builder carries correlation IDs + amounts only (no child fields)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "shiftPayments.ts"), "utf8");
    const docStart = src.indexOf('careVertical: "child",\n      childcareBookingId:');
    expect(docStart).toBeGreaterThan(-1);
    const docBlock = src.slice(docStart, src.indexOf("status: \"pending_client_review\"", docStart));
    for (const banned of ["childIds", "recipientLabel", "recipientRef", "displayLabel", "householdId"]) {
      expect(docBlock).not.toContain(banned);
    }
    expect(docBlock).toContain('clientName: "Family"'); // generic label, never a child/family name
  });
});
