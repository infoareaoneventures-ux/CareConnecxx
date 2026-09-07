// U2 — anti-invention clause + output guard on jobPostingFlow's two direct
// messages.create paths (parseWithClaude + answerQuestionMidFlow). Mocking
// pattern per caregiverProfileHandler.test.ts (vi.hoisted + firebase-admin /
// linq/client mocks). NOTE the vitest gotcha: beforeEach callbacks use braces —
// never implicitly return a value.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const docGetMock = vi.fn().mockResolvedValue({ exists: true, data: () => ({ jobPostingData: {} }) });

  const docFn = vi.fn(() => ({ update: updateMock, get: docGetMock }));
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  const sendMessage    = vi.fn().mockResolvedValue({ message_id: "x" });
  const messagesCreate = vi.fn();

  return { updateMock, docGetMock, collectionMock, sendMessage, messagesCreate };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: vi.fn(() => "__DELETE__") },
  }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...args: unknown[]) => hoisted.sendMessage(...args),
}));

// buildJobPost drags in the notifications/bookingExecutor chain (module-level
// admin.apps access) — none of it is exercised by these step-level tests.
vi.mock("./buildJobPost", () => ({
  buildAndSaveJobPost:   vi.fn(async () => ({ jobId: "job-1", notifiedCount: 0 })),
  jobLiveMessage:        vi.fn(() => "Your job post is live."),
  notifiedOutcomePhrase: vi.fn(() => "no caregivers notified yet"),
}));

vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: (...args: unknown[]) => hoisted.messagesCreate(...args) },
  }),
}));

const { sendMessage, messagesCreate } = hoisted;

import { handleJobPostingStep, JP_MIDFLOW_FALLBACK } from "./jobPostingFlow";
import { ANTI_INVENTION_CLAUSE } from "../utils/caraMessage";

const PHONE = "+15555550100";
const CHAT  = "chat-1";
const SESSION: any = {
  jobPostingStep: "jp_ask_start",
  // job_posting is a DEFAULT_FLIPPED_FLOWS flow (isConvergenceFlipped, on by
  // default) — dispatch resolves the step from jobPostingData, not the literal
  // jobPostingStep string above. jobFrequency pre-filled so it resolves to
  // jp_ask_start (the step these tests actually exercise) — schedule (frequency
  // /start/days/time) comes before who/where in the site's own order.
  jobPostingData: { jobFrequency: "occasional" },
  onboardingData: { seniorName: "Rosie Alvarez" },
};

// The exact leaked-incident shape: the model replies to the briefing author.
const META_OUTPUT =
  "Got it, but I need the briefing context to write this message, " +
  "who's the caregiver, what shift/client situation are we talking about...";

const modelReplies = (...texts: string[]) => {
  for (const text of texts) {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text }] });
  }
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  messagesCreate.mockReset();
  sendMessage.mockClear();
  hoisted.updateMock.mockClear();
  delete process.env.CARA_OUTPUT_GUARD_ENABLED;
  delete process.env.CONVERGENCE_UNFLIPPED;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("jobPostingFlow — anti-invention clause (U2, R1)", () => {
  it("both direct model calls carry ANTI_INVENTION_CLAUSE in their system prompt", async () => {
    // Call 1: isQuestionOrOther classifier ("NO" = a direct answer).
    // Call 2: start-date parse.
    modelReplies("NO", "next Monday");

    await handleJobPostingStep(PHONE, CHAT, "next monday please", SESSION);

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    for (const call of messagesCreate.mock.calls) {
      expect((call[0] as { system: string }).system).toContain(ANTI_INVENTION_CLAUSE);
    }
    expect(String(sendMessage.mock.calls[0][1])).toContain("starting next Monday");
  });

  it("answerQuestionMidFlow's system prompt carries the clause", async () => {
    // Call 1: isQuestionOrOther → YES. Call 2: mid-flow answer.
    modelReplies("YES", "Great question — Evia matches you with vetted local caregivers.");

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect((messagesCreate.mock.calls[1][0] as { system: string }).system).toContain(ANTI_INVENTION_CLAUSE);
    // Guard passes → answer delivered unchanged (behavior unchanged when clean).
    expect(sendMessage.mock.calls[0][1]).toBe("Great question — Evia matches you with vetted local caregivers.");
  });
});

describe("jobPostingFlow — output guard (U2, R2)", () => {
  it("guard-rejected mid-flow answer → JP_MIDFLOW_FALLBACK, raw meta-response never sent", async () => {
    modelReplies("YES", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect(sendMessage.mock.calls[0][1]).toBe(JP_MIDFLOW_FALLBACK);
    for (const call of sendMessage.mock.calls) {
      expect(String(call[1])).not.toContain("briefing context");
    }
  });

  it("guard-rejected parse output is a parse failure — raw user text stored, meta never echoed", async () => {
    modelReplies("NO", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "whenever works for you", SESSION);

    // "__parse_error__" path: the handler stores the user's raw text instead.
    expect(String(sendMessage.mock.calls[0][1])).toContain("starting whenever works for you");
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("briefing context");
  });

  it("kill switch CARA_OUTPUT_GUARD_ENABLED='false' bypasses the guard", async () => {
    process.env.CARA_OUTPUT_GUARD_ENABLED = "false";
    modelReplies("YES", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect(sendMessage.mock.calls[0][1]).toBe(META_OUTPUT);
  });
});
