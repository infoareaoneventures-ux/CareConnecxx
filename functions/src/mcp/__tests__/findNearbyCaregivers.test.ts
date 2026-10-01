import { describe, it, expect, vi, beforeEach } from "vitest";

// find_nearby_caregivers = the website's Find Caregivers page (2026-09-17):
// same pool (publicCaregiverProfiles, bookable only), same filter panel, same
// sort, same card and button states, texted to the family one card at a
// time. The former Evia-only extras (never re-show, hide hired/declined,
// widen when empty, care-needs ranking, hard NOT_FOUND without a location)
// are gone — the page has none of them.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];
  const applyArrayUnion = (existing: unknown, op: { __op: "arrayUnion"; args: any[] }) => {
    const merged = Array.isArray(existing) ? [...existing] : [];
    for (const a of op.args) if (!merged.includes(a)) merged.push(a);
    return merged;
  };
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: Record<string, any>, opts?: { merge?: boolean }) => {
      sets.push({ path, data, opts });
      const existing = docState.get(path) ?? {};
      const merged: Record<string, any> = opts?.merge ? { ...existing } : {};
      for (const [k, v] of Object.entries(data)) {
        merged[k] = v && typeof v === "object" && (v as any).__op === "arrayUnion" ? applyArrayUnion(existing[k], v as any) : v;
      }
      docState.set(path, merged);
    }),
    update: vi.fn(async () => {}),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, docs: items.map((d: any) => ({ id: d.id, data: () => d })) };
    });
    return ref;
  };
  return {
    docState, collState, sets,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion: (...args: any[]) => ({ __op: "arrayUnion", args }),
      arrayRemove: () => ({}), increment: () => ({}), delete: () => ({ __delete: true }), serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  }),
}));
vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://app.test", appLink: (p: string) => `https://app.test${p}` }));
const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("../../utils/knownNames", () => ({ addKnownNames: vi.fn().mockResolvedValue(undefined) }));

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const PHONE = "+15550001111";

function caregiver(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    onboardingStatus: "profile_complete",
    verificationStatus: "approved",
    firstName: `Care`, lastName: id,
    lat: 37.34, lng: -121.89, // Santa Clara
    rating: 4.5, reviewCount: 3,
    experience: 5,
    hourlyRate: 25,
    skills: ["Companionship"],
    languages: ["English"],
    city: "Santa Clara", state: "CA", zipCode: "95050",
    backgroundCheckComplete: true,
    ...overrides,
  };
}
const withChat = () => hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1", userId: CLIENT });
const nearSanJose = () => hoisted.docState.set(`senior_profiles/${CLIENT}`, { latitude: 37.33, longitude: -121.89 });
const sentTexts = () => sendMessage.mock.calls.map((c: any[]) => String(c[1]));

beforeEach(() => { hoisted.reset(); sendMessage.mockClear(); });

