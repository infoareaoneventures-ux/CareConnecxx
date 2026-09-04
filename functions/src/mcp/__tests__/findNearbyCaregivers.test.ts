import { describe, it, expect, vi, beforeEach } from "vitest";

// find_nearby_caregivers (2026-09-03) — the general, callable-anytime caregiver
// browse tool (vs. get_caregiver_preview, which only ever fires once, from the
// scripted onboarding step chain). Mirrors the site's Nearby Caregivers widget
// scoring (via caregiverMatchScoring.ts, reused as-is) plus the Browse
// Caregivers page's filter panel (rating/experience/rate), reading the
// client's LIVE location instead of a frozen onboarding-time snapshot.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, docs: items.map((d: any) => ({ id: d.id, data: () => d })) };
    });
    return ref;
  };

  return {
    docState, collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    loadLiveClientLocation: vi.fn(),
    reset: () => { docState.clear(); collState.clear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { arrayUnion: () => ({}), arrayRemove: () => ({}), increment: () => ({}), delete: () => ({}) },
  }),
}));
vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

// The real onboardingConversation.ts pulls in the whole SMS-sending/Zep/session
// graph — far more than this handler needs (just loadLiveClientLocation), so
// it's mocked wholesale rather than let the real module load transitively.
vi.mock("../../agents/onboardingConversation", () => ({
  loadLiveClientLocation: (...args: unknown[]) => hoisted.loadLiveClientLocation(...args),
}));

import { handleToolCall } from "../server";

const CLIENT = "client_1";

beforeEach(() => {
  hoisted.reset();
  hoisted.loadLiveClientLocation.mockReset();
});

function caregiver(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    onboardingStatus: "profile_complete",
    verificationStatus: "approved",
    name: `Caregiver ${id}`,
    lat: 37.34, lng: -121.89, // ~Santa Clara
    rating: 4.5,
    yearsExperience: 5,
    hourlyRate: 25,
    skills: ["Companionship"],
    ...overrides,
  };
}

describe("find_nearby_caregivers", () => {
  it("requires clientId", async () => {
    const r = await handleToolCall("find_nearby_caregivers", {}) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns NOT_FOUND when the client has no live location on file", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue(null);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
  });

  it("defaults to the top 2, matching the dashboard widget", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg1", { rating: 5 }),
      caregiver("cg2", { rating: 4.8 }),
      caregiver("cg3", { rating: 4 }),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(2);
  });

  it("raises the count when the family asks to see more (limit override)", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg1"), caregiver("cg2"), caregiver("cg3"), caregiver("cg4"),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 4 }) as any;
    expect(r.items).toHaveLength(4);
    expect(r.total).toBe(4);
  });

  it("caps an outlandish limit at 10", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set(
      "publicCaregiverProfiles",
      Array.from({ length: 15 }, (_, i) => caregiver(`cg${i}`)),
    );
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 999 }) as any;
    expect(r.items.length).toBeLessThanOrEqual(10);
  });

  it("applies minRating — mirrors the website's Rating filter", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg_low", { rating: 3.5 }),
      caregiver("cg_high", { rating: 4.9 }),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10, minRating: 4.5 }) as any;
    const ids = r.items.map((i: any) => i.id);
    expect(ids).toContain("cg_high");
    expect(ids).not.toContain("cg_low");
  });

  it("applies minExperienceYears — mirrors the website's Experience filter", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg_new", { yearsExperience: 1 }),
      caregiver("cg_veteran", { yearsExperience: 12 }),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10, minExperienceYears: 5 }) as any;
    const ids = r.items.map((i: any) => i.id);
    expect(ids).toContain("cg_veteran");
    expect(ids).not.toContain("cg_new");
  });

  it("applies maxHourlyRate — mirrors the website's Max Rate filter", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg_pricey", { hourlyRate: 45 }),
      caregiver("cg_affordable", { hourlyRate: 20 }),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10, maxHourlyRate: 25 }) as any;
    const ids = r.items.map((i: any) => i.id);
    expect(ids).toContain("cg_affordable");
    expect(ids).not.toContain("cg_pricey");
  });

  it("never surfaces a caregiver who isn't bookable, regardless of distance/rating", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg_unapproved", { verificationStatus: "pending", rating: 5 }),
      caregiver("cg_ok"),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10 }) as any;
    const ids = r.items.map((i: any) => i.id);
    expect(ids).not.toContain("cg_unapproved");
    expect(ids).toContain("cg_ok");
  });
});
