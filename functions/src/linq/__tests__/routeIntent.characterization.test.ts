// U9 / KTD3 — CHARACTERIZATION TESTS for the CODED client intent router.
//
// Locks in the current behavior of `routeIntentAndRespond` (routeIntent.ts) for
// the U9 candidate flows on the client side: family add / family remove. These
// are the launch-critical coded state machines U9 may eventually migrate to
// agent-composed tool flows — these tests are the safety net that proves a
// migration preserves behavior. Production routing is NOT changed here.
//
// What each test pins (plan's R14-adjacent scenarios):
//   • incomplete family-add input asks exactly ONE missing question
//   • a partial family-add resumes from captured state (one question at a time)
//   • the family-REMOVE confirmation gate FIRES and is not bypassed
//   • a duplicate family-add inbound does not double-write (idempotency)
//
// Mock style follows routeClient.test.ts / caregiverReferral.test.ts: in-memory
// Firestore, every collaborator stubbed, dynamic `handleToolCall` mocked so the
// real MCP server (heavy) is never loaded.

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
  });

  return { docState, firestoreFn, reset: () => { docState.clear(); autoId = 0; } };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));

const sendMessage = vi.fn(async (..._a: any[]) => ({ message_id: "m1" }));
vi.mock("../client", () => ({
  sendMessage: (...a: any[]) => sendMessage(...a),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
  getOrCreateSession: vi.fn(async (p: string) => ({ chatId: `chat-${p}`, phone: p })),
  AgentSession: {},
}));

// The intent classifier is the only thing deciding which branch fires. Stub it
// per-test so we drive a specific coded branch deterministically.
const classifyIntentDetailed = vi.fn(async () => ({ intent: "QUESTION", degraded: false }));
vi.mock("../../agents/intentClassifier", () => ({
  classifyIntentDetailed: (...a: any[]) => classifyIntentDetailed(...a),
}));

// `handleToolCall` is dynamically imported by the family add/remove branches.
// Mock the whole mcp/server module so the real (heavy) registry never loads.
const handleToolCall = vi.fn(async () => ({ success: true }));
vi.mock("../../mcp/server", () => ({ handleToolCall: (...a: any[]) => handleToolCall(...a) }));

const quickComplete = vi.fn(async () => "");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));

// Remaining static imports — stubbed; none of these branches run in these tests.
vi.mock("../../agents/qaAgent", () => ({
  runQaAgent: vi.fn(async () => {}), runQuickReply: vi.fn(async () => {}), isTrivialQuickReply: () => false,
}));
vi.mock("../../agents/taskApprovalHandler", () => ({
  handleTaskApproval: vi.fn(async () => {}), finalizeTaskApproval: vi.fn(async () => {}),
}));
vi.mock("../../agents/permissionsConversation", () => ({
  updatePermissionFromText: vi.fn(async () => {}), getPermissions: vi.fn(async () => ({ canBookAutomatically: false })),
}));
vi.mock("../../agents/interviewAgent", () => ({
  handleInterviewSelection: vi.fn(async () => {}), handleInterviewConfirm: vi.fn(async () => {}),
  writeInterviewOutcomeSignal: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../agents/bookingExecutor", () => ({
  executeBookings: vi.fn(async () => {}), createBookingTask: vi.fn(async () => "task-1"),
}));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../../agents/jobPostingFlow", () => ({ startJobPostingFlow: vi.fn(async () => {}) }));
vi.mock("../../agents/modifyScheduleFlow", () => ({ startModifyScheduleFlow: vi.fn(async () => {}) }));
vi.mock("../../agents/refundHandler", () => ({ handleRefundRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/timesheetHandler", () => ({ handleTimesheetApproval: vi.fn(async () => {}) }));
vi.mock("../../agents/earningsHandler", () => ({ handleEarningsView: vi.fn(async () => {}) }));
vi.mock("../../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverSwapHandler", () => ({ handleCaregiverSwapRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/clientSwapRequestHandler", () => ({ handleClientSwapRequest: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverCancelShiftHandler", () => ({ handleCaregiverCancelShift: vi.fn(async () => {}) }));
vi.mock("../../agents/caregiverProfileHandler", () => ({
  handleCaregiverProfileUpdate: vi.fn(async () => {}),
  profileFieldFromIntent: vi.fn(() => null),
}));
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: any) => fallback ?? "msg") }));
vi.mock("../../triggers/jobNotifications", () => ({ handleJobResponse: vi.fn(async () => {}) }));
vi.mock("../../memory/zepClient", () => ({
  addUserMessageToZep: vi.fn(async () => {}), addAssistantMessageToZep: vi.fn(async () => {}),
  searchZepMemory: vi.fn(async () => ""), getZepUserId: (p: string) => `zep-${p}`,
}));
vi.mock("../inboundHelpers", () => ({ handleRecurringConfirm: vi.fn(async () => {}) }));

import { routeIntentAndRespond } from "../routeIntent";

const PHONE = "+15553334444";
const CLIENT_ID = "client-1";
const SENIOR_ID = "senior-1";

function seed(sessionPatch: Record<string, unknown> = {}) {
  hoisted.docState.set(`agent_sessions/${PHONE}`, {
    chatId: "chat1", phone: PHONE, service: "SMS", userType: "client",
    userId: CLIENT_ID, seniorId: SENIOR_ID, ...sessionPatch,
  });
}

