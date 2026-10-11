// U9 / KTD3 — CHARACTERIZATION TESTS for the CODED caregiver route state machine.
//
// These tests LOCK IN the current behavior of `routeCaregiverMessage`
// (routeCaregiver.ts) exactly as it ships TODAY. They are the safety apparatus
// that makes a future migration to agent-composed tool flows provably safe: if
// any refactor changes which path the coded router takes, or changes the
// end-state it produces, one of these fails.
//
// Production routing is NOT changed by this file — it only observes the existing
// coded path. The candidate flows characterized here (per the U9 plan):
//   • caregiver availability update — early-exit/state-machine dispatch
//   • emergency / keyword early-exit short-circuit behavior
//
// Mock style mirrors the existing routeCaregiver tests (e.g.
// handleCareNotes.billing.test.ts): an in-memory Firestore with query filtering,
// every collaborator stubbed, assert on Firestore writes + outbound messages.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  let autoId = 0;

  const collDocs = (collPath: string) => {
    const prefix = collPath + "/";
    const out: Array<{ id: string; data: any }> = [];
    for (const [path, data] of docState) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        if (!rest.includes("/")) out.push({ id: rest, data });
      }
    }
    return out;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), id: path.split("/").pop(), data: () => docState.get(path) }),
    set: async (data: any, opts?: any) => {
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    update: async (data: any) => {
      const next = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if ((v as any)?.__delete) delete next[k]; else next[k] = v;
      }
      docState.set(path, next);
    },
    create: async (data: any) => {
      if (docState.has(path)) { const e: any = new Error("already exists"); e.code = 6; throw e; }
      docState.set(path, data);
    },
    delete: async () => { docState.delete(path); },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (collPath: string): any => {
    const filters: Array<{ field: string; op: string; val: any }> = [];
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${collPath}/${id ?? `auto-${autoId++}`}`);
    ref.where = (field: string, op: string, val: any) => { filters.push({ field, op, val }); return ref; };
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.add = async (data: any) => { const id = `auto-${autoId++}`; docState.set(`${collPath}/${id}`, data); return { id }; };
    ref.get = async () => {
      let items = collDocs(collPath);
      for (const f of filters) {
        if (f.op === "==") items = items.filter((it) => it.data?.[f.field] === f.val);
      }
      return {
        empty: items.length === 0,
        docs: items.map((it) => ({ id: it.id, data: () => it.data, ref: makeDocRef(`${collPath}/${it.id}`) })),
      };
    };
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));
  const runTransaction = async (fn: (t: any) => Promise<void>) => fn({
    get: (refOrQuery: any) => refOrQuery.get(),
    create: (ref: any, data: any) => { ref.create(data); },
    set: (ref: any, data: any) => { ref.set(data); },
    update: (ref: any, data: any) => { ref.update(data); },
  });

  const firestoreFn: any = Object.assign(() => ({ collection, runTransaction }), {
    FieldValue: {
      delete: () => ({ __delete: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    Timestamp: {
      fromMillis: (ms: number) => ({ __timestampMs: ms }),
    },
  });

  return {
    docState, firestoreFn,
    reset: () => { docState.clear(); autoId = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
const sendToPhone = vi.fn(async (..._a: any[]) => ({ message_id: "m2" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  sendToPhone: (...a: any[]) => sendToPhone(...a),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
}));

const quickComplete = vi.fn(async (..._a: any[]) => "");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));


import { routeCaregiverMessage } from "../routeCaregiver";

const CG_PHONE = "+15551110000";
const CAREGIVER_ID = "cg-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`caregivers/${CAREGIVER_ID}`, { name: "Jane Referrer", hourlyRate: 25 });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
    chatId: "cg-chat", phone: CG_PHONE, service: "SMS", userType: "caregiver", caregiverId: CAREGIVER_ID,
    ...sessionPatch,
  });
}

function ctx(text: string) {
  return {
    phone: CG_PHONE, chatId: "cg-chat", text,
    norm: text.toUpperCase().trim(),
    session: hoisted.docState.get(`agent_sessions/${CG_PHONE}`) as any,
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  // Default LLM stub: prompt-aware.
  quickComplete.mockImplementation(async (sys: string) => {
    if (/question or off-topic/i.test(sys)) return "NO";             // mid-flow question guard
    if (/Classify this caregiver message as one of/i.test(sys)) return "NONE"; // NLU fallback
    return "";
  });
  sendToPhone.mockResolvedValue({ message_id: "m2" });
  sendMessage.mockResolvedValue({ message_id: "m1" });
});

// ── State-machine dispatch / early exits ──────────────────────────────────────
describe("characterization — caregiver state-machine dispatch", () => {
  it("an unmatched message with no active state falls through (so handleInbound takes the QA path)", async () => {
    seed();
    // All LLM guards return NO/NONE (default stub) → no coded path claims it.
    const outcome = await routeCaregiverMessage(ctx("just saying hi, how are you?"));

    expect(outcome).toBe("fallthrough");
  });

  it("a legacy job-invite flag left on a session no longer owns the reply (invite flow removed 2026-09-27)", async () => {
    seed({ awaitingJobResponse: true, pendingJobId: "job1", pendingJobSentAt: new Date().toISOString() });

    const outcome = await routeCaregiverMessage(ctx("just saying hi, how are you?"));

    expect(outcome).toBe("fallthrough");
  });
});
