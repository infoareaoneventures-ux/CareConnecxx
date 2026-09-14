import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-13: bookingFlow.ts used to only recognize a cancel at its very LAST
// step (bk_confirm's own YES/NO/edit classification) — anywhere earlier,
// "never mind"/"cancel this" fell through isQuestionOrOther as an off-topic
// aside, got a brief reply, and the SAME question just re-asked itself next
// turn, with no way to actually leave. Fixed by checking the shared
// isBackOutRequest classifier (stepHandler.ts) FIRST in every step handler,
// ahead of isQuestionOrOther — the same fix already given to interviewFlow.ts
// (built with it from the start) and jobPostingFlow.ts. These tests lock it
// in across every booking step.
//
// bookingFlow.test.ts (the existing test file for this flow) doesn't mock
// utils/openaiClient at all, so isBackOutRequest's underlying quickComplete
// call fails there and falls back to "NO" (fail-safe) — this file adds that
// mock so the back-out path is actually exercised, not just silently
// bypassed.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();

  const resolveSentinels = (cur: Record<string, any>, k: string, v: any) => {
    if (v && typeof v === "object" && (v as any).__delete) { delete cur[k]; return; }
    cur[k] = v;
  };

  const makeDocRef = (collName: string, id: string): any => {
    const path = `${collName}/${id}`;
    return {
      get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
      set: vi.fn(async (data: any, opts?: any) => {
        const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
        for (const [k, v] of Object.entries(data)) resolveSentinels(base, k, v);
        docState.set(path, base);
      }),
      update: vi.fn(async (data: any) => {
        const cur = { ...(docState.get(path) ?? {}) };
        for (const [k, v] of Object.entries(data)) resolveSentinels(cur, k, v);
        docState.set(path, cur);
      }),
    };
  };

  const makeCollRef = (collName: string): any => ({ doc: (id: string) => makeDocRef(collName, id) });

  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
const generateCaraMessageMock = vi.fn(async (opts: any) => opts.fallback ?? "msg");
vi.mock("../../utils/caraMessage", () => ({ generateCaraMessage: (...a: unknown[]) => (generateCaraMessageMock as any)(...a) }));
vi.mock("../../safety/outputGuard", () => ({ guardModelOutput: () => ({ ok: true }), ANTI_INVENTION_CLAUSE: "ANTI_INVENTION" }));
vi.mock("../../config/featureFlags", () => ({ caraOutputGuardEnabled: () => true, multiRecipientScopingEnabled: () => true }));
const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));
const createBookingTask = vi.fn(async (_params: any) => "task-1");
vi.mock("../bookingExecutor", () => ({ createBookingTask: (params: unknown) => createBookingTask(params) }));

// isBackOutRequest (stepHandler.ts) routes through utils/parseWithClaude ->
// utils/openaiClient's quickComplete — a DIFFERENT path than this flow's own
// local parseWithClaude (which hits getSharedClient directly).
const quickCompleteMock = vi.fn(async (..._args: any[]) => "NO");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickCompleteMock(...a) }));

import { startBookingFlow, handleBookingFlowStep } from "../bookingFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";
const CG_ID = "cg-1";

function session(overrides: Record<string, unknown> = {}): any {
  return { phone: PHONE, chatId: CHAT, userId: UID, userType: "client", ...overrides };
}

function seedCaregiver() {
  hoisted.docState.set(`caregivers/${CG_ID}`, { name: "Basra Yousuf" });
}

beforeEach(() => {
  hoisted.reset();
  sendMessage.mockClear();
  messagesCreate.mockReset();
  quickCompleteMock.mockReset();
  quickCompleteMock.mockResolvedValue("NO");
  createBookingTask.mockClear();
  createBookingTask.mockResolvedValue("task-1");
  seedCaregiver();
});

describe("bookingFlow — back-off at every step (2026-09-13)", () => {
  const steps = [
    "bk_ask_interview", "bk_confirm_recipients", "bk_ask_rate", "bk_ask_days", "bk_ask_start_date", "bk_ask_times", "bk_ask_ongoing",
    "bk_ask_location", "bk_ask_recipients", "bk_ask_message", "bk_confirm",
  ];

  for (const step of steps) {
    it(`clears the flow and confirms nothing was sent when the family backs out at ${step}`, async () => {
      await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
      quickCompleteMock.mockResolvedValueOnce("YES"); // isBackOutRequest -> true
      await handleBookingFlowStep(PHONE, CHAT, "never mind, cancel this", session({ bookingFlowStep: step }));
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.bookingFlowStep).toBeUndefined();
      expect(stored.bookingFlowData).toBeUndefined();
      expect(createBookingTask).not.toHaveBeenCalled();
      expect(messagesCreate).not.toHaveBeenCalled();
      expect(String(sendMessage.mock.calls.at(-1)![1])).toMatch(/haven'?t sent anything/i);
    });
  }

  it("does NOT back out on a genuine answer — quickComplete returning NO lets the step proceed normally", async () => {
    await startBookingFlow(PHONE, CHAT, session(), { caregiverId: CG_ID });
    quickCompleteMock.mockResolvedValueOnce("NO"); // isBackOutRequest -> false
    messagesCreate
      .mockResolvedValueOnce({ content: [{ text: "NO" }] })  // isQuestionOrOther
      .mockResolvedValueOnce({ content: [{ text: "25" }] }); // rate extraction
    await handleBookingFlowStep(PHONE, CHAT, "$25", session({ bookingFlowStep: "bk_ask_rate" }));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.bookingFlowStep).toBe("bk_ask_days");
    expect(stored.bookingFlowData.hourlyRate).toBe(25);
  });
});
