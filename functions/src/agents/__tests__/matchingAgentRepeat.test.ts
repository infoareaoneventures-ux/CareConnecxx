import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-06: end-to-end proof for the exact behavior Hamse pushed on —
// "if I ask Evia for more caregivers, will I actually get more?" Everything
// else this session verified the exclusion-list LOGIC by reading it; this
// test actually RUNS runMatchingForClient twice in a row against a shared
// fake session/pool and asserts the second call's picks don't overlap the
// first's, the same way findNearbyCaregivers.test.ts already proves for the
// sibling find_nearby_caregivers tool.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();

  const applyArrayUnion = (existing: unknown, op: { __op: "arrayUnion"; args: any[] }) => {
    const merged = Array.isArray(existing) ? [...existing] : [];
    for (const a of op.args) if (!merged.includes(a)) merged.push(a);
    return merged;
  };

  const makeDocRef = (path: string): any => {
    const ref: any = {
      id: path.split("/").pop(),
      path,
      set: async (data: Record<string, any>, opts?: { merge?: boolean }) => {
        const existing = docState.get(path) ?? {};
        const merged: Record<string, any> = opts?.merge ? { ...existing } : {};
        for (const [k, v] of Object.entries(data)) {
          merged[k] = v && typeof v === "object" && (v as any).__op === "arrayUnion"
            ? applyArrayUnion(existing[k], v as any)
            : v;
        }
        docState.set(path, merged);
      },
      update: async (data: Record<string, any>) => {
        const existing = docState.get(path) ?? {};
        const merged = { ...existing };
        for (const [k, v] of Object.entries(data)) {
          merged[k] = v && typeof v === "object" && (v as any).__op === "arrayUnion"
            ? applyArrayUnion(existing[k], v as any)
            : v;
        }
        docState.set(path, merged);
      },
    };
    ref.get = async () => ({ exists: docState.has(path), data: () => docState.get(path), ref });
    return ref;
  };

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto_${Math.random().toString(36).slice(2)}`}`);
    ref.add = async (data: Record<string, any>) => {
      const id = `auto_${Math.random().toString(36).slice(2)}`;
      docState.set(`${path}/${id}`, data);
      return { id };
    };
    let whereField = "";
    let whereValue: unknown;
    ref.where = (field: string, _op: string, value: unknown) => { whereField = field; whereValue = value; return ref; };
    ref.limit = () => ref;
    ref.get = async () => {
      const items = (collState.get(path) ?? []).filter((d) => !whereField || d[whereField] === whereValue);
      return { empty: items.length === 0, docs: items.map((d: any) => ({ id: d.id, data: () => d })) };
    };
    return ref;
  };

  return {
    docState, collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); },
  };
});

