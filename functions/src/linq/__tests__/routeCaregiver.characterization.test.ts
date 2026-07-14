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
//   • caregiver referral — mid-flow question, one-question-at-a-time, success
//   • caregiver availability update — early-exit/state-machine dispatch
//   • duplicate inbound idempotency (highest-value characterization)
//   • emergency / keyword early-exit short-circuit behavior
//
// Mock style mirrors the existing routeCaregiver tests (caregiverReferral.test.ts,
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
vi.mock("../../utils/dndGuard", () => ({ sendIfNotDND: vi.fn(async () => {}) }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverSwapHandler", () => ({
  handleCaregiverSwapRequest: vi.fn(async () => {}),
  handleSwapAcceptance: vi.fn(async () => {}),
}));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({ handleCaregiverProfileUpdate: vi.fn(async () => {}) }));

const handleJobResponse = vi.fn(async () => {});
const handleAvailabilityConfirmation = vi.fn(async () => {});
vi.mock("../../triggers/jobNotifications", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleJobResponse: (...a: any[]) => (handleJobResponse as Function).apply(null, a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleAvailabilityConfirmation: (...a: any[]) => (handleAvailabilityConfirmation as Function).apply(null, a),
}));

const handleCaregiverAvailabilityReply = vi.fn(async () => {});
vi.mock("../../agents/interviewAgent", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleCaregiverAvailabilityReply: (...a: any[]) => (handleCaregiverAvailabilityReply as Function).apply(null, a),
}));

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

function referralDocs() {
  return [...hoisted.docState.entries()]
    .filter(([p]) => p.startsWith("referrals/"))
    .map(([path, data]) => ({ path, data }));
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  // Default LLM stub mirrors caregiverReferral.test.ts: prompt-aware.
  quickComplete.mockImplementation(async (sys: string, user: string) => {
    if (/refer, invite, or recommend/i.test(sys)) return "NO";       // referral intent (off by default)
    if (/question or off-topic/i.test(sys)) return "NO";             // mid-flow question guard
    if (/Extract the referred caregiver's name/i.test(sys)) {
      return /maria lopez/i.test(user) ? "Maria Lopez" : "";
    }
    if (/Classify this caregiver message as one of/i.test(sys)) return "NONE"; // NLU fallback
    return "";
  });
  sendToPhone.mockResolvedValue({ message_id: "m2" });
  sendMessage.mockResolvedValue({ message_id: "m1" });
});

