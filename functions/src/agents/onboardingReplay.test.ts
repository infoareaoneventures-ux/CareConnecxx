// Onboarding replay harness + synthetic corpus (U11).
//
// Establishes the PARITY ORACLE for the U12 prompt-driven dispatcher: it drives
// the *legacy* `handleOnboardingStep` machine directly (a different entry point
// than runQaAgent, so this is new scaffolding, not a goldenTranscripts
// extension) and asserts, for each transcript, the fields collected + the step
// the machine lands on. When U12 lands, the same corpus runs against the
// dispatcher and must produce identical field-collection + routing.
//
// The single-shot parser (gpt-4o-mini via quickComplete) is mocked by a
// prompt-aware ROUTER: the detectors default to "no role switch / no correction
// / not a question / nothing absorbed" so the happy path flows, and each
// transcript turn supplies the field-extraction return it wants. generateCaraMessage
// returns its fallback (deterministic copy), exactly as goldenTranscripts does
// for the QA agent.
//
// Edge transcripts are derived from the documented SMS-audit P0s (mid-flow
// question, correction) — authored against the legacy machine's behavior so the
// oracle isn't circular with the future dispatcher.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PHONE = "+15555550111";
const CHAT  = "chat-onb";
const SESSION_PATH = `agent_sessions/${PHONE}`;

// ── Mutable per-turn parser control (read by the quickComplete router) ────────
interface TurnParses {
  role?:       string;   // ask_role → "client" | "caregiver" | "unclear"
  parse?:      string;   // the step handler's main field-extraction return
  absorb?:     string;   // absorbClientFields JSON
  isQuestion?: string;   // isQuestionOrOther → "YES" | "NO"
  correction?: string;   // detectCorrection → JSON | "null"
}
let CURRENT: TurnParses = {};

// A transitive import (ai/embeddings via the trigger graph) calls
// `functions.config()` at module load. The root vitest alias stubs
// firebase-functions to an empty module with no `config`, so provide a permissive
// one: every property is a chainable callable, and config() returns {} so the
// `?.api_key` lookups resolve to undefined (no real client constructed).
vi.mock("firebase-functions/v1", () => {
  const fn: any = new Proxy(() => fn, { get: () => fn, apply: () => fn });
  return { __esModule: true, default: fn, config: () => ({}), https: fn, pubsub: fn, firestore: fn, logger: fn, region: () => fn };
});
vi.mock("firebase-functions", () => {
  const fn: any = new Proxy(() => fn, { get: () => fn, apply: () => fn });
  return { __esModule: true, default: fn, config: () => ({}), https: fn, pubsub: fn, firestore: fn, logger: fn, region: () => fn };
});

// ── Firestore mock — a single agent_sessions doc store + a write counter ──────
const SESSIONS = new Map<string, Record<string, unknown>>();
let writeCount = 0;
let authCreateCount = 0;

function applyMerge(path: string, data: Record<string, unknown>, merge: boolean): void {
  const prev = SESSIONS.get(path) ?? {};
  const base: Record<string, unknown> = merge ? { ...prev } : {};
  // Expand Firestore dotted field paths (e.g. "onboardingData.firstName") into
  // nested updates, the way real .update() does. The runStep persistence path
  // (mergeAndAdvance) writes dotted keys; a flat spread would store the literal
  // "onboardingData.firstName" key and leave onboardingData empty.
  for (const [k, v] of Object.entries(data)) {
    if (k.includes(".")) {
      const parts = k.split(".");
      let cur = base;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        cur[seg] = (cur[seg] && typeof cur[seg] === "object") ? { ...(cur[seg] as Record<string, unknown>) } : {};
        cur = cur[seg] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = v;
    } else {
      base[k] = v;
    }
  }
  SESSIONS.set(path, base);
}