describe("find_nearby_caregivers — the Find Caregivers page", () => {
  it("requires clientId", async () => {
    const r = await handleToolCall("find_nearby_caregivers", {}) as any;
    expect(r._toolError).toBe(true);
  });

  it("with no live chat, returns the page's data: pool, default sort (Highest rated), card fields and button state", async () => {
    nearSanJose();
    hoisted.collState.set("publicCaregiverProfiles", [caregiver("a", { rating: 4.2 }), caregiver("b", { rating: 4.9 }), caregiver("c", { verificationStatus: "submitted" })]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.total).toBe(2); // 'c' isn't bookable
    expect(r.caregivers.map((c: any) => c.id)).toEqual(["b", "a"]);
    expect(r.caregivers[0]).toMatchObject({ name: "Care b", hourlyRate: 25, rating: 4.9, reviewCount: 3, verified: true, city: "Santa Clara", stateCode: "CA", zipCode: "95050", skills: ["Companionship"] });
    expect(r.caregivers[0].state).toBe("request_interview");
    expect(r.caregivers[0].actions).toEqual(["message", "request_interview"]);
    expect(r.caregivers[0].profileUrl).toBe("https://app.test/p/b");
  });

  it("does not need a location on file — the page simply skips the distance filter (no NOT_FOUND)", async () => {
    hoisted.collState.set("publicCaregiverProfiles", [caregiver("a")]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.total).toBe(1);
    expect(r.hasLocation).toBe(false);
  });

  it("applies the page's filters: distance (default 25 mi + the caregiver's own radius), max rate, rating, experience, background checked, transportation, specialties (any), languages (any), search", async () => {
    nearSanJose();
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("near"),
      caregiver("far", { lat: 38.58, lng: -121.49 }),             // Sacramento, ~90 mi
      caregiver("radius", { serviceRadius: 1, lat: 37.60, lng: -122.0 }), // ~19 mi, but only travels 1
      caregiver("pricey", { hourlyRate: 80 }),
      caregiver("lowrated", { rating: 3.5 }),
      caregiver("junior", { experience: 1 }),
      caregiver("unchecked", { backgroundCheckComplete: false, verified: false }),
      caregiver("dementia", { skills: ["Dementia / Memory Care"], languages: ["Spanish"], firstName: "Maria", lastName: "Santos", city: "Los Altos Hills" }),
    ]);
    const ids = async (input: Record<string, unknown>) => ((await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10, ...input })) as any).caregivers.map((c: any) => c.id).sort();
    expect(await ids({})).toEqual(["dementia", "junior", "lowrated", "near", "unchecked"]);           // pricey ($80 > $75 default), far, radius dropped
    expect(await ids({ maxHourlyRate: 100 })).toEqual(["dementia", "junior", "lowrated", "near", "pricey", "unchecked"]); // 100 = no cap
    expect(await ids({ maxDistanceMiles: 200 })).toEqual(["dementia", "far", "junior", "lowrated", "near", "unchecked"]); // radius still excluded by its own 1-mile radius
    expect(await ids({ minRating: 4 })).toEqual(["dementia", "junior", "near", "unchecked"]);
    expect(await ids({ minExperienceYears: 3 })).toEqual(["dementia", "lowrated", "near", "unchecked"]);
    expect(await ids({ verifiedOnly: true })).toEqual(["dementia", "junior", "lowrated", "near"]);
    expect(await ids({ transportationOnly: true })).toEqual([]);
    expect(await ids({ specialties: ["Dementia / Memory Care"] })).toEqual(["dementia"]);
    expect(await ids({ languages: ["spanish"] })).toEqual(["dementia"]);
    expect(await ids({ query: "los altos" })).toEqual(["dementia"]);
    expect(await ids({ query: "maria" })).toEqual(["dementia"]);
  });

  it("sorts like the page's dropdown: Highest rated, Price: Low to High, Price: High to Low", async () => {
    hoisted.collState.set("publicCaregiverProfiles", [caregiver("a", { rating: 4.0, hourlyRate: 30 }), caregiver("b", { rating: 5.0, hourlyRate: 20 }), caregiver("c", { rating: 4.5, hourlyRate: 40 })]);
    const order = async (sortBy: string) => ((await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, sortBy })) as any).caregivers.map((c: any) => c.id);
    expect(await order("rating")).toEqual(["b", "c", "a"]);
    expect(await order("price-low")).toEqual(["b", "a", "c"]);
    expect(await order("price-high")).toEqual(["c", "a", "b"]);
  });

  it("the Favorites tab (favoritesOnly) reads users.savedCaregiverIds, and blocked users are hidden", async () => {
    hoisted.docState.set(`users/${CLIENT}`, { savedCaregiverIds: ["fav"], blockedUsers: ["blocked"] });
    hoisted.collState.set("publicCaregiverProfiles", [caregiver("fav"), caregiver("other"), caregiver("blocked")]);
    const all = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    expect(all.caregivers.map((c: any) => c.id).sort()).toEqual(["fav", "other"]);
    expect(all.caregivers.find((c: any) => c.id === "fav").isFavorite).toBe(true);
    const favs = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, favoritesOnly: true }) as any;
    expect(favs.caregivers.map((c: any) => c.id)).toEqual(["fav"]);
  });

  it("card button state matches the page: Active Booking (accepted + live shift), Re-book (accepted, no live shift, interviewed), Interview requested, else Request Interview — and never hides anyone the family already met", async () => {
    hoisted.collState.set("publicCaregiverProfiles", [caregiver("booked"), caregiver("done"), caregiver("asked"), caregiver("fresh")]);
    hoisted.collState.set("booking_requests", [
      { id: "b1", clientId: CLIENT, caregiverId: "booked", status: "accepted" },
      { id: "b2", clientId: CLIENT, caregiverId: "done", status: "accepted" },
    ]);
    hoisted.collState.set("shifts", [{ id: "s1", clientId: CLIENT, bookingRequestId: "b1", status: "scheduled" }]);
    hoisted.collState.set("video_interviews", [
      { id: "iv1", clientId: CLIENT, caregiverId: "done", status: "completed" },
      { id: "iv2", clientId: CLIENT, caregiverId: "asked", status: "requested" },
    ]);
    hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1", userId: CLIENT, shownCaregiverIds: ["fresh", "asked"] });
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    const byId = Object.fromEntries(r.caregivers.map((c: any) => [c.id, c]));
    expect(byId.booked).toMatchObject({ state: "active_booking", actions: ["message"] });
    expect(byId.done).toMatchObject({ state: "rebook", actions: ["message", "rebook"] });
    expect(byId.asked).toMatchObject({ state: "interview_requested", actions: ["message"] });
    expect(byId.fresh).toMatchObject({ state: "request_interview", actions: ["message", "request_interview"] });
    expect(r.total).toBe(4);
  });

  describe("texting the page (live chat)", () => {
    it("texts '<N> caregivers found', one card per caregiver (page fields + profile link), records pendingMatches, and tells the agent not to repeat", async () => {
      withChat();
      hoisted.collState.set("publicCaregiverProfiles", [
        caregiver("b", { rating: 4.9, reviewCount: 12, firstName: "Basra", lastName: "Yousuf", experience: 10, skills: ["Mobility Assistance", "Dementia / Memory Care", "A", "B"], city: "San Jose", zipCode: "95134" }),
        caregiver("a", { rating: 4.2, reviewCount: 0 }),
      ]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE }) as any;
      expect(r).toMatchObject({ success: true, total: 2, shownCount: 2, hasMore: false });
      expect(r.instruction).toContain("do NOT repeat");
      const texts = sentTexts();
      expect(texts[0]).toBe("2 caregivers found:");
      expect(texts[1]).toBe("Basra Yousuf — $25/hr · $27.25/hr billed\n★ 4.9 (12 reviews) · 10 yrs experience · San Jose, CA 95134 · Mobility Assistance, Dementia / Memory Care +2 · Background checked\nTap to view Basra's profile: https://app.test/p/b");
      expect(texts[2]).toContain("No reviews yet");
      const sess = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(sess.pendingMatches).toEqual([{ id: "b", name: "Basra Yousuf", rate: 25 }, { id: "a", name: "Care a", rate: 25 }]);
      expect(sess.pendingMatchesSource).toBe("browse");
      expect(sess.shownCaregiverIds).toEqual(["b", "a"]);
    });

    it("defaults to 4 cards and pages with offset + the same filters for 'show me more' (nobody is hidden for having been shown)", async () => {
      withChat();
      hoisted.collState.set("publicCaregiverProfiles", ["a", "b", "c", "d", "e", "f"].map((id, i) => caregiver(id, { rating: 5 - i * 0.1 })));
      const first = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE }) as any;
      expect(first.shown.map((c: any) => c.id)).toEqual(["a", "b", "c", "d"]);
      expect(first.hasMore).toBe(true);
      expect(first.instruction).toContain("offset = 4");
      expect(sentTexts()[0]).toBe("6 caregivers found — here are the first 4:");
      sendMessage.mockClear();
      const more = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, offset: 4 }) as any;
      expect(more.shown.map((c: any) => c.id)).toEqual(["e", "f"]);
      expect(more.hasMore).toBe(false);
      expect(sentTexts()[0]).toBe("6 caregivers found — here are the next 2:");
    });

    it("texts the page's empty state: filters set → 'No caregivers match your filters'; none set → 'No caregivers available yet' + offer to post a care request", async () => {
      withChat();
      hoisted.collState.set("publicCaregiverProfiles", [caregiver("a", { hourlyRate: 60 })]);
      const filtered = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, maxHourlyRate: 30 }) as any;
      expect(filtered.total).toBe(0);
      expect(sentTexts()[0]).toContain("No caregivers match your filters (up to $30/hr)");
      sendMessage.mockClear();
      hoisted.collState.set("publicCaregiverProfiles", []);
      const none = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE }) as any;
      expect(none.total).toBe(0);
      expect(sentTexts()[0]).toContain("No caregivers available yet");
      expect(sentTexts()[0]).toContain("post a care request");
    });
  });
});
