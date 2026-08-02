// Childcare MCP tool pack (plan 2026-07-22-002, U10 / R51-R52, AE19).
//
// Load-bearing assertions:
//   • the vertical guard fails closed in BOTH directions (senior turn cannot
//     reach a childcare handler; the model cannot forge the stamp because
//     qaAgent overwrites it from the session);
//   • every handler re-runs action-time authority + runtime flags INSIDE the
//     call (never the envelope alone);
//   • mutation results carry fresh-read post-state evidence (R52);
//   • enumeration-safe errors for foreign/senior/missing bookings.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin", () => {
  const dummyDoc: any = {
    get: async () => ({ exists: false, data: () => undefined }),
    set: async () => undefined, update: async () => undefined,
  };
  const dummyColl: any = { doc: () => dummyDoc, where: () => dummyColl, get: async () => ({ empty: true, docs: [] }) };
  const firestore: any = () => ({ collection: () => dummyColl });
  firestore.FieldValue = { serverTimestamp: () => "SERVER_TS" };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});
vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
  logHealthDataAccessed: vi.fn(async () => {}),
  logBookingCreated: vi.fn(async () => {}),
}));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));

// The mutation cores are covered by bookingCallables.test.ts — here they are
// spies so the suite pins the TOOL layer (guard ordering, error mapping,
// evidence) without replaying the booking state machine.
const cancelCore = vi.fn();
const changeCore = vi.fn();
vi.mock("../../childcare/bookingCallables", () => ({
  cancelChildcareBookingCore: (...a: unknown[]) => cancelCore(...a),
  requestChildcareBookingChangeCore: (...a: unknown[]) => changeCore(...a),
}));

import { makeFakeDb } from "../../childcare/__tests__/fakeFirestore";
import { bustChildcareFlagsCache } from "../../config/featureFlags";
import {
  executeChildcareTool,
  isAllowedInChildcareTurn,
  CHILDCARE_TOOL_NAMES,
} from "../childcareTools";

const UID = "adult-1";

function seedFlags(db: ReturnType<typeof makeFakeDb>, fields: Record<string, unknown> = {}): void {
  db.seed("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_DISCOVERY_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
    CHILDCARE_PROACTIVE_ENABLED: false,
    ...fields,
  });
}

function seedChild(db: ReturnType<typeof makeFakeDb>, childId: string, opts: {
  adultUid?: string; state?: string; scopes?: string[]; profileState?: string;
} = {}): void {
  const adultUid = opts.adultUid ?? UID;
  db.seed(`guardian_authorities/${childId}__${adultUid}`, {
    authorityId: `${childId}__${adultUid}`,
    childId, adultUid, careVertical: "child",
    scopes: opts.scopes ?? ["view", "schedule", "cancellation"],
    state: opts.state ?? "active",
    effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: null, accessVersion: 1,
  });
  db.seed(`child_profiles/${childId}`, {
    childId, householdId: "hh-1", careVertical: "child",
    displayLabel: "Mia", ageBand: "preschool", state: opts.profileState ?? "active",
  });
}

function childInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { careVertical: "child", userId: UID, clientId: UID, phone: "+15555550100", ...extra };
}

beforeEach(() => {
  bustChildcareFlagsCache();
  cancelCore.mockReset();
  changeCore.mockReset();
});

describe("vertical guard (R51 — both directions fail closed)", () => {
  it("every childcare tool denies an input without the server childcare stamp (senior turn)", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    for (const name of CHILDCARE_TOOL_NAMES) {
      for (const stamp of [undefined, "senior", ""]) {
        const res = await executeChildcareTool(name, { userId: UID, careVertical: stamp }, { db: fake.db });
        expect(res).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
      }
    }
  });

  it("a model-forged stamp without an authenticated actor is still denied", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    const res = await executeChildcareTool("list_my_children", { careVertical: "child" }, { db: fake.db });
    expect(res).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
  });

  it("returns null for non-childcare tool names (senior dispatch continues)", async () => {
    const fake = makeFakeDb();
    expect(await executeChildcareTool("get_senior_profile", childInput(), { db: fake.db })).toBeNull();
  });

  it("isAllowedInChildcareTurn: childcare pack + loop tools only (senior tools fail closed in child turns)", () => {
    expect(isAllowedInChildcareTurn("list_my_children")).toBe(true);
    expect(isAllowedInChildcareTurn("cancel_childcare_booking")).toBe(true);
    expect(isAllowedInChildcareTurn("complete_task")).toBe(true);
    expect(isAllowedInChildcareTurn("create_support_ticket")).toBe(true);
    for (const senior of ["get_senior_profile", "request_booking", "update_care_plan", "search_memory", "send_caregiver_message", "made_up_tool"]) {
      expect(isAllowedInChildcareTurn(senior), senior).toBe(false);
    }
  });
});

