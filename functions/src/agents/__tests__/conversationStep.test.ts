import { describe, it, expect, vi, beforeEach } from "vitest";
import { runStep, ConversationStep, StepDeps, RunStepContext } from "../conversationStep";
import { AgentSession } from "../../linq/client";

// runStep is pure control flow — all side effects arrive through StepDeps, so
// the test only needs fakes. No Firestore, no network. The interface IS the
// test surface.

function makeDeps(over: Partial<StepDeps> = {}): StepDeps {
  return {
    isQuestionOrOther:     vi.fn().mockResolvedValue(false),
    answerQuestionMidFlow: vi.fn().mockResolvedValue("Here's the answer to your question."),
    parseWithClaude:       vi.fn().mockResolvedValue("Maria"),
    mergeAndAdvance:        vi.fn().mockResolvedValue(undefined),
    sendMessage:            vi.fn().mockResolvedValue({ message_id: "m1" }),
    ...over,
  };
}

// A representative "ask name" step: parse returns a field map, or null when the
// name can't be read.
function nameStep(over: Partial<ConversationStep> = {}): ConversationStep {
  return {
    id:          "client_ask_name",
    parsePrompt: "Extract the first name.",
    parse:       (raw) => (raw && raw !== "__parse_error__" ? { firstName: raw } : null),
    nextStep:    "client_ask_senior",
    reask:       () => "What's your name?",
    retry:       () => "I didn't catch your name — could you share it?",
    nextQuestion: async (s) =>
      `Thanks ${(s.onboardingData as Record<string, unknown>)?.firstName ?? "there"}! Who are you looking for care for?`,
    ...over,
  };
}

function ctx(over: Partial<RunStepContext> = {}): RunStepContext {
  return {
    phone:   "+15125550123",
    chatId:  "chat-1",
    text:    "Maria",
    session: { onboardingStep: "client_ask_name", onboardingData: {} } as unknown as AgentSession,
    ...over,
  };
}

describe("runStep", () => {
  let deps: StepDeps;
  beforeEach(() => { deps = makeDeps(); });

  it("happy path: parses, merges + advances in one write, asks the next question", async () => {
    await runStep(nameStep(), ctx(), deps);

    // Exactly one merge+advance write, carrying both the field and the next step.
    expect(deps.mergeAndAdvance).toHaveBeenCalledTimes(1);
    expect(deps.mergeAndAdvance).toHaveBeenCalledWith(
      "+15125550123",
      { firstName: "Maria" },
      "client_ask_senior",
    );
    // The next question is sent (and only it — no separate ack send).
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect((deps.sendMessage as any).mock.calls[0][1]).toContain("Who are you looking for care for?");
  });

  it("acknowledges the answer before the next question", async () => {
    const c = ctx();
    await runStep(nameStep(), c, deps);
    // nextQuestion sees the just-saved field (runStep reflected the write in memory).
    const sent = (deps.sendMessage as any).mock.calls[0][1] as string;
    expect(sent).toContain("Maria");
  });

  it("mid-flow question: answers + re-asks, never writes or advances", async () => {
    deps = makeDeps({ isQuestionOrOther: vi.fn().mockResolvedValue(true) });
    await runStep(nameStep(), ctx({ text: "wait how much does this cost?" }), deps);

    expect(deps.answerQuestionMidFlow).toHaveBeenCalledOnce();
    expect(deps.mergeAndAdvance).not.toHaveBeenCalled();
    // Two sends: the answer, then the re-asked current question.
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    expect((deps.sendMessage as any).mock.calls[1][1]).toBe("What's your name?");
    // Parser is never consulted for a question.
    expect(deps.parseWithClaude).not.toHaveBeenCalled();
  });

  it("parse error: sends the retry prompt and does not advance", async () => {
    deps = makeDeps({ parseWithClaude: vi.fn().mockResolvedValue("__parse_error__") });
    await runStep(nameStep(), ctx(), deps);

    expect(deps.mergeAndAdvance).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect((deps.sendMessage as any).mock.calls[0][1]).toContain("didn't catch your name");
  });

  it("validation reject (parse returns null) re-asks without advancing", async () => {
    // parse returns null for empty extraction.
    deps = makeDeps({ parseWithClaude: vi.fn().mockResolvedValue("") });
    await runStep(nameStep(), ctx(), deps);

    expect(deps.mergeAndAdvance).not.toHaveBeenCalled();
    expect((deps.sendMessage as any).mock.calls[0][1]).toContain("didn't catch your name");
  });

  it("empty field map is a valid answer (e.g. 'no preference') and still advances", async () => {
    const prefStep = nameStep({
      id:       "client_ask_preferences",
      parse:    () => ({}), // "no preference" → empty map, NOT null
      nextStep: "client_ask_budget",
      nextQuestion: async () => "Do you have an hourly budget in mind?",
    });
    await runStep(prefStep, ctx({ text: "no preference" }), deps);

    expect(deps.mergeAndAdvance).toHaveBeenCalledWith("+15125550123", {}, "client_ask_budget");
    expect((deps.sendMessage as any).mock.calls[0][1]).toContain("budget");
  });

  it("atomicity: field merge and step advance are a single write, not two", async () => {
    const calls: unknown[][] = [];
    deps = makeDeps({
      mergeAndAdvance: vi.fn(async (...args: unknown[]) => { calls.push(args); }),
    });
    await runStep(nameStep(), ctx(), deps);

    expect(calls).toHaveLength(1);
    // Both the field map and the next step travel together in that one call.
    expect(calls[0][1]).toEqual({ firstName: "Maria" });
    expect(calls[0][2]).toBe("client_ask_senior");
  });

  it("terminal step (nextStep null) advances to no step but still asks", async () => {
    const terminal = nameStep({ nextStep: null, nextQuestion: async () => "All set!" });
    const c = ctx();
    await runStep(terminal, c, deps);

    expect(deps.mergeAndAdvance).toHaveBeenCalledWith("+15125550123", { firstName: "Maria" }, null);
    // onboardingStep is left unchanged when nextStep is null.
    expect(c.session.onboardingStep).toBe("client_ask_name");
  });
});
