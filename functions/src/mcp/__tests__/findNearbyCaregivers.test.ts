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
  const sets: Array<{ path: string; data: any; opts?: any }> = [];

  // Real FieldValue.arrayUnion is opaque server-side magic; here it's a
  // sentinel object that .set() below knows how to fold into the stored array
  // (deduping, same as the real thing) so shownCaregiverIds tests can assert
  // against docState after the call.
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
        merged[k] = v && typeof v === "object" && (v as any).__op === "arrayUnion"
          ? applyArrayUnion(existing[k], v as any)
          : v;
      }
      docState.set(path, merged);
    }),
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
    docState, collState, sets,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    loadLiveClientLocation: vi.fn(),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion: (...args: any[]) => ({ __op: "arrayUnion", args }),
      arrayRemove: () => ({}), increment: () => ({}), delete: () => ({}),
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
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));
// Browse parity (2026-09-14): the tool now texts each shown caregiver's
// profile card itself when the session has a live chat — mocked so the tests
// can assert what was sent without touching Linq.
const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("../../utils/knownNames", () => ({ addKnownNames: vi.fn().mockResolvedValue(undefined) }));

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
  sendMessage.mockClear();
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

  it("defaults to the top 4, matching the dashboard widget", async () => {
    hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg1", { rating: 5 }),
      caregiver("cg2", { rating: 4.8 }),
      caregiver("cg3", { rating: 4.6 }),
      caregiver("cg4", { rating: 4 }),
      caregiver("cg5", { rating: 3.8 }),
    ]);
    const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT }) as any;
    expect(r.available).toBe(true);
    expect(r.items).toHaveLength(4);
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

  describe("already-shown exclusion (shownCaregiverIds)", () => {
    const PHONE = "+15551234567";

    it("excludes caregivers already shown this conversation when a phone is present", async () => {
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.docState.set(`agent_sessions/${PHONE}`, { shownCaregiverIds: ["cg1", "cg2"] });
      hoisted.collState.set("publicCaregiverProfiles", [
        caregiver("cg1"), caregiver("cg2"), caregiver("cg3"), caregiver("cg4"),
      ]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, limit: 10 }) as any;
      const ids = r.items.map((i: any) => i.id);
      expect(ids).not.toContain("cg1");
      expect(ids).not.toContain("cg2");
      expect(ids).toContain("cg3");
      expect(ids).toContain("cg4");
    });

    it("records newly-shown ids onto the session so a later call excludes them", async () => {
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.collState.set("publicCaregiverProfiles", [caregiver("cg1"), caregiver("cg2")]);
      await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, limit: 10 });
      const write = hoisted.sets.find((s) => s.path === `agent_sessions/${PHONE}` && s.data.shownCaregiverIds);
      expect(write).toBeTruthy();
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`)?.shownCaregiverIds;
      expect(stored).toEqual(expect.arrayContaining(["cg1", "cg2"]));
    });

    it("trims the exclusion list to the last 3 once the pool is exhausted, so someone re-surfaces", async () => {
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.docState.set(`agent_sessions/${PHONE}`, { shownCaregiverIds: ["cg1", "cg2", "cg3", "cg4", "cg5"] });
      hoisted.collState.set("publicCaregiverProfiles", [
        caregiver("cg1"), caregiver("cg2"), caregiver("cg3"), caregiver("cg4"), caregiver("cg5"),
      ]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, limit: 10 }) as any;
      // Every known caregiver had already been shown — excluding all 5 leaves
      // nobody, so the handler trims the exclusion down to the last 3
      // (cg3-cg5) and retries, which re-surfaces cg1/cg2 instead of
      // dead-ending the conversation.
      expect(r.available).toBe(true);
      const ids = r.items.map((i: any) => i.id);
      expect(ids.some((id: string) => id === "cg1" || id === "cg2")).toBe(true);
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`)?.shownCaregiverIds;
      expect(stored).toEqual(expect.arrayContaining(["cg3", "cg4", "cg5"]));
    });
  });

  // 2026-09-06 live bug: a family who'd already interviewed a caregiver and
  // made a real hire/decline decision (hire_decisions) saw that same
  // caregiver resurface as if new on a later "show me more" ask —
  // shownCaregiverIds only ever covered "shown this conversation," never
  // "already decided". matchingAgent.ts had the identical gap, fixed the
  // same way there.
  //
  // Correction (Hamse, 2026-09-06): a DECLINE isn't permanent — the family
  // may reconsider that caregiver later, same as a plain rejection (which
  // already re-surfaces on pool exhaustion). Only a HIRE is a standing
  // relationship that should never be undone by pool exhaustion.
  // 2026-09-14: took over the removed find_replacement_caregivers' job — the
  // website's Nearby Caregivers widget shows real cards, so this tool texts
  // one per shown caregiver and records pendingMatches (source "browse") so a
  // later "meet Imran" / "send her profile again" resolves to a real id.
  describe("profile-card gallery (Browse parity)", () => {
    const PHONE = "+15550009999";

    it("texts one profile card per shown caregiver and records pendingMatches when there is a live chat", async () => {
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1" });
      hoisted.collState.set("publicCaregiverProfiles", [caregiver("cg1", { name: "Imran Ali", hourlyRate: 24 }), caregiver("cg2", { name: "Maria Santos", hourlyRate: 28 })]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, limit: 10 }) as any;
      expect(r.sent).toBe(true);
      expect(r.instruction).toMatch(/do NOT repeat/i);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(String(sendMessage.mock.calls[0][1])).toContain("Imran Ali — $24/hr");
      expect(String(sendMessage.mock.calls[0][1])).toContain("/p/cg1");
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.pendingMatchesSource).toBe("browse");
      expect(stored.pendingMatches.map((m: any) => m.id)).toEqual(["cg1", "cg2"]);
    });

    it("sends nothing and returns the plain preview when there is no chat to send to", async () => {
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.collState.set("publicCaregiverProfiles", [caregiver("cg1")]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10 }) as any;
      expect(r.available).toBe(true);
      expect(r.sent).toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("already-decided exclusion (hire_decisions)", () => {
    it("excludes a caregiver the family already hired", async () => {
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.collState.set("hire_decisions", [{ id: "hd1", clientId: CLIENT, caregiverId: "cg_hired", decision: "hire" }]);
      hoisted.collState.set("publicCaregiverProfiles", [
        caregiver("cg_hired"), caregiver("cg_new"),
      ]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, limit: 10 }) as any;
      const ids = r.items.map((i: any) => i.id);
      expect(ids).not.toContain("cg_hired");
      expect(ids).toContain("cg_new");
    });

    it("never re-surfaces a hired caregiver even once the shown-pool is exhausted and trimmed", async () => {
      const PHONE = "+15559876543";
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      hoisted.docState.set(`agent_sessions/${PHONE}`, { shownCaregiverIds: ["cg1", "cg2", "cg3"] });
      hoisted.collState.set("hire_decisions", [{ id: "hd1", clientId: CLIENT, caregiverId: "cg_hired", decision: "hire" }]);
      hoisted.collState.set("publicCaregiverProfiles", [
        caregiver("cg1"), caregiver("cg2"), caregiver("cg3"), caregiver("cg_hired"),
      ]);
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, limit: 10 }) as any;
      const ids = r.items.map((i: any) => i.id);
      expect(ids).not.toContain("cg_hired");
    });

    it("a declined caregiver re-surfaces once trimmed out of shownCaregiverIds by newer entries (unlike a hire, which never would)", async () => {
      const PHONE = "+15559876544";
      hoisted.loadLiveClientLocation.mockResolvedValue({ lat: 37.34, lng: -121.89, city: "Santa Clara" });
      // cg_declined was shown (and later declined) BEFORE cg2/cg3/cg4 — it's
      // the oldest entry, so "keep only the last 3 shown" naturally drops it.
      hoisted.docState.set(`agent_sessions/${PHONE}`, { shownCaregiverIds: ["cg_declined", "cg2", "cg3", "cg4"] });
      hoisted.collState.set("hire_decisions", [{ id: "hd1", clientId: CLIENT, caregiverId: "cg_declined", decision: "decline" }]);
      hoisted.collState.set("publicCaregiverProfiles", [
        caregiver("cg_declined"), caregiver("cg2"), caregiver("cg3"), caregiver("cg4"),
      ]);
      // All 4 excluded on the first pass (empty pool) → exhaustion escalation
      // trims shownCaregiverIds to the last 3 (cg2/cg3/cg4), which drops
      // cg_declined — it re-surfaces as the only remaining bookable candidate.
      const r = await handleToolCall("find_nearby_caregivers", { clientId: CLIENT, phone: PHONE, limit: 10 }) as any;
      const ids = r.items.map((i: any) => i.id);
      expect(ids).toContain("cg_declined");
    });
  });
});