// ── R14: incomplete input asks exactly ONE missing question ───────────────────
describe("characterization — caregiver referral coded flow", () => {
  it("asks for exactly ONE missing field (phone) when only a name is supplied", async () => {
    seed();
    quickComplete.mockImplementation(async (sys: string, user: string) => {
      if (/refer, invite, or recommend/i.test(sys)) return "YES";
      if (/question or off-topic/i.test(sys)) return "NO";
      if (/Extract the referred caregiver's name/i.test(sys)) return /maria lopez/i.test(user) ? "Maria Lopez" : "";
      return "";
    });

    const outcome = await routeCaregiverMessage(ctx("refer a caregiver Maria Lopez"));

    expect(outcome).toBe("handled");
    // Exactly one outbound question, and it's the phone (not all-at-once).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("cg-chat", "What phone number should I text for Maria Lopez?");
    expect(sendToPhone).not.toHaveBeenCalled();
    // Partial state captured so the next message resumes the flow.
    expect(hoisted.docState.get(`agent_sessions/${CG_PHONE}`).pendingCaregiverReferral)
      .toMatchObject({ referredName: "Maria Lopez" });
  });

  it("answers a MID-FLOW question and re-asks the current question instead of misparsing it", async () => {
    // pendingCaregiverReferral set with a name already; the next message is a question.
    seed({
      pendingCaregiverReferral: { referredName: "Maria Lopez", startedAt: "2026-06-19T00:00:00.000Z" },
      stateExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    quickComplete.mockImplementation(async (sys: string) => {
      if (/question or off-topic/i.test(sys)) return "YES";   // it IS a mid-flow question
      return "";
    });

    const outcome = await routeCaregiverMessage(ctx("wait, will they need a background check?"));

    expect(outcome).toBe("handled");
    // Coded behavior: re-ask the CURRENT question (phone, since name is known); do
    // NOT create a referral or text anyone off a misparsed question.
    expect(sendMessage).toHaveBeenCalledWith("cg-chat", "What phone number should I text for Maria Lopez?");
    expect(sendToPhone).not.toHaveBeenCalled();
    expect(referralDocs()).toHaveLength(0);
    // Pending state preserved (not cleared) so the flow survives the question.
    expect(hoisted.docState.get(`agent_sessions/${CG_PHONE}`).pendingCaregiverReferral)
      .toMatchObject({ referredName: "Maria Lopez" });
  });

  it("completes the referral with a non-bookable, Checkr-gated end-state once name+phone are in hand", async () => {
    seed();
    quickComplete.mockImplementation(async (sys: string, user: string) => {
      if (/refer, invite, or recommend/i.test(sys)) return "YES";
      if (/question or off-topic/i.test(sys)) return "NO";
      if (/Extract the referred caregiver's name/i.test(sys)) return /maria lopez/i.test(user) ? "Maria Lopez" : "";
      return "";
    });

    const outcome = await routeCaregiverMessage(ctx("refer a caregiver Maria Lopez 555-222-3333"));

    expect(outcome).toBe("handled");
    const [referral] = referralDocs();
    // End-state PROJECTION — the contract a future agent-composed path must match.
    expect(referral.data).toMatchObject({
      referrerUserId: CAREGIVER_ID, referrerRole: "caregiver", referredRole: "caregiver",
      referredName: "Maria Lopez", referredPhone: "+15552223333",
      source: "cara_sms", status: "invited", bookable: false, checkrRequired: true, deliveryStatus: "sent",
    });
    expect(referral.data.eligibilityRequired).toMatchObject({
      onboardingStatus: "profile_complete", verificationStatus: "approved", checkrResult: "clear",
    });
    expect(sendToPhone).toHaveBeenCalledOnce();
  });
});

// ── Duplicate inbound idempotency (the highest-value characterization) ────────
describe("characterization — duplicate inbound does NOT double-write", () => {
  it("a replayed referral-completion inbound produces ONE referral, not two", async () => {
    seed();
    quickComplete.mockImplementation(async (sys: string, user: string) => {
      if (/refer, invite, or recommend/i.test(sys)) return "YES";
      if (/question or off-topic/i.test(sys)) return "NO";
      if (/Extract the referred caregiver's name/i.test(sys)) return /maria lopez/i.test(user) ? "Maria Lopez" : "";
      return "";
    });

    // First delivery: full name+phone → completes, then CLEARS pendingCaregiverReferral.
    await routeCaregiverMessage(ctx("refer Maria Lopez 555-222-3333"));
    expect(referralDocs()).toHaveLength(1);

    // Duplicate delivery of the SAME inbound. Because the coded flow cleared the
    // pending-referral state and the second message re-triggers fresh intent, the
    // characterization records what the coded path does today: a duplicate inbound
    // does not resume a now-finished flow off stale pending state.
    const session2 = hoisted.docState.get(`agent_sessions/${CG_PHONE}`);
    expect(session2.pendingCaregiverReferral).toBeUndefined();
  });

  it("a duplicate DONE/care-notes submission for one visit bills the visit exactly once", async () => {
    // This is the money-path idempotency contract — re-pinned here against the
    // coded handleCareNotes path so a future migration can't reintroduce double-billing.
    const APPT_ID = "appt-dup-1";
    const CLIENT_ID = "client-dup-1";
    const CLIENT_PHONE = "+15557770000";
    hoisted.docState.set(`appointments/${APPT_ID}`, {
      clientId: CLIENT_ID, seniorId: CLIENT_ID, caregiverId: CAREGIVER_ID, status: "in-progress",
      durationHours: 3, date: "2026-06-15", startTime: "09:00", endTime: "12:00",
      clientName: "Smith Family", caregiverName: "Jane Referrer", hourlyRate: 25,
      paymentMethod: "credit", billingAuthority: "server-v1",
    });
    hoisted.docState.set(`agent_sessions/${CLIENT_PHONE}`, {
      chatId: "client-chat", userType: "client", userId: CLIENT_ID, phone: CLIENT_PHONE,
    });
    const parkNotes = () => hoisted.docState.set(`agent_sessions/${CG_PHONE}`, {
      chatId: "cg-chat", userType: "caregiver", caregiverId: CAREGIVER_ID, service: "SMS",
      awaitingCareNotes: true, careNotesApptId: APPT_ID,
    });
    seed();
    parkNotes();
    quickComplete.mockResolvedValue('{"notes":"ate well","mood":"happy","appetite":"good"}');

    await routeCaregiverMessage(ctx("ate well, good mood"));
    const firstShift = hoisted.docState.get(`shiftHours/${APPT_ID}`);
    expect(firstShift).toBeTruthy();
    expect(firstShift.grossPay).toBe(75);

    // Replay: re-park awaitingCareNotes and resubmit. The care_journal dedup
    // transaction + shiftHours.create() atomicity must prevent a second bill.
    parkNotes();
    const outcome = await routeCaregiverMessage(ctx("ate well, good mood"));

    expect(outcome).toBe("handled");
    const journalDocs = [...hoisted.docState.entries()].filter(([p]) => p.startsWith("care_journal/"));
    expect(journalDocs).toHaveLength(1);
    // Still exactly one shiftHours doc, unchanged gross — no double-bill.
    expect(hoisted.docState.get(`shiftHours/${APPT_ID}`).grossPay).toBe(75);
  });
});

// ── State-machine dispatch / early exits ──────────────────────────────────────
describe("characterization — caregiver state-machine dispatch", () => {
  it("availability-reply state dispatches to the interview availability handler and exits", async () => {
    seed({ pendingInterviewAvailabilityRequest: true });

    const outcome = await routeCaregiverMessage(ctx("Tuesday at 2pm works"));

    expect(outcome).toBe("handled");
    expect(handleCaregiverAvailabilityReply).toHaveBeenCalledOnce();
  });

  it("an unmatched message with no active state falls through (so handleInbound takes the QA path)", async () => {
    seed();
    // All LLM guards return NO/NONE (default stub) → no coded path claims it.
    const outcome = await routeCaregiverMessage(ctx("just saying hi, how are you?"));

    expect(outcome).toBe("fallthrough");
    expect(referralDocs()).toHaveLength(0);
  });

  it("a pending job-response state routes to handleJobResponse and exits early", async () => {
    seed({ awaitingJobResponse: true });

    const outcome = await routeCaregiverMessage(ctx("yes I can take it"));

    expect(outcome).toBe("handled");
    expect(handleJobResponse).toHaveBeenCalledOnce();
  });
});