vi.mock("firebase-admin", () => {
  const query: any = { where: () => query, orderBy: () => query, limit: () => query, get: async () => ({ empty: true, size: 0, docs: [] }) };
  const docRef = (path: string): any => ({
    id: path.split("/").pop(),
    get:    async () => ({ exists: SESSIONS.has(path), data: () => SESSIONS.get(path) }),
    update: async (u: Record<string, unknown>) => { writeCount++; applyMerge(path, u, true); },
    set:    async (d: Record<string, unknown>, opts?: { merge?: boolean }) => { writeCount++; applyMerge(path, d, !!opts?.merge); },
    delete: async () => { writeCount++; SESSIONS.delete(path); },
    collection: (sub: string) => collRef(`${path}/${sub}`),
  });
  const collRef = (name: string): any => ({
    doc: (id?: string) => docRef(`${name}/${id ?? "auto"}`),
    add: async () => { writeCount++; return { id: "auto-id" }; },
    where: query.where, orderBy: query.orderBy, limit: query.limit, get: query.get,
  });
  const firestore = Object.assign(() => ({ collection: collRef, batch: () => ({ set: () => {}, update: () => {}, commit: async () => { writeCount++; } }) }), {
    FieldValue: { arrayUnion: (...v: unknown[]) => ({ __au: v }), delete: () => ({ __del: true }) },
  });
  const auth = () => ({
    createUser: async () => { authCreateCount++; return { uid: "real-uid" }; },
    getUserByPhoneNumber: async () => ({ uid: "existing-uid" }),
  });
  return { __esModule: true, default: { firestore, auth, apps: [], initializeApp: () => ({}) }, firestore, auth, apps: [], initializeApp: () => ({}) };
});

