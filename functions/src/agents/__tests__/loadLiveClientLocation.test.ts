import { describe, it, expect, beforeEach, vi } from "vitest";

// 2026-09-06 live bug: a phone-only client (never opened the website) asking
// Evia to browse caregivers got "no location on file" even though
// geocodeClientIntake (triggers/clientIntakeGeocode.ts) HAD already geocoded
// their address — it writes users/{uid}.latitude/.longitude, but
// loadLiveClientLocation only checked users.lat/.lng (short names) as its
// fallback, so real, already-written coordinates were invisible to
// find_nearby_caregivers. This locks in the fix.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
  });
  const makeCollRef = (path: string): any => ({ doc: (id: string) => makeDocRef(`${path}/${id}`) });
  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

// Peripheral stubs so onboardingConversation.ts's module graph loads (same
// set clientMembershipCustomerLink.test.ts already uses for this file).
vi.mock("stripe", () => ({ __esModule: true, default: vi.fn(() => ({})) }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn() }));
vi.mock("../../utils/jsonUtils", () => ({ unwrapJson: vi.fn() }));
vi.mock("../../notifications", () => ({ notifyAdminNewClientSignup: vi.fn(), notifyAdminNewCaregiverSignup: vi.fn() }));
vi.mock("../../memory/memoryFiles", () => ({ initializeMemoryFiles: vi.fn(), writeMemoryFile: vi.fn() }));
vi.mock("../../memory/zepClient", () => ({ pushOnboardingDataToZep: vi.fn(), addBusinessDataToZep: vi.fn(), getZepUserId: vi.fn() }));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn() }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async (opts: any) => opts.fallback ?? "msg") }));
vi.mock("../../utils/phoneVerification", () => ({
  generateOtp: vi.fn(), verifyOtp: vi.fn(), formatOtpForDisplay: vi.fn(), OtpState: {},
}));
vi.mock("../../utils/language", () => ({ languageFromSession: () => "en", t: {} }));
vi.mock("../../safety/supervisor", () => ({ supervise: async (_ctx: unknown, content: string) => content }));
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));
vi.mock("../../linq/client", () => ({
  sendMessage: vi.fn(async () => ({ message_id: "m1" })),
  signalThinking: vi.fn(async () => {}),
}));
vi.mock("../commitmentTracker", () => ({ recordCommitment: vi.fn(async () => "c1"), resolveCommitment: vi.fn(async () => {}) }));
vi.mock("../../utils/linkRedirects", () => ({ createBrandedLink: vi.fn(async (_k: string, url: string) => url) }));
vi.mock("../tokenService", () => ({ generateToken: () => "tok-123" }));

import { loadLiveClientLocation } from "../onboardingConversation";

const UID = "uid-1";

beforeEach(() => { hoisted.reset(); });

describe("loadLiveClientLocation", () => {
  it("prefers senior_profiles.latitude/longitude when present", async () => {
    hoisted.docState.set(`senior_profiles/${UID}`, { latitude: 1, longitude: 2, zipCode: "95111" });
    hoisted.docState.set(`users/${UID}`, { city: "San Jose", state: "CA", lat: 9, lng: 9 });
    const loc = await loadLiveClientLocation(UID);
    expect(loc).toMatchObject({ lat: 1, lng: 2, zipCode: "95111", city: "San Jose", state: "CA" });
  });

  it("falls back to users.lat/.lng when senior_profiles has no coords", async () => {
    hoisted.docState.set(`users/${UID}`, { city: "San Jose", lat: 3, lng: 4 });
    const loc = await loadLiveClientLocation(UID);
    expect(loc).toMatchObject({ lat: 3, lng: 4 });
  });

  it("falls back to users.latitude/.longitude (geocodeClientIntake's field names) when neither senior_profiles nor users.lat/.lng have coords", async () => {
    hoisted.docState.set(`users/${UID}`, { city: "San Jose", state: "CA", latitude: 37.3361663, longitude: -121.890591 });
    const loc = await loadLiveClientLocation(UID);
    expect(loc).toMatchObject({ lat: 37.3361663, lng: -121.890591, city: "San Jose", state: "CA" });
  });

  it("returns null when no location data exists anywhere", async () => {
    const loc = await loadLiveClientLocation(UID);
    expect(loc).toBeNull();
  });

  it("returns null when only strings (no coords at all) are on file — the exact shape of the live bug", async () => {
    hoisted.docState.set(`users/${UID}`, { city: "San Jose", state: "CA", street: "4746 Campbell Ave", zipCode: "95111" });
    const loc = await loadLiveClientLocation(UID);
    expect(loc?.lat).toBeUndefined();
    expect(loc?.lng).toBeUndefined();
  });
});