describe("emergency-off / flags (R61)", () => {
  it("emergencyOff makes every childcare tool unavailable mid-conversation", async () => {
    const fake = makeFakeDb();
    seedFlags(fake, { emergencyOff: true });
    seedChild(fake, "child-a");
    for (const name of CHILDCARE_TOOL_NAMES) {
      const res = await executeChildcareTool(name, childInput({ bookingId: "bk-1" }), { db: fake.db });
      expect(res).toMatchObject({ _toolError: true, code: "UNAVAILABLE" });
    }
    expect(cancelCore).not.toHaveBeenCalled();
  });

  it("master flag off behaves identically (fail closed)", async () => {
    const fake = makeFakeDb();
    seedFlags(fake, { CHILDCARE_ENABLED: false });
    const res = await executeChildcareTool("list_my_children", childInput(), { db: fake.db });
    expect(res).toMatchObject({ _toolError: true, code: "UNAVAILABLE" });
  });
});

describe("list_my_children (action-time authority)", () => {
  it("returns display labels + age bands for live-authority children only", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    seedChild(fake, "child-a");
    seedChild(fake, "child-revoked", { state: "revoked" });
    seedChild(fake, "child-foreign", { adultUid: "someone-else" });
    seedChild(fake, "child-deleted", { profileState: "deleted" });
    const res = await executeChildcareTool("list_my_children", childInput(), { db: fake.db }) as any;
    expect(res.success).toBe(true);
    expect(res.children).toHaveLength(1);
    expect(res.children[0]).toMatchObject({ childId: "child-a", displayLabel: "Mia", ageBand: "preschool" });
    // Minimum projection: no household ids, no safety fields, no DOB.
    expect(Object.keys(res.children[0]).sort()).toEqual(["ageBand", "childId", "displayLabel", "myScopes"]);
  });
});

describe("get_childcare_bookings / coordination summary", () => {
  function seedBooking(fake: ReturnType<typeof makeFakeDb>, id: string, fields: Record<string, unknown> = {}): void {
    fake.seed(`booking_requests/${id}`, {
      bookingId: id, careVertical: "child", clientId: UID, caregiverId: "cg-1",
      caregiverName: "Ana G.", recipientLabel: "Mia", childIds: ["child-a"],
      status: "confirmed", stateVersion: 2, pendingChange: null,
      schedule: { dates: [{ date: "2026-08-01", startTime: "09:00", endTime: "13:00" }], recurring: null },
      ...fields,
    });
  }

  it("lists only this family's childcare bookings", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    seedBooking(fake, "bk-1");
    fake.seed("booking_requests/bk-senior", { bookingId: "bk-senior", clientId: UID, status: "confirmed" });
    fake.seed("booking_requests/bk-foreign", { bookingId: "bk-foreign", careVertical: "child", clientId: "x", status: "confirmed" });
    const res = await executeChildcareTool("get_childcare_bookings", childInput(), { db: fake.db }) as any;
    expect(res.success).toBe(true);
    expect(res.bookings.map((b: any) => b.bookingId)).toEqual(["bk-1"]);
  });

  it("summary is enumeration-safe: senior, foreign, and missing bookings are identical NOT_FOUND", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    fake.seed("booking_requests/bk-senior", { bookingId: "bk-senior", clientId: UID, status: "confirmed" });
    fake.seed("booking_requests/bk-foreign", { bookingId: "bk-foreign", careVertical: "child", clientId: "x", status: "confirmed" });
    for (const id of ["bk-senior", "bk-foreign", "bk-missing"]) {
      const res = await executeChildcareTool("get_childcare_coordination_summary", childInput({ bookingId: id }), { db: fake.db });
      expect(res).toMatchObject({ _toolError: true, code: "NOT_FOUND" });
    }
  });

  it("summary re-checks child view authority at call time (revocation wins over booking ownership)", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    seedChild(fake, "child-a", { state: "revoked" });
    seedBooking(fake, "bk-1");
    const res = await executeChildcareTool("get_childcare_coordination_summary", childInput({ bookingId: "bk-1" }), { db: fake.db });
    expect(res).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
  });

  it("summary reports authoritative status and pending-change truth (R52 — never claim applied)", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    seedChild(fake, "child-a");
    seedBooking(fake, "bk-1", { pendingChange: { changeKey: "k1" } });
    const res = await executeChildcareTool("get_childcare_coordination_summary", childInput({ bookingId: "bk-1" }), { db: fake.db }) as any;
    expect(res.success).toBe(true);
    expect(res.status).toBe("confirmed");
    expect(res.pendingChange.pending).toBe(true);
    expect(res.pendingChange.note).toContain("NOT applied");
  });
});