// ── Parser + copy mocks ───────────────────────────────────────────────────────
function route(systemPrompt: string): string {
  const p = systemPrompt;
  if (p.includes("Reply YES if this is a general question")) return CURRENT.isQuestion ?? "NO";
  if (p.includes("switchTo"))                                 return '{"switchTo":"none"}';
  if (p.includes("Detect if they are correcting"))            return CURRENT.correction ?? "null";
  if (p.includes("extracting onboarding details"))            return CURRENT.absorb ?? "{}";
  if (p.includes("choosing between two options"))             return CURRENT.role ?? "unclear";
  // Field extractors (name / senior / needs / location / schedule) + the
  // mid-flow answer call all funnel through here:
  return CURRENT.parse ?? "{}";
}
const sentChunks: string[] = [];
vi.mock("../utils/openaiClient", () => ({
  quickComplete:   vi.fn(async (sys: string) => route(sys)),
  getOpenAIClient: () => ({ chat: { completions: { create: vi.fn() } } }),
}));
vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));
vi.mock("../linq/client", () => ({
  sendMessage:   vi.fn(async (_chatId: string, body: string) => { sentChunks.push(body); return { message_id: "m" }; }),
  signalThinking: vi.fn(async () => undefined),
  AgentSession:  {},
}));
// Neutral stubs for the rest of the conversational dependency graph.
vi.mock("./emotionalContext", () => ({
  classifyEmotionalContext:       vi.fn(async () => "calm"),
  classifyEmotionalTopic:         () => "general",
  blendEmotionalContext:          (_s: unknown, c: string) => ({ value: c, persist: null }),
  buildEmotionalContextDirective: () => "",
}));
vi.mock("../memory/memoryFiles", () => ({ initializeMemoryFiles: vi.fn(async () => undefined), writeMemoryFile: vi.fn(async () => undefined) }));
vi.mock("../memory/zepClient", () => ({ pushOnboardingDataToZep: vi.fn(async () => undefined), addBusinessDataToZep: vi.fn(async () => undefined), getZepUserId: () => "z" }));
vi.mock("../notifications", () => ({ notifyAdminNewClientSignup: vi.fn(async () => undefined), notifyAdminNewCaregiverSignup: vi.fn(async () => undefined) }));
vi.mock("../utils/locationShare", () => ({ reverseGeocode: vi.fn(async () => ({ city: "Austin", zipCode: "78701" })) }));
vi.mock("../utils/mediaIntake", () => ({ downloadMedia: vi.fn(async () => null), storeInboundMedia: vi.fn(async () => undefined) }));
vi.mock("../utils/visionVerify", () => ({ verifyProfilePhoto: vi.fn(async () => ({ ok: true })), verifyDocument: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/knownNames", () => ({ addKnownNames: vi.fn(async () => undefined) }));

import { handleOnboardingStep } from "./onboardingConversation";
import { runOnboardingDryRun } from "./onboardingDryRun";
import { resolveClientStep } from "./onboardingDispatcher";

interface Turn { text: string; parses?: TurnParses; }

async function runTurns(start: Record<string, unknown>, turns: Turn[]): Promise<Record<string, unknown>> {
  SESSIONS.set(SESSION_PATH, {
    onboardingStep: start.onboardingStep ?? "ask_role",
    userType:       start.userType ?? null,
    onboardingData: start.onboardingData ?? {},
  });
  for (const turn of turns) {
    CURRENT = turn.parses ?? {};
    const session = { ...(SESSIONS.get(SESSION_PATH) as any) };
    await handleOnboardingStep(PHONE, CHAT, turn.text, session);
  }
  return SESSIONS.get(SESSION_PATH)!;
}

const data = (s: Record<string, unknown>) => (s.onboardingData ?? {}) as Record<string, unknown>;

beforeEach(() => {
  SESSIONS.clear();
  sentChunks.length = 0;
  writeCount = 0;
  authCreateCount = 0;
  CURRENT = {};
});

describe("onboarding replay — legacy parity oracle (U11)", () => {
  // Onboarding is now default-flipped (U12 live). Force the LEGACY machine here so
  // this stays an INDEPENDENT oracle (testing the dispatcher against itself would
  // be circular). The U12 describe below exercises the flipped dispatcher.
  const prevUnflip = process.env.CONVERGENCE_UNFLIPPED;
  beforeEach(() => { process.env.CONVERGENCE_UNFLIPPED = "onboarding"; });
  afterEach(()  => { if (prevUnflip === undefined) delete process.env.CONVERGENCE_UNFLIPPED; else process.env.CONVERGENCE_UNFLIPPED = prevUnflip; });

  it("client happy path: collects every conversational field and walks the step order", async () => {
    const final = await runTurns({ onboardingStep: "ask_role" }, [
      { text: "1 — I need care for my mom",            parses: { role: "client" } },
      { text: "I'm Sarah",                             parses: { parse: "Sarah" } },
      { text: "my mom Dorothy",                        parses: { parse: '{"seniorName":"Dorothy","relationship":"mother"}' } },
      { text: "she's 82, has dementia, needs bathing", parses: { parse: '{"age":82,"careNeeds":["bathing"],"conditions":["dementia"]}' } },
      { text: "Austin, TX 78701",                      parses: { parse: '{"city":"Austin","zipCode":"78701"}' } },
      { text: "3 mornings a week",                     parses: { parse: '{"daysPerWeek":3,"timeOfDay":"morning","hoursPerDay":4}' } },
    ]);

    expect(final.userType).toBe("client");
    const d = data(final);
    expect(d.firstName).toBe("Sarah");
    expect(d.seniorName).toBe("Dorothy");
    expect(d.age).toBe(82);
    expect(d.city).toBe("Austin");
    expect(d.zipCode).toBe("78701");
    expect(d.daysPerWeek).toBe(3);
    // Schedule was the last absorbable step → machine advances past it.
    expect(final.onboardingStep).toBe("client_ask_start");
  });

  it("multi-field absorption: one front-loaded message fills several fields and auto-advances", async () => {
    const final = await runTurns({ onboardingStep: "client_ask_name", userType: "client" }, [
      {
        text: "Sarah here — my mom Dorothy is 82 with dementia, we're in Austin 78701",
        parses: { absorb: '{"firstName":"Sarah","seniorName":"Dorothy","age":82,"city":"Austin","zipCode":"78701"}', parse: '{"daysPerWeek":3,"timeOfDay":"morning","hoursPerDay":4}' },
      },
    ]);
    const d = data(final);
    expect(d.firstName).toBe("Sarah");
    expect(d.seniorName).toBe("Dorothy");
    expect(d.age).toBe(82);
    expect(d.city).toBe("Austin");
    // Absorption auto-skipped the name/senior/needs/location steps.
    expect(final.onboardingStep).not.toBe("client_ask_name");
  });

  it("SMS-audit P0 — mid-flow question does NOT collect a field and re-asks", async () => {
    const final = await runTurns({ onboardingStep: "client_ask_name", userType: "client" }, [
      { text: "wait, how much does this cost per month?", parses: { isQuestion: "YES" } },
    ]);
    // No name captured; still on the same step.
    expect(data(final).firstName).toBeUndefined();
    expect(final.onboardingStep).toBe("client_ask_name");
    // The question was answered AND the name question re-asked.
    expect(sentChunks.some((c) => /name/i.test(c))).toBe(true);
  });

  it("SMS-audit P0 — mid-flow correction updates the field and re-asks the current step", async () => {
    const final = await runTurns({ onboardingStep: "client_ask_senior", userType: "client", onboardingData: { firstName: "Sara" } }, [
      { text: "actually my name is Sarah, not Sara", parses: { correction: '{"field":"firstName","value":"Sarah"}' } },
    ]);
    expect(data(final).firstName).toBe("Sarah");           // corrected
    expect(final.onboardingStep).toBe("client_ask_senior"); // stayed on current step
    expect(sentChunks.some((c) => /updated/i.test(c))).toBe(true);
  });
});

describe("prompt-driven dispatcher (U12)", () => {
  it("resolveClientStep derives the next step from missing fields (field-schema contract)", () => {
    expect(resolveClientStep({})).toBe("client_ask_name");
    expect(resolveClientStep({ firstName: "Sarah" })).toBe("client_ask_senior");
    expect(resolveClientStep({ firstName: "Sarah", seniorName: "Dorothy" })).toBe("client_ask_needs");
    expect(resolveClientStep({ firstName: "Sarah", seniorName: "Dorothy", age: 82 })).toBe("client_ask_location");
    expect(resolveClientStep({ firstName: "Sarah", seniorName: "Dorothy", age: 82, city: "Austin" })).toBe("client_ask_schedule");
    // All absorbable fields collected → hands back to the legacy post-collection step.
    expect(resolveClientStep({ firstName: "Sarah", seniorName: "Dorothy", age: 82, city: "Austin", schedule: "3 mornings" })).toBe("client_ask_start");
  });

  describe("conversational parity: flag ON produces the same result as the legacy machine", () => {
    const prev = process.env.CONVERGENCE_FLIPPED;
    beforeEach(() => { process.env.CONVERGENCE_FLIPPED = "onboarding"; });
    afterEach(()  => { if (prev === undefined) delete process.env.CONVERGENCE_FLIPPED; else process.env.CONVERGENCE_FLIPPED = prev; });

    it("client happy path collects identical fields + lands on the same step with the dispatcher driving", async () => {
      const final = await runTurns({ onboardingStep: "ask_role" }, [
        { text: "1 — I need care for my mom",            parses: { role: "client" } },
        { text: "I'm Sarah",                             parses: { parse: "Sarah" } },
        { text: "my mom Dorothy",                        parses: { parse: '{"seniorName":"Dorothy","relationship":"mother"}' } },
        { text: "she's 82, has dementia, needs bathing", parses: { parse: '{"age":82,"careNeeds":["bathing"],"conditions":["dementia"]}' } },
        { text: "Austin, TX 78701",                      parses: { parse: '{"city":"Austin","zipCode":"78701"}' } },
        { text: "3 mornings a week",                     parses: { parse: '{"daysPerWeek":3,"timeOfDay":"morning","hoursPerDay":4}' } },
      ]);
      // Identical field-collection + routing to the flag-OFF happy path above.
      const d = data(final);
      expect(d.firstName).toBe("Sarah");
      expect(d.seniorName).toBe("Dorothy");
      expect(d.age).toBe(82);
      expect(d.city).toBe("Austin");
      expect(d.zipCode).toBe("78701");
      expect(d.daysPerWeek).toBe(3);
      expect(final.onboardingStep).toBe("client_ask_start");
    });
  });
});

describe("onboarding dry-run is write-safe at the handler level (U10 proof, via U11 harness)", () => {
  it("a happy-path turn under runOnboardingDryRun performs ZERO Firestore/Auth writes", async () => {
    SESSIONS.set(SESSION_PATH, { onboardingStep: "ask_role", userType: null, onboardingData: {} });
    writeCount = 0; authCreateCount = 0;
    CURRENT = { role: "client" };
    const session = { ...(SESSIONS.get(SESSION_PATH) as any) };

    await runOnboardingDryRun(() => handleOnboardingStep(PHONE, CHAT, "1 — I need care for my mom", session));

    expect(writeCount).toBe(0);       // no session/terminal writes
    expect(authCreateCount).toBe(0);  // no Auth account created
  });

  it("the SAME turn WITHOUT dry-run DOES write (proves the guard is what suppresses it)", async () => {
    SESSIONS.set(SESSION_PATH, { onboardingStep: "ask_role", userType: null, onboardingData: {} });
    writeCount = 0;
    CURRENT = { role: "client" };
    const session = { ...(SESSIONS.get(SESSION_PATH) as any) };

    await handleOnboardingStep(PHONE, CHAT, "1 — I need care for my mom", session);

    expect(writeCount).toBeGreaterThan(0);
  });
});