vi.mock("firebase-admin", () => {
  const stub = {
    apps: [{}],
    initializeApp: () => ({}),
    firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
      FieldValue: { arrayUnion: (...args: any[]) => ({ __op: "arrayUnion", args }), delete: () => ({}) },
    }),
  };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("../../linq/client", () => ({ sendMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../caraAgent", () => ({ sendViaInteractionAgent: vi.fn().mockResolvedValue(true) }));
vi.mock("../executionAgent", () => ({
  spawnExecutionAgent: vi.fn().mockResolvedValue("agent_1"),
  getActiveAgentForUser: vi.fn().mockResolvedValue(null),
  runExecutionAgentTurn: vi.fn().mockResolvedValue("Here are some great matches!"),
  updateExecutionAgentContext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/learnedFacts", () => ({ getRelevantFacts: vi.fn().mockResolvedValue([]) }));
vi.mock("../../ai/claudeMatching", () => ({
  buildMatchingSystemPrompt: () => "test system prompt",
  // Force the documented rule-score fallback path — exercises real
  // production behavior (no Claude call available in a test), not a
  // fabricated response shape.
  scoreWithClaude: vi.fn().mockRejectedValue(new Error("no Claude in tests")),
  computeSkillsCoverage: () => 80,
  detectDementiaCert: () => false,
  detectMedicalCred: () => false,
}));
vi.mock("../../ai/caregiverReputation", () => ({ getReputationBoosts: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../confidenceScore", () => ({ computeConfidenceScoreFromFields: () => ({ score: 70 }) }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://eviacares.com" }));
vi.mock("../actions/getCaregiverPreviewAction", () => ({ isSeededCaregiver: () => false }));
vi.mock("../commitmentTracker", () => ({
  recordCommitment: vi.fn().mockResolvedValue(undefined),
  resolveCommitment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../caregiverMatchScoring", () => ({
  // Fixed small distance — every seeded caregiver is "nearby" regardless of
  // exact coordinates; this test is about exclusion/repeat behavior, not
  // distance math (already covered by matchingDistance.test.ts).
  haversineDistanceMiles: () => 3,
}));
vi.mock("../../utils/geocode", () => ({ geocodeCityOrZip: vi.fn().mockResolvedValue({ lat: 37.34, lng: -121.89 }) }));
vi.mock("../qaAgent", () => ({ setActiveGoal: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../utils/knownNames", () => ({ addKnownNames: vi.fn().mockResolvedValue(undefined) }));

import { runMatchingForClient } from "../matchingAgent";

const PHONE = "+15551230001";
const CHAT_ID = "chat_1";
const CLIENT = "client_1";

function caregiver(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    name: `Caregiver ${id}`,
    onboardingStatus: "profile_complete",
    verificationStatus: "approved",
    hourlyRate: 25,
    rating: 4.5,
    yearsExperience: 5,
    specialties: ["Companionship"],
    certifications: [],
    city: "Santa Clara",
    lat: 37.34, lng: -121.89,
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set(`agent_sessions/${PHONE}`, { userId: CLIENT, chatId: CHAT_ID });
});

describe("runMatchingForClient — asking for more actually surfaces more (2026-09-06)", () => {
  it("a second call, with the same intake, returns 3 DIFFERENT caregivers than the first call — not a repeat", async () => {
    // 8 real bookable caregivers nearby — enough for two full, non-overlapping rounds of 3.
    hoisted.collState.set("publicCaregiverProfiles", Array.from({ length: 8 }, (_, i) => caregiver(`cg${i}`)));

    const intake = { seniorName: "Mom", city: "Santa Clara", zipCode: "95050", careNeeds: ["Companionship"] };

    const result1 = await runMatchingForClient(PHONE, CHAT_ID, intake, undefined, { suppressConversationalSends: true });
    expect(result1).toBe("matched");
    const shownAfterFirst = [...(hoisted.docState.get(`agent_sessions/${PHONE}`)?.shownCaregiverIds ?? [])];
    expect(shownAfterFirst).toHaveLength(3);

    // "is there more caregivers" — a second call through the exact same entry
    // point real callers use (routeIntent.ts re-reads the session fresh each
    // time, same as this does by passing session=undefined).
    const result2 = await runMatchingForClient(PHONE, CHAT_ID, intake, undefined, { suppressConversationalSends: true });
    expect(result2).toBe("matched");
    const shownAfterSecond: string[] = hoisted.docState.get(`agent_sessions/${PHONE}`)?.shownCaregiverIds ?? [];

    // All 6 distinct ids across both rounds — zero overlap, not a repeat.
    expect(shownAfterSecond).toHaveLength(6);
    const firstThree = shownAfterSecond.slice(0, 3);
    const secondThree = shownAfterSecond.slice(3);
    expect(secondThree.some((id) => firstThree.includes(id))).toBe(false);
    expect(new Set(shownAfterSecond).size).toBe(6);
  });

  it("a caregiver already hired never comes back, even on a later ask", async () => {
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg_hired"), caregiver("cg1"), caregiver("cg2"), caregiver("cg3"),
    ]);
    hoisted.collState.set("hire_decisions", [
      { clientId: CLIENT, caregiverId: "cg_hired", decision: "hire" },
    ]);
    const intake = { seniorName: "Mom", city: "Santa Clara", zipCode: "95050", careNeeds: ["Companionship"] };
    await runMatchingForClient(PHONE, CHAT_ID, intake, undefined, { suppressConversationalSends: true });
    const shown: string[] = hoisted.docState.get(`agent_sessions/${PHONE}`)?.shownCaregiverIds ?? [];
    expect(shown).not.toContain("cg_hired");
  });
});

describe("runMatchingForClient — honest re-offer instead of a false 'nobody available' (2026-09-07)", () => {
  // Live bug: a family's real local area had 2 real, eligible caregivers —
  // both already shown to them before — and Evia told them nobody was
  // available at all. The exclusion list exists to avoid repeating the exact
  // same pitch verbatim, not to make Evia lie about availability.
  it("re-offers the already-shown caregivers by name instead of claiming nobody is available", async () => {
    hoisted.collState.set("publicCaregiverProfiles", [
      caregiver("cg1", { name: "Basra" }),
      caregiver("cg2", { name: "Imran" }),
    ]);
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      userId: CLIENT, chatId: CHAT_ID, shownCaregiverIds: ["cg1", "cg2"],
    });
    const { sendMessage } = await import("../../linq/client");
    const intake = { seniorName: "Mom", city: "Santa Clara", zipCode: "95050", careNeeds: ["Companionship"] };

    const result = await runMatchingForClient(PHONE, CHAT_ID, intake, undefined, {});
    expect(result).toBe("no_match");

    const sentText = (sendMessage as any).mock.calls.at(-1)?.[1] as string;
    expect(sentText).toContain("Basra");
    expect(sentText).toContain("Imran");
    expect(sentText).not.toMatch(/nobody|no one.*available|don't have anyone/i);

    const reoffered = hoisted.docState.get(`agent_sessions/${PHONE}`)?.reofferableCaregivers;
    expect(reoffered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cg1", name: "Basra" }),
      expect.objectContaining({ id: "cg2", name: "Imran" }),
    ]));
  });

  it("still sends the honest re-offer once failureCount escalates to the urgent branch", async () => {
    hoisted.collState.set("publicCaregiverProfiles", [caregiver("cg1", { name: "Basra" })]);
    hoisted.docState.set(`agent_sessions/${PHONE}`, {
      userId: CLIENT, chatId: CHAT_ID, shownCaregiverIds: ["cg1"], consecutiveMatchFailures: 1,
    });
    const { sendMessage } = await import("../../linq/client");
    const intake = { seniorName: "Mom", city: "Santa Clara", zipCode: "95050", careNeeds: ["Companionship"] };

    await runMatchingForClient(PHONE, CHAT_ID, intake, undefined, {});
    const sentText = (sendMessage as any).mock.calls.at(-1)?.[1] as string;
    expect(sentText).toContain("Basra");
    expect(sentText).not.toContain("actively searching");
  });

  it("keeps the original honest 'nobody available' copy when there really is nobody, reofferable or not", async () => {
    hoisted.collState.set("publicCaregiverProfiles", []);
    const { sendMessage } = await import("../../linq/client");
    const intake = { seniorName: "Mom", city: "Santa Clara", zipCode: "95050", careNeeds: ["Companionship"] };

    const result = await runMatchingForClient(PHONE, CHAT_ID, intake, undefined, {});
    expect(result).toBe("no_match");
    const sentText = (sendMessage as any).mock.calls.at(-1)?.[1] as string;
    expect(sentText).toMatch(/don't have anyone available/i);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`)?.reofferableCaregivers).toBeUndefined();
  });
});