describe("mutations delegate to the shared cores with fresh-read evidence (R52)", () => {
  it("cancel_childcare_booking returns authoritative post-state evidence", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    fake.seed("booking_requests/bk-1", { bookingId: "bk-1", careVertical: "child", clientId: UID, status: "canceled" });
    cancelCore.mockResolvedValue({ success: true, bookingId: "bk-1", status: "canceled" });
    const res = await executeChildcareTool("cancel_childcare_booking", childInput({ bookingId: "bk-1" }), { db: fake.db }) as any;
    expect(cancelCore).toHaveBeenCalledWith(UID, "bk-1", expect.objectContaining({ db: fake.db }));
    expect(res.success).toBe(true);
    expect(res.evidence).toMatchObject({
      kind: "fresh_read",
      targetRef: "booking_requests/bk-1",
      status: "verified",
      safeClaimCode: "completed_verified",
      careVertical: "child",
      observed: { status: "canceled" },
    });
  });

  it("downgrades the completion claim when the fresh booking state contradicts cancellation", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    fake.seed("booking_requests/bk-1", {
      bookingId: "bk-1",
      careVertical: "child",
      clientId: UID,
      status: "confirmed",
    });
    cancelCore.mockResolvedValue({ success: true, bookingId: "bk-1", status: "canceled" });
    const res = await executeChildcareTool(
      "cancel_childcare_booking",
      childInput({ bookingId: "bk-1", _boundOperationId: "op-1" }),
      { db: fake.db },
    ) as any;
    expect(res.evidence).toMatchObject({
      operationId: "op-1",
      status: "mismatch",
      safeClaimCode: "not_confirmed",
      observed: { status: "confirmed" },
    });
  });

  it("request_childcare_booking_change requires bookingId + schedule + idempotencyKey", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    const missing = await executeChildcareTool("request_childcare_booking_change", childInput({ bookingId: "bk-1" }), { db: fake.db });
    expect(missing).toMatchObject({ _toolError: true, code: "INVALID_INPUT" });
    expect(changeCore).not.toHaveBeenCalled();
  });

  it("request_childcare_booking_change reports pending-not-applied truth from the core", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    fake.seed("booking_requests/bk-1", { bookingId: "bk-1", careVertical: "child", clientId: UID, status: "confirmed" });
    changeCore.mockResolvedValue({ success: true, bookingId: "bk-1", applied: false, pending: true });
    const res = await executeChildcareTool("request_childcare_booking_change", childInput({
      bookingId: "bk-1",
      idempotencyKey: "chg-1",
      schedule: { dates: [{ date: "2026-08-02", startTime: "09:00", endTime: "12:00" }], recurring: null },
    }), { db: fake.db }) as any;
    expect(res.applied).toBe(false);
    expect(res.pending).toBe(true);
    expect(res.evidence.kind).toBe("fresh_read");
  });

  it("maps core authorization failures to enumeration-safe tool errors", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    cancelCore.mockRejectedValue(Object.assign(new Error("denied"), { code: "permission-denied" }));
    const res = await executeChildcareTool("cancel_childcare_booking", childInput({ bookingId: "bk-1" }), { db: fake.db });
    expect(res).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
  });

  it("maps childcare_disabled core failures to UNAVAILABLE", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    cancelCore.mockRejectedValue(Object.assign(new Error("off"), {
      code: "failed-precondition", details: { code: "childcare_disabled" },
    }));
    const res = await executeChildcareTool("cancel_childcare_booking", childInput({ bookingId: "bk-1" }), { db: fake.db }) as any;
    expect(res).toMatchObject({ _toolError: true, code: "UNAVAILABLE" });
    expect(res.message).toContain("unavailable");
  });
});

describe("resend_childcare_links", () => {
  it("returns the secure dashboard link (routing/status/links are SMS-safe)", async () => {
    const fake = makeFakeDb();
    seedFlags(fake);
    const res = await executeChildcareTool("resend_childcare_links", childInput(), { db: fake.db }) as any;
    expect(res.success).toBe(true);
    expect(res.link).toContain("/childcare/children");
  });
});
