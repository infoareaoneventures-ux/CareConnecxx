import { describe, it, expect, vi, beforeEach } from "vitest";

// My Care Team page parity (2026-08-31 audit): get_care_team was still 100%
// appointments-only, the exact same class of gap already fixed for the ~20
// scheduled jobs — a caregiver booked via the newer booking_requests/shifts
// pipeline was invisible to "who's on my care team?" entirely. Rewrote to
// match components/client/MyCareTeam.tsx's real logic: a caregiver is
// "active" only when their booking_requests doc is accepted AND still has a
// scheduled shift, one card per caregiver (active takes priority over past),
// merged with the legacy appointments pipeline for bookings that predate it.

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, docs: items.map((d: any) => ({ id: d.id, data: () => d })) };
    });
    return ref;
  };

  return {
    docState, collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }), storage: () => ({}) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {}),
  storage: () => ({}),
}));

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));

import { handleToolCall } from "../server";

const CLIENT = "client_1";

describe("get_care_team", () => {
  beforeEach(() => {
    hoisted.reset();
    hoisted.collState.set("booking_requests", []);
    hoisted.collState.set("shifts", []);
    hoisted.collState.set("appointments", []);
  });

  it("a caregiver accepted via the new pipeline WITH a scheduled shift shows as active", async () => {
    hoisted.collState.set("booking_requests", [
      { id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "accepted", careRecipients: [{ firstName: "Mom" }] },
    ]);
    hoisted.collState.set("shifts", [
      { id: "s1", clientId: CLIENT, caregiverId: "cg1", bookingRequestId: "br1", status: "scheduled", date: "2026-09-10" },
    ]);
    hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15551234567", rating: 4.9 });

    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.careTeam).toHaveLength(1);
    expect(r.careTeam[0]).toMatchObject({ caregiverId: "cg1", name: "Alice", active: true, nextShift: "2026-09-10", caringFor: "Mom" });
  });

  it("a caregiver accepted but with NO scheduled shifts left shows as past, not active", async () => {
    hoisted.collState.set("booking_requests", [
      { id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "accepted" },
    ]);
    // No matching shifts doc for br1 — all visits already ran out.
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });

    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.careTeam[0]).toMatchObject({ caregiverId: "cg1", active: false });
  });

  it("a cancelled booking shows as past", async () => {
    hoisted.collState.set("booking_requests", [
      { id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "cancelled" },
    ]);
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });
    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.careTeam[0]).toMatchObject({ active: false });
  });

  it("the same caregiver never appears twice even if both an old appointment and a new active booking exist", async () => {
    hoisted.collState.set("booking_requests", [
      { id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "accepted" },
    ]);
    hoisted.collState.set("shifts", [
      { id: "s1", clientId: CLIENT, caregiverId: "cg1", bookingRequestId: "br1", status: "scheduled", date: "2026-09-10" },
    ]);
    hoisted.collState.set("appointments", [
      { id: "a1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "completed", date: "2026-01-01" },
    ]);
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });

    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.careTeam).toHaveLength(1);
    expect(r.careTeam[0].active).toBe(true);
  });

  it("a legacy appointments-only caregiver (old pipeline, never migrated) still shows up", async () => {
    hoisted.collState.set("appointments", [
      { id: "a1", clientId: CLIENT, caregiverId: "cg2", caregiverName: "Bob", status: "confirmed", date: "2026-09-20" },
    ]);
    hoisted.docState.set("caregivers/cg2", { name: "Bob" });

    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.careTeam).toHaveLength(1);
    expect(r.careTeam[0]).toMatchObject({ caregiverId: "cg2", name: "Bob", active: true, nextShift: "2026-09-20" });
  });

  it("returns an empty team when nothing is on file", async () => {
    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.careTeam).toEqual([]);
  });
});
