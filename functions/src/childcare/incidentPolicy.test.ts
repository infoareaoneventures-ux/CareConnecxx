// U12 (childcare marketplace plan 2026-07-22-002): restricted incident case
// policy (R53/R56/R57, AE24). Scenarios: one case per marker (duplicate marker
// → one case, AE24), duplicate direct report converges, deterministic
// categories, status workflow + appeal/correction transitions (invalid moves
// rejected), owner assignment, evidence REFERENCES only (copies rejected),
// suspected-party exclusion end-to-end (U10 marker → case → booking
// excludedUids → U9 fan-out skip), U8 payout hold wiring, U3 litigation hold
// blocks deletion, pinned sanitized queue rows, and the emergency-off
// carve-out (no flags consulted).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (providerVerticalCallables.test.ts idiom) ───────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  let autoId = 0;

  const dotGet = (obj: any, path: string): unknown =>
    path.split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), obj);

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
      ref: makeDocRef(path),
    }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`);
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = []): any => ({
    where: (field: string, op: string, value: any) => makeQuery(collPath, [...filters, { field, value }]),
    get: async () => {
      const rows = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === collPath.split("/").length + 1)
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => dotGet(r._raw, f.field) === f.value));
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${autoId++}`}`),
      where: q.where,
      get: q.get,
    };
  };

  const runTransaction = async (fn: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => { void ref.set(data, opts); },
      update: (ref: any, data: any) => {
        docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
      },
    };
    return fn(tx);
  };

  const holdChildcareShiftPayout = vi.fn(
    async (_appointmentId: string, _reason: string, _opts?: unknown) => ({
      held: true,
      alreadyPaidOut: false,
    }),
  );
  const createCaraOpsAlert = vi.fn(async (_args?: unknown) => true);

  return { docs, makeCollRef, runTransaction, holdChildcareShiftPayout, createCaraOpsAlert, reset: () => docs.clear() };
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
vi.mock("./shiftPayments", () => ({
  holdChildcareShiftPayout: (id: string, reason: string, opts?: any) =>
    hoisted.holdChildcareShiftPayout(id, reason, opts),
}));
vi.mock("../observability/caraOpsAlerts", () => ({
  createCaraOpsAlert: (args: any) => hoisted.createCaraOpsAlert(args),
}));

import {
  ALL_CHILDCARE_INCIDENT_CATEGORIES,
  CHILDCARE_INCIDENT_QUEUE_ROW_KEYS,
  CHILDCARE_INCIDENT_STATUS_TRANSITIONS,
  ChildcareIncidentError,
  addIncidentEvidence,
  assignIncidentOwner,
  applyIncidentPayoutHold,
  createIncidentCaseFromMarker,
  createIncidentCaseFromReport,
  excludeSuspectedParty,
  getIncidentCase,
  incidentCaseIdFromMarker,
  isChildcareIncidentCategory,
  isValidIncidentTransition,
  listIncidentCases,
  sanitizeIncidentQueueRow,
  setIncidentLitigationHold,
  transitionIncidentStatus,
  type ChildcareIncidentStatus,
} from "./incidentPolicy";
import { escalateChildcareIncident, CHILDCARE_INCIDENT_CATEGORIES } from "./incidentSignal";
import { filterExcludedNotificationRecipients } from "./conversationPolicy";
import { createLifecycleRequest, LifecycleError } from "../privacy/dataLifecycle";

const db = {
  collection: (p: string) => hoisted.makeCollRef(p),
  runTransaction: hoisted.runTransaction,
} as any;

const NOW = new Date("2026-07-23T12:00:00.000Z");
const PHONE = "+14085551234";

function seedMarker(category = "injury", at = "2026-07-23T11:00:00.000Z") {
  hoisted.docs.set(`agent_sessions/${PHONE}`, {
    handedToHuman: true,
    handedToHumanReason: "childcare_incident",
    childcareIncidentMarker: category,
    childcareIncidentAt: at,
  });
  return at;
}

beforeEach(() => {
  hoisted.reset();
  auditEvents.length = 0;
  vi.clearAllMocks();
});

// ── Categories ────────────────────────────────────────────────────────────────

describe("deterministic categories", () => {
  it("accepts every U10 classifier category and every operator category; rejects free-form", () => {
    for (const c of ALL_CHILDCARE_INCIDENT_CATEGORIES) {
      expect(isChildcareIncidentCategory(c)).toBe(true);
    }
    expect(ALL_CHILDCARE_INCIDENT_CATEGORIES).toEqual(expect.arrayContaining([...CHILDCARE_INCIDENT_CATEGORIES]));
    expect(isChildcareIncidentCategory("vibes")).toBe(false);
    expect(isChildcareIncidentCategory("")).toBe(false);
    expect(isChildcareIncidentCategory(42)).toBe(false);
  });
});

// ── One restricted case per incident (AE24) ──────────────────────────────────

describe("marker → case (AE24 dedupe)", () => {
  it("creates ONE case from the U10 marker; a duplicate create converges on the same case", async () => {
    const at = seedMarker("missing_child");
    const first = await createIncidentCaseFromMarker({ phone: PHONE, actorUid: "op-1" }, { db, now: NOW });
    expect(first.created).toBe(true);
    expect(first.caseDoc.caseId).toBe(incidentCaseIdFromMarker(PHONE, at));
    expect(first.caseDoc).toMatchObject({
      category: "missing_child",
      source: "marker",
      status: "open",
      markerKey: `${PHONE}:${at}`,
    });

    const second = await createIncidentCaseFromMarker({ phone: PHONE, actorUid: "op-2" }, { db, now: NOW });
    expect(second.created).toBe(false);
    expect(second.caseDoc.caseId).toBe(first.caseDoc.caseId);

    const all = [...hoisted.docs.keys()].filter((k) => k.startsWith("childcare_incidents/"));
    expect(all).toHaveLength(1);
    // Only the FIRST create audits.
    expect(auditEvents.filter((e) => e.eventType === "childcare_incident_case_created")).toHaveLength(1);
  });

  it("no marker on the session → marker_not_found (never a phantom case)", async () => {
    hoisted.docs.set(`agent_sessions/${PHONE}`, { handedToHuman: true });
    await expect(
      createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW }),
    ).rejects.toMatchObject({ code: "marker_not_found" });
  });

  it("the REAL U10 escalation write produces a marker this module consumes (typed-seam integration)", async () => {
    await escalateChildcareIncident({
      phone: PHONE,
      category: "unsafe_pickup",
      channel: "web",
      db,
      now: NOW,
    });
    const { caseDoc, created } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    expect(created).toBe(true);
    expect(caseDoc.category).toBe("unsafe_pickup");
    expect(caseDoc.subject.sessionPhone).toBe(PHONE);
  });
});

describe("direct report creation", () => {
  it("creates a case with bounded inputs; duplicate (reporter, idempotencyKey) converges", async () => {
    const first = await createIncidentCaseFromReport(
      {
        category: "identity_mismatch",
        reporterUid: "op-1",
        idempotencyKey: "k1",
        bookingId: "cbook_1",
        summary: "Pickup adult did not match the authorized list.",
      },
      { db, now: NOW },
    );
    expect(first.created).toBe(true);
    expect(first.caseDoc.source).toBe("operator_report");
    expect(first.caseDoc.evidenceRefs).toEqual([
      { kind: "booking", ref: "cbook_1", addedByUid: "op-1", addedAt: NOW.toISOString() },
    ]);

    const dup = await createIncidentCaseFromReport(
      { category: "identity_mismatch", reporterUid: "op-1", idempotencyKey: "k1" },
      { db, now: NOW },
    );
    expect(dup.created).toBe(false);
    expect(dup.caseDoc.caseId).toBe(first.caseDoc.caseId);
  });

  it("rejects unknown categories and invalid ids", async () => {
    await expect(
      createIncidentCaseFromReport({ category: "vibes", reporterUid: "op-1", idempotencyKey: "k" }, { db }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createIncidentCaseFromReport(
        { category: "injury", reporterUid: "op-1", idempotencyKey: "k", bookingId: "x".repeat(200) },
        { db },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── Status workflow + appeal/correction ──────────────────────────────────────

describe("status workflow (deterministic transition map)", () => {
  async function openCase(): Promise<string> {
    seedMarker();
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    return caseDoc.caseId;
  }

  it("walks the full lifecycle open→investigating→resolved→appealed→corrected with append-only history + audit", async () => {
    const caseId = await openCase();
    const path: ChildcareIncidentStatus[] = ["investigating", "resolved", "appealed", "corrected"];
    for (const to of path) {
      const doc = await transitionIncidentStatus({ caseId, to, actorUid: "op-1" }, { db, now: NOW });
      expect(doc.status).toBe(to);
    }
    const final = await getIncidentCase(caseId, { db });
    expect(final.transitions.map((t) => t.to)).toEqual(path);
    expect(final.transitions.map((t) => t.from)).toEqual(["open", "investigating", "resolved", "appealed"]);
    expect(final.transitions.every((t) => t.byUid === "op-1" && t.at === NOW.toISOString())).toBe(true);
    expect(auditEvents.filter((e) => e.eventType === "childcare_incident_status_changed")).toHaveLength(4);
  });

  it("escalated is reachable from investigating and returns to investigating/resolved", async () => {
    const caseId = await openCase();
    await transitionIncidentStatus({ caseId, to: "investigating", actorUid: "op-1" }, { db });
    await transitionIncidentStatus({ caseId, to: "escalated", actorUid: "op-1" }, { db });
    const doc = await transitionIncidentStatus({ caseId, to: "resolved", actorUid: "op-1" }, { db });
    expect(doc.status).toBe("resolved");
  });

  it("invalid transitions are rejected (open→resolved, resolved→open, corrected→anything)", async () => {
    const caseId = await openCase();
    await expect(
      transitionIncidentStatus({ caseId, to: "resolved", actorUid: "op-1" }, { db }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await transitionIncidentStatus({ caseId, to: "investigating", actorUid: "op-1" }, { db });
    await transitionIncidentStatus({ caseId, to: "resolved", actorUid: "op-1" }, { db });
    await expect(
      transitionIncidentStatus({ caseId, to: "open" as never, actorUid: "op-1" }, { db }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await transitionIncidentStatus({ caseId, to: "appealed", actorUid: "op-1" }, { db });
    await transitionIncidentStatus({ caseId, to: "corrected", actorUid: "op-1" }, { db });
    for (const to of Object.keys(CHILDCARE_INCIDENT_STATUS_TRANSITIONS) as ChildcareIncidentStatus[]) {
      await expect(
        transitionIncidentStatus({ caseId, to, actorUid: "op-1" }, { db }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    }
    expect(isValidIncidentTransition("corrected", "open")).toBe(false);
  });

  it("unknown case → case_not_found", async () => {
    await expect(
      transitionIncidentStatus({ caseId: "cinc_ghost", to: "investigating", actorUid: "op-1" }, { db }),
    ).rejects.toMatchObject({ code: "case_not_found" });
  });
});

// ── Owner assignment ─────────────────────────────────────────────────────────

describe("case owner assignment", () => {
  it("assigns and reassigns the owner with audit", async () => {
    seedMarker();
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    const updated = await assignIncidentOwner(
      { caseId: caseDoc.caseId, ownerUid: "op-safety", actorUid: "op-lead" },
      { db, now: NOW },
    );
    expect(updated.ownerUid).toBe("op-safety");
    expect(auditEvents.some((e) => e.eventType === "childcare_incident_assigned")).toBe(true);
  });
});

// ── Evidence references (never copies — R57) ─────────────────────────────────

describe("evidence references", () => {
  async function openCase(): Promise<string> {
    seedMarker();
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    return caseDoc.caseId;
  }

  it("stores opaque references; duplicates are idempotent", async () => {
    const caseId = await openCase();
    await addIncidentEvidence({ caseId, kind: "booking", ref: "cbook_1", actorUid: "op-1" }, { db, now: NOW });
    await addIncidentEvidence({ caseId, kind: "message", ref: "cchat_room1/messages/m1", actorUid: "op-1" }, { db, now: NOW });
    const again = await addIncidentEvidence({ caseId, kind: "booking", ref: "cbook_1", actorUid: "op-1" }, { db, now: NOW });
    // session ref from creation + booking + message = 3 (duplicate ignored)
    expect(again.evidenceRefs).toHaveLength(3);
  });

  it("rejects unknown kinds and oversized refs (a copy can never be smuggled in as evidence)", async () => {
    const caseId = await openCase();
    await expect(
      addIncidentEvidence({ caseId, kind: "raw_payload", ref: "x", actorUid: "op-1" }, { db }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addIncidentEvidence({ caseId, kind: "file", ref: "x".repeat(300), actorUid: "op-1" }, { db }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addIncidentEvidence({ caseId, kind: "file", ref: "", actorUid: "op-1" }, { db }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("the evidence audit row never carries the ref (R57)", async () => {
    const caseId = await openCase();
    await addIncidentEvidence({ caseId, kind: "file", ref: "cfile_secret", actorUid: "op-1" }, { db });
    const row = auditEvents.find((e) => e.eventType === "childcare_incident_evidence_added");
    expect(row).toBeTruthy();
    expect(JSON.stringify(row!.data)).not.toContain("cfile_secret");
  });
});

// ── Suspected-party exclusion end-to-end (marker → case → excludedUids → U9) ─

describe("suspected unsafe party exclusion (AE24 end-to-end)", () => {
  it("marker → case → excludedUids on the booking → U9 fan-out skips the suspect", async () => {
    // 1. U10 seam: real escalation writes the marker.
    await escalateChildcareIncident({ phone: PHONE, category: "abuse", channel: "linq", db, now: NOW });
    // 2. Case from marker.
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE, actorUid: "op-1" }, { db, now: NOW });
    // 3. Exclude the suspected caregiver on the childcare booking.
    hoisted.docs.set("booking_requests/cbook_1", {
      careVertical: "child",
      clientId: "parent-1",
      caregiverId: "cg-sus",
      excludedUids: [],
    });
    const updated = await excludeSuspectedParty(
      { caseId: caseDoc.caseId, suspectUid: "cg-sus", bookingId: "cbook_1", actorUid: "op-1" },
      { db, now: NOW },
    );
    expect(updated.suspectedPartyUids).toEqual(["cg-sus"]);
    const booking = hoisted.docs.get("booking_requests/cbook_1");
    expect(booking.excludedUids).toEqual(["cg-sus"]);
    // 4. U9 fan-out consults excludedUids: the suspect receives NOTHING.
    expect(filterExcludedNotificationRecipients(booking, ["parent-1", "cg-sus"])).toEqual(["parent-1"]);
    // Repeat exclusion is idempotent.
    const again = await excludeSuspectedParty(
      { caseId: caseDoc.caseId, suspectUid: "cg-sus", bookingId: "cbook_1", actorUid: "op-1" },
      { db, now: NOW },
    );
    expect(again.suspectedPartyUids).toEqual(["cg-sus"]);
    expect(hoisted.docs.get("booking_requests/cbook_1").excludedUids).toEqual(["cg-sus"]);
  });

  it("a SENIOR booking never grows excludedUids (fail-closed vertical guard)", async () => {
    seedMarker();
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    hoisted.docs.set("booking_requests/senior_b1", { clientId: "c1", caregiverId: "cg-1" });
    const updated = await excludeSuspectedParty(
      { caseId: caseDoc.caseId, suspectUid: "cg-1", bookingId: "senior_b1", actorUid: "op-1" },
      { db, now: NOW },
    );
    expect(updated.suspectedPartyUids).toEqual(["cg-1"]); // case still records it
    expect(hoisted.docs.get("booking_requests/senior_b1").excludedUids).toBeUndefined();
  });
});

// ── Payout + litigation holds ────────────────────────────────────────────────

describe("payout hold (U8 rail) and litigation hold (U3 legal hold)", () => {
  async function openCase(): Promise<string> {
    seedMarker();
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    return caseDoc.caseId;
  }

  it("payout hold delegates to holdChildcareShiftPayout with an incident-stamped reason and records the hold", async () => {
    const caseId = await openCase();
    const result = await applyIncidentPayoutHold(
      { caseId, appointmentId: "cshift_1", actorUid: "op-1" },
      { db, now: NOW },
    );
    expect(result.held).toBe(true);
    expect(hoisted.holdChildcareShiftPayout).toHaveBeenCalledWith(
      "cshift_1",
      `incident:${caseId}`,
      expect.anything(),
    );
    expect(result.caseDoc.payoutHolds).toEqual([
      { appointmentId: "cshift_1", heldAt: NOW.toISOString(), alreadyPaidOut: false },
    ]);
  });

  it("already-paid-out is recorded (escalation, never a silent clawback)", async () => {
    hoisted.holdChildcareShiftPayout.mockResolvedValueOnce({ held: false, alreadyPaidOut: true });
    const caseId = await openCase();
    const result = await applyIncidentPayoutHold(
      { caseId, appointmentId: "cshift_paid", actorUid: "op-1" },
      { db, now: NOW },
    );
    expect(result).toMatchObject({ held: false, alreadyPaidOut: true });
    expect(result.caseDoc.payoutHolds[0].alreadyPaidOut).toBe(true);
  });

  it("litigation hold uses the REAL setChildLegalHold and then BLOCKS a U3 deletion request", async () => {
    const caseId = await openCase();
    // Real child profile doc for the real repository/lifecycle modules.
    hoisted.docs.set("child_profiles/child-1", {
      childId: "child-1",
      householdId: "hh_1",
      careVertical: "child",
      displayLabel: "Mia",
      ageBand: "preschool",
      state: "active",
      authorizedViewerUids: ["parent-1"],
      accessVersion: 1,
      legalHold: null,
      safetyCurrentVersion: 0,
      createdByUid: "parent-1",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const updated = await setIncidentLitigationHold(
      { caseId, childId: "child-1", active: true, actorUid: "op-1" },
      { db, now: NOW },
    );
    expect(updated.litigationHolds).toEqual([{ childId: "child-1", active: true, changedAt: NOW.toISOString() }]);
    const child = hoisted.docs.get("child_profiles/child-1");
    expect(child.legalHold).toMatchObject({ active: true, reason: `childcare_incident:${caseId}` });

    // U3 evidence-hold contract: delete request creation is REFUSED while held.
    await expect(
      createLifecycleRequest(
        { requesterUid: "parent-1", childId: "child-1", scope: "delete", idempotencyKey: "del-1", systemInitiated: true },
        { db, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "legal_hold_active" });
    // Export remains possible (data rights survive the hold).
    const exportReq = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: "child-1", scope: "export", idempotencyKey: "exp-1", systemInitiated: true },
      { db, now: NOW },
    );
    expect(exportReq.scope).toBe("export");

    // Releasing the hold re-enables deletion.
    await setIncidentLitigationHold({ caseId, childId: "child-1", active: false, actorUid: "op-1" }, { db, now: NOW });
    const releasedChild = hoisted.docs.get("child_profiles/child-1");
    expect(releasedChild.legalHold?.active).toBe(false);
    const delReq = await createLifecycleRequest(
      { requesterUid: "parent-1", childId: "child-1", scope: "delete", idempotencyKey: "del-2", systemInitiated: true },
      { db, now: NOW },
    );
    expect(delReq.scope).toBe("delete");
    expect(LifecycleError).toBeTruthy();
  });
});

// ── Sanitized projections (AE18/R57) ─────────────────────────────────────────

describe("sanitized queue rows", () => {
  it("queue rows carry EXACTLY the pinned key set — no phone, booking id, summary, or child detail", async () => {
    seedMarker("custody_conflict");
    await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    const rows = await listIncidentCases({}, { db });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...CHILDCARE_INCIDENT_QUEUE_ROW_KEYS].sort());
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain("markerKey");
    expect(serialized).not.toContain("summary");
  });

  it("sanitizeIncidentQueueRow counts evidence/suspects/holds without exposing them", async () => {
    seedMarker();
    const { caseDoc } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    hoisted.docs.set("booking_requests/cbook_1", { careVertical: "child", excludedUids: [] });
    await excludeSuspectedParty({ caseId: caseDoc.caseId, suspectUid: "cg-sus", bookingId: "cbook_1", actorUid: "op-1" }, { db });
    const row = sanitizeIncidentQueueRow(await getIncidentCase(caseDoc.caseId, { db }));
    expect(row.suspectedPartyCount).toBe(1);
    expect(JSON.stringify(row)).not.toContain("cg-sus");
  });

  it("list filters by status (single-equality query) and sorts newest first", async () => {
    seedMarker("injury", "2026-07-23T10:00:00.000Z");
    const a = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: new Date("2026-07-23T10:00:00.000Z") });
    const b = await createIncidentCaseFromReport(
      { category: "policy_violation", reporterUid: "op-1", idempotencyKey: "k9" },
      { db, now: new Date("2026-07-23T11:00:00.000Z") },
    );
    await transitionIncidentStatus({ caseId: b.caseDoc.caseId, to: "investigating", actorUid: "op-1" }, { db });
    const open = await listIncidentCases({ status: "open" }, { db });
    expect(open.map((r) => r.caseId)).toEqual([a.caseDoc.caseId]);
    const all = await listIncidentCases({}, { db });
    expect(all.map((r) => r.caseId)).toEqual([b.caseDoc.caseId, a.caseDoc.caseId]); // newest first
  });
});

// ── Emergency-off carve-out ──────────────────────────────────────────────────

describe("emergency-off (safety operations never dark)", () => {
  it("every policy function works with emergencyOff set — the module never consults childcare flags", async () => {
    hoisted.docs.set("childcare_flags/global", { emergencyOff: true });
    seedMarker();
    const { caseDoc, created } = await createIncidentCaseFromMarker({ phone: PHONE }, { db, now: NOW });
    expect(created).toBe(true);
    await transitionIncidentStatus({ caseId: caseDoc.caseId, to: "investigating", actorUid: "op-1" }, { db });
    const rows = await listIncidentCases({}, { db });
    expect(rows[0].status).toBe("investigating");
  });
});

// ── Error type sanity ────────────────────────────────────────────────────────

describe("ChildcareIncidentError", () => {
  it("carries a typed code", () => {
    const err = new ChildcareIncidentError("invalid_transition", "nope");
    expect(err.code).toBe("invalid_transition");
    expect(err.name).toBe("ChildcareIncidentError");
  });
});
