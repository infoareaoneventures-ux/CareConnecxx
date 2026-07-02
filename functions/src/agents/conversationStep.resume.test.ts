import { describe, it, expect, vi } from "vitest";
import { runStep, ConversationStep, StepDeps } from "./conversationStep";
import { AgentSession } from "../linq/client";

// A step whose parse() NEVER returns null (defaults to a value and advances) —
// e.g. client_ask_senior, which defaults seniorName to "your loved one". This is
// the dangerous shape: on a checkpoint RESUME the literal "__RESUME__" sentinel
// must NOT be parsed as the user's answer and must NOT advance the step.
const defaultingStep: ConversationStep = {
  id: "client_ask_senior",
  parsePrompt: "extract senior name",
  parse: () => ({ seniorName: "your loved one", relationship: "family member" }),
  nextStep: "client_ask_needs",
  reask: () => "Who are you looking for care for? (Their name and your relationship)",
  retry: () => "Hmm, I didn't catch that — who are you looking for care for?",
  nextQuestion: async () => "Got it — what kind of help do they need?",
};

function makeDeps(): StepDeps & { merges: unknown[]; sent: string[] } {
  const merges: unknown[] = [];
  const sent: string[] = [];
  return {
    merges,
    sent,
    isQuestionOrOther: vi.fn(async () => false),
    answerQuestionMidFlow: vi.fn(async () => "answer"),
    parseWithClaude: vi.fn(async () => "{}"),
    mergeAndAdvance: vi.fn(async (_phone, fields, next) => { merges.push({ fields, next }); }),
    sendMessage: vi.fn(async (_chatId, text) => { sent.push(text); }),
  };
}

describe("runStep — checkpoint RESUME sentinel", () => {
  const session = { onboardingStep: "client_ask_senior", onboardingData: {} } as AgentSession;

  it("re-asks the current question without parsing or advancing on __RESUME__", async () => {
    const deps = makeDeps();
    await runStep(defaultingStep, { phone: "+15551234567", chatId: "c1", text: "__RESUME__", session }, deps);

    // The sentinel must never be classified, parsed, or advanced.
    expect(deps.parseWithClaude).not.toHaveBeenCalled();
    expect(deps.mergeAndAdvance).not.toHaveBeenCalled();
    expect(deps.isQuestionOrOther).not.toHaveBeenCalled();
    // It should re-ask the current step's question (resume intent).
    expect(deps.sent).toEqual([defaultingStep.reask(session)]);
  });

  it("still parses + advances a real answer (regression guard)", async () => {
    const deps = makeDeps();
    await runStep(defaultingStep, { phone: "+15551234567", chatId: "c1", text: "my dad John", session }, deps);
    expect(deps.mergeAndAdvance).toHaveBeenCalledTimes(1);
    expect(deps.merges[0]).toEqual({
      fields: { seniorName: "your loved one", relationship: "family member" },
      next: "client_ask_needs",
    });
  });

  it("passes the current question to the mid-flow classifier (bare-name fix)", async () => {
    // Without the question as context, a one-word answer like "Imran" to
    // "What's your name?" was misjudged as off-topic → answer + re-ask loop.
    const deps = makeDeps();
    await runStep(defaultingStep, { phone: "+15551234567", chatId: "c1", text: "Imran", session }, deps);
    expect(deps.isQuestionOrOther).toHaveBeenCalledWith("Imran", defaultingStep.reask(session));
  });
});
