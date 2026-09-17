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
    expect(r.careTeam[0]).toMatchObject({ caregiverId: "cg1", name: "Alice", active: true, statusLabel: "Active booking", caringFor: "Mom", actions: ["message", "profile"] });
    expect(r.careTeam[0].phone).toBeUndefined();
    expect(r.active).toHaveLength(1);
    expect(r.past).toHaveLength(0);
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

  it("an in-progress visit also counts as active (the page's shift query is scheduled + in-progress)", async () => {
    hoisted.collState.set("booking_requests", [{ id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "accepted" }]);
    hoisted.collState.set("shifts", [{ id: "s1", clientId: CLIENT, caregiverId: "cg1", bookingRequestId: "br1", status: "in-progress", date: "2026-09-10" }]);
    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.careTeam[0].active).toBe(true);
  });

  it("a declined request is NOT a past caregiver (the page lists only cancelled/completed/finished bookings)", async () => {
    hoisted.collState.set("booking_requests", [{ id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "declined" }]);
    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.careTeam).toEqual([]);
  });

  it("Past keeps the most recent booking per caregiver and offers Re-book only after a completed interview; card fields come from the booking + publicCaregiverProfiles like the page", async () => {
    hoisted.collState.set("booking_requests", [
      { id: "old", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "cancelled", rate: 20, createdAt: { seconds: 1 }, schedule: { days: ["Mon"] } },
      { id: "new", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice", status: "completed", rate: 5, createdAt: { seconds: 9 }, schedule: { dayShiftTimes: { Tue: [], Thu: [] } }, careRecipients: [{ name: "Samira M" }, { firstName: "Imran" }] },
      { id: "b2", clientId: CLIENT, caregiverId: "cg2", caregiverName: "Bob", status: "cancelled", createdAt: { seconds: 3 } },
    ]);
    hoisted.collState.set("video_interviews", [{ id: "iv1", clientId: CLIENT, caregiverId: "cg1", status: "completed" }]);
    hoisted.docState.set("publicCaregiverProfiles/cg1", { rating: 4.5, reviewCount: 2, yearsExperience: 10, hourlyRate: 25, specializations: ["Mobility Assistance", "Dementia / Memory Care", "A", "B"], verificationStatus: "approved", photoURL: "https://cdn/a.jpg" });
    hoisted.docState.set("publicCaregiverProfiles/cg2", { hourlyRate: 30 });
    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    const alice = r.past.find((c: any) => c.caregiverId === "cg1");
    expect(alice).toMatchObject({
      bookingId: "new", bookingStatus: "completed", active: false, statusLabel: "Past", rate: 5, scheduleDays: ["Tue", "Thu"],
      ratingLabel: "4.5 (2)", verified: true, yearsExperience: 10, specialties: ["Mobility Assistance", "Dementia / Memory Care", "A"],
      caringFor: "Samira M, Imran", photoURL: "https://cdn/a.jpg", actions: ["message", "profile", "rebook"],
    });
    const bob = r.past.find((c: any) => c.caregiverId === "cg2");
    expect(bob).toMatchObject({ rate: 30, ratingLabel: "No reviews yet", verified: false, actions: ["message", "profile"] });
  });

  it("query filters by name like the page's search box; tab narrows to one list", async () => {
    hoisted.collState.set("booking_requests", [
      { id: "br1", clientId: CLIENT, caregiverId: "cg1", caregiverName: "Alice Smith", status: "accepted" },
      { id: "br2", clientId: CLIENT, caregiverId: "cg2", caregiverName: "Bob Jones", status: "cancelled" },
    ]);
    hoisted.collState.set("shifts", [{ id: "s1", clientId: CLIENT, bookingRequestId: "br1", status: "scheduled", date: "2026-09-10" }]);
    expect(((await handleToolCall("get_care_team", { clientId: CLIENT, query: "bob" })) as any).careTeam.map((c: any) => c.name)).toEqual(["Bob Jones"]);
    const activeOnly = await handleToolCall("get_care_team", { clientId: CLIENT, tab: "active" }) as any;
    expect(activeOnly.careTeam.map((c: any) => c.name)).toEqual(["Alice Smith"]);
    expect(activeOnly.past).toEqual([]);
  });

  it("returns an empty team when nothing is on file", async () => {
    const r = await handleToolCall("get_care_team", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.careTeam).toEqual([]);
  });
});