function ctx(text: string) {
  return {
    phone: PHONE, chatId: "chat1", text,
    norm: text.trim().toUpperCase(),
    session: hoisted.docState.get(`agent_sessions/${PHONE}`) as any,
  };
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });
  handleToolCall.mockResolvedValue({ success: true });
  quickComplete.mockResolvedValue("");
  sendMessage.mockResolvedValue({ message_id: "m1" });
});

// ── R14: family-add incomplete input asks exactly ONE missing question ────────
describe("characterization — ADD_FAMILY_MEMBER coded flow", () => {
  it("asks for ONLY the phone when given a name first (one question at a time)", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "ADD_FAMILY_MEMBER", degraded: false });
    // extractFamilyMember → name only, no phone.
    quickComplete.mockResolvedValue('{"name":"Sarah","phone":null}');

    await routeIntentAndRespond(ctx("add my sister Sarah"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("chat1", "I can add them. What phone number should I use?");
    // No tool executed yet — the flow is still collecting.
    expect(handleToolCall).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).pendingAddFamilyMember)
      .toMatchObject({ name: "Sarah", phone: null });
  });

  it("resumes a partial add from session state and only then executes add_family_member", async () => {
    // pendingAddFamilyMember already holds the name; this message supplies the phone.
    seed({ pendingAddFamilyMember: { name: "Sarah", phone: null } });
    quickComplete.mockResolvedValue('{"name":null,"phone":"+15552223333"}');

    await routeIntentAndRespond(ctx("555-222-3333"));

    // Both pieces now in hand → the coded path calls the add tool exactly once.
    expect(handleToolCall).toHaveBeenCalledOnce();
    expect(handleToolCall).toHaveBeenCalledWith("add_family_member", expect.objectContaining({
      seniorId: SENIOR_ID, name: "Sarah", memberPhone: "+15552223333", clientId: CLIENT_ID,
    }));
    // Pending state cleared after success.
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).pendingAddFamilyMember).toBeUndefined();
  });

  it("a secondary family member CANNOT add people (authority boundary holds)", async () => {
    seed({ isSecondaryMember: true });
    classifyIntentDetailed.mockResolvedValue({ intent: "ADD_FAMILY_MEMBER", degraded: false });

    await routeIntentAndRespond(ctx("add my brother Tom 555-111-2222"));

    expect(handleToolCall).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("only the primary account holder"));
  });
});

// ── Confirmation gate for high-risk remove must FIRE, not be bypassed ─────────
describe("characterization — REMOVE_FAMILY_MEMBER confirmation gate", () => {
  it("surfaces a YES confirmation prompt when the tool returns _pending_action (gate fires)", async () => {
    seed();
    classifyIntentDetailed.mockResolvedValue({ intent: "REMOVE_FAMILY_MEMBER", degraded: false });
    // Resolve a member by phone so the branch reaches the tool call.
    quickComplete.mockResolvedValue('{"name":"Sarah","phone":"+15552223333"}');
    // The remove tool gates the destructive action behind confirmation.
    handleToolCall.mockResolvedValue({ _pending_action: true });

    await routeIntentAndRespond(ctx("remove Sarah 555-222-3333"));

    expect(handleToolCall).toHaveBeenCalledWith("remove_family_member", expect.objectContaining({
      seniorId: SENIOR_ID, memberPhone: "+15552223333", clientId: CLIENT_ID,
    }));
    // The gate fired: the user is asked to reply YES; the removal is NOT reported as done.
    expect(sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("reply YES to confirm"));
    const sentTexts = sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    expect(sentTexts.some(t => /has been removed/i.test(t))).toBe(false);
  });

  it("a secondary family member CANNOT remove people (authority boundary holds)", async () => {
    seed({ isSecondaryMember: true });
    classifyIntentDetailed.mockResolvedValue({ intent: "REMOVE_FAMILY_MEMBER", degraded: false });

    await routeIntentAndRespond(ctx("remove Sarah 555-222-3333"));

    expect(handleToolCall).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("only the primary account holder"));
  });
});

// ── Duplicate inbound idempotency for the family-add path ─────────────────────
describe("characterization — duplicate ADD_FAMILY_MEMBER inbound", () => {
  it("a replayed completed add does NOT re-call add_family_member off stale pending state", async () => {
    seed({ pendingAddFamilyMember: { name: "Sarah", phone: null } });
    quickComplete.mockResolvedValue('{"name":null,"phone":"+15552223333"}');

    // First (completing) delivery.
    await routeIntentAndRespond(ctx("555-222-3333"));
    expect(handleToolCall).toHaveBeenCalledOnce();

    // The coded flow cleared pendingAddFamilyMember on success, so a duplicate
    // delivery cannot resume the finished flow off stale pending state.
    const session2 = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(session2.pendingAddFamilyMember).toBeUndefined();

    // Replay with the cleared session and a non-add intent → no second add tool call.
    classifyIntentDetailed.mockResolvedValue({ intent: "QUESTION", degraded: false });
    await routeIntentAndRespond({ ...ctx("555-222-3333"), session: session2 });
    expect(handleToolCall).toHaveBeenCalledOnce(); // still ONE, not two
  });
});
