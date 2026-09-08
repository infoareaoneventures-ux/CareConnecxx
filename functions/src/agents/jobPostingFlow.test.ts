// U2 — anti-invention clause + output guard on jobPostingFlow's two direct
// messages.create paths (parseWithClaude + answerQuestionMidFlow). Mocking
// pattern per caregiverProfileHandler.test.ts (vi.hoisted + firebase-admin /
// linq/client mocks). NOTE the vitest gotcha: beforeEach callbacks use braces —
// never implicitly return a value.
//
// 2026-09-07 (live-caught): parseWithClaude used to carry the shared
// ANTI_INVENTION_CLAUSE too — its "use only what's in the briefing" wording
// confused the model on these briefing-less classification prompts into
// answering with a long meta-response instead of classifying, which the
// output guard correctly (but silently, until this same fix added logging)
// rejected — a literal "occasional" reply reliably failed. parseWithClaude
// now carries CLASSIFICATION_GUARD_CLAUSE instead; only answerQuestionMidFlow
// (real free-form generation) still uses ANTI_INVENTION_CLAUSE.

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

import { handleJobPostingStep, JP_MIDFLOW_FALLBACK, CLASSIFICATION_GUARD_CLAUSE, formatDateForDisplay } from "./jobPostingFlow";
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
  it("both direct classification calls carry CLASSIFICATION_GUARD_CLAUSE in their system prompt", async () => {
    // Call 1: isQuestionOrOther classifier ("NO" = a direct answer).
    // Call 2: start-date parse.
    modelReplies("NO", "next Monday");

    await handleJobPostingStep(PHONE, CHAT, "next monday please", SESSION);

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    for (const call of messagesCreate.mock.calls) {
      expect((call[0] as { system: string }).system).toContain(CLASSIFICATION_GUARD_CLAUSE);
    }
    expect(String(sendMessage.mock.calls[0][1])).toContain("starting next Monday");
  });

  it("answerQuestionMidFlow's system prompt carries the shared ANTI_INVENTION_CLAUSE (free-form generation, not classification)", async () => {
    // Call 1: isQuestionOrOther → YES. Call 2: mid-flow answer.
    modelReplies("YES", "Great question — Evia matches you with vetted local caregivers.");

    await handleJobPostingStep(PHONE, CHAT, "how does matching work?", SESSION);

    expect((messagesCreate.mock.calls[1][0] as { system: string }).system).toContain(ANTI_INVENTION_CLAUSE);
    // Guard passes → answer delivered unchanged (behavior unchanged when clean).
    expect(sendMessage.mock.calls[0][1]).toBe("Great question — Evia matches you with vetted local caregivers.");
  });

  // 2026-09-08 (live-caught): this call sees only the current message, never
  // the conversation transcript — including Evia's own prior outbound texts.
  // A family replying to Evia's own interview-completion nudge ("can you
  // make it complete") got forced into job-posting terms ("are you setting
  // up a job posting?"), and asking directly "what interview do I have" got
  // a confident, false "I haven't mentioned an interview — this is our first
  // message!" Locks in the instruction that stops both: never claim
  // something was/wasn't said before, and redirect rather than guess when
  // the message is about a different topic entirely.
  it("answerQuestionMidFlow's system prompt instructs an honest redirect instead of forcing an out-of-scope question into job-posting terms", async () => {
    modelReplies("YES", "That sounds like something else — let's finish this first, and I'll help with that right after.");

    await handleJobPostingStep(PHONE, CHAT, "can you make it complete", SESSION);

    const answerSystem = (messagesCreate.mock.calls[1][0] as { system: string }).system;
    expect(answerSystem).toContain("NEVER claim something was or wasn't mentioned before");
    expect(answerSystem.toLowerCase()).toContain("let's finish this first");
  });

  // 2026-09-07 (live-caught): the classification prompt used to judge
  // relevance "to the current question" without ever stating what that
  // question WAS — a context-free guess that misclassified short, valid
  // answers like a bare "morning" as off-topic. Locks in that the actual
  // question text now rides along in the prompt.
  it("isQuestionOrOther's prompt includes the actual question being asked, not a context-free guess", async () => {
    modelReplies("NO", "next Monday");

    await handleJobPostingStep(PHONE, CHAT, "next monday please", SESSION);

    const classifySystem = (messagesCreate.mock.calls[0][0] as { system: string }).system;
    expect(classifySystem).toContain("When would you like care to start?");
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

  // 2026-09-07: the actual live-caught bug — jp_ask_frequency's classification
  // call carried ANTI_INVENTION_CLAUSE (briefing-framed), which confused the
  // model into a long meta-response for a literal, unambiguous "occasional"
  // reply, every single time. Locks in the fix (CLASSIFICATION_GUARD_CLAUSE
  // instead) via the same guard-rejection path, on the actual step that broke.
  it("jp_ask_frequency re-asks (not silently defaults or crashes) when the model returns a meta-response instead of classifying", async () => {
    const FREQ_SESSION: any = {
      jobPostingStep: "jp_ask_frequency",
      jobPostingData: {},
      onboardingData: { seniorName: "Rosie Alvarez" },
    };
    modelReplies("NO", META_OUTPUT);

    await handleJobPostingStep(PHONE, CHAT, "occasional", FREQ_SESSION);

    expect(String(sendMessage.mock.calls[0][1])).toContain("Sorry, I didn't quite catch that");
    expect(String(sendMessage.mock.calls[0][1])).not.toContain("briefing context");
    // Failure path never advances the step — no jobPostingStep write at all.
    expect(hoisted.updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingStep: expect.anything() })
    );
  });
});

describe("formatDateForDisplay (live-caught: raw ISO echoed back in a text message)", () => {
  it("formats a YYYY-MM-DD value as a human-readable date", () => {
    expect(formatDateForDisplay("2026-09-15")).toBe("September 15, 2026");
  });

  it("passes non-ISO values (ASAP, a parse-failure fallback) through unchanged", () => {
    expect(formatDateForDisplay("ASAP")).toBe("ASAP");
    expect(formatDateForDisplay("next Monday")).toBe("next Monday");
    expect(formatDateForDisplay("TBD")).toBe("TBD");
  });
});
