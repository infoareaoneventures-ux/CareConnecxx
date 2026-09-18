import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-13: jobPostingFlow.ts used to only recognize a cancel at its very
// LAST step (jp_confirm_post's own YES/NO parse) — anywhere earlier, "never
// mind"/"cancel this" fell through isQuestionOrOther as an off-topic aside,
// got a brief reply, and the SAME question just re-asked itself next turn,
// with no way to actually leave. Live-caught the worst version of this: a
// family misrouted into this flow mid-interview-scheduling had "cancel this
// request" / "cancel the job post" — even a direct answer to Evia's OWN
// clarifying question — loop forever with no escape (see interviewFlow.ts's
// header comment for the full incident). Fixed by checking the shared
// isBackOutRequest classifier (stepHandler.ts) FIRST in every step handler,
// ahead of isQuestionOrOther — these tests lock that in across every step.
//
// jobPostingWhoWhere.test.ts (the existing test file for this flow) doesn't
// mock utils/openaiClient at all, so isBackOutRequest's underlying
// quickComplete call fails there and falls back to "NO" (fail-safe) — this
// file adds that mock so the back-out path is actually exercised, not just
// silently bypassed.

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
vi.mock("../profileBriefing", () => ({ describeSharedProfile: () => "" }));
vi.mock("../buildJobPost", () => ({ buildAndSaveJobPost: vi.fn(async () => ({ jobId: "job-1", notifiedCount: 0 })), jobLiveMessage: "live" }));
vi.mock("../../utils/geocode", () => ({ lookupZipPlace: vi.fn(async () => null) }));

const messagesCreate = vi.fn();
vi.mock("../../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
}));

// isBackOutRequest (stepHandler.ts) routes through utils/parseWithClaude ->
// utils/openaiClient's quickComplete — a DIFFERENT path than this flow's own
// local parseWithClaude (which hits getSharedClient directly).
const quickCompleteMock = vi.fn(async (..._args: any[]) => "NO");
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickCompleteMock(...a) }));

import { handleJobPostingStep } from "../jobPostingFlow";

const PHONE = "+15551234567";
const CHAT  = "chat-1";
const UID   = "client-uid";

function session(step: string, overrides: Record<string, unknown> = {}): any {
  return {
    phone: PHONE, chatId: CHAT, userId: UID, userType: "client",
    onboardingData: { seniorName: "Rosie Alvarez", firstName: "Anahi", relationship: "daughter" },
    jobPostingStep: step,
    jobPostingData: {},
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set(`users/${UID}`, { identityCheckStatus: "verified", membershipStatus: "active" });
  hoisted.docState.set(`agent_sessions/${PHONE}`, { jobPostingStep: "jp_ask_frequency", jobPostingData: {} });
  sendMessage.mockClear();
  messagesCreate.mockReset();
  quickCompleteMock.mockReset();
  quickCompleteMock.mockResolvedValue("NO");
  generateCaraMessageMock.mockClear();
});

describe("jobPostingFlow — back-off at every step (2026-09-13)", () => {
  const steps = [
    "jp_ask_frequency", "jp_ask_start", "jp_ask_days", "jp_ask_time",
    "jp_ask_recipients", "jp_ask_recipient_relationship", "jp_ask_caregivers_needed",
    "jp_ask_location", "jp_ask_location_environment", "jp_ask_care_needs",
    "jp_ask_rate", "jp_ask_description", "jp_confirm_post",
  ];

  for (const step of steps) {
    it(`clears the flow and confirms nothing was posted when the family backs out at ${step}`, async () => {
      quickCompleteMock.mockResolvedValueOnce("YES"); // isBackOutRequest -> true
      await handleJobPostingStep(PHONE, CHAT, "never mind, cancel this", session(step));
      const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
      expect(stored.jobPostingStep).toBeUndefined();
      expect(stored.jobPostingData).toBeUndefined();
      // The back-out path never reaches any Anthropic call (isQuestionOrOther,
      // extraction, or the confirm-step summary rebuild) — it returns
      // immediately after clearing the flow.
      expect(messagesCreate).not.toHaveBeenCalled();
      expect(String(sendMessage.mock.calls.at(-1)![1])).toMatch(/no problem/i);
    });
  }

  it("does NOT back out on a genuine answer — quickComplete returning NO lets the step proceed normally", async () => {
    quickCompleteMock.mockResolvedValueOnce("NO"); // isBackOutRequest -> false
    messagesCreate
      .mockResolvedValueOnce({ content: [{ text: "NO" }] }) // isQuestionOrOther
      .mockResolvedValueOnce({ content: [{ text: "occasional" }] }); // frequency extraction
    await handleJobPostingStep(PHONE, CHAT, "occasional", session("jp_ask_frequency"));
    const stored = hoisted.docState.get(`agent_sessions/${PHONE}`);
    expect(stored.jobPostingStep).toBe("jp_ask_start");
    expect(stored.jobPostingData.jobFrequency).toBe("occasional");
  });
});
