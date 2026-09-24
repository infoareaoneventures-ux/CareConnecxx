import { describe, it, expect, vi } from "vitest";
import { runStep, StepDeps } from "./conversationStep";
import { buildClientSteps } from "./onboardingSteps.client";
import { AgentSession } from "../linq/client";

// Self-seeker path: a senior looking for care for THEMSELVES. The sender is
// the care recipient — the flow must mirror their name into the senior slot,
// never ask "who are you caring for", and speak to them directly.

const steps = buildClientSteps({
  generateCaraMessage: vi.fn(async ({ fallback }) => fallback),
  locationPrompt: (base: string) => base,
});

function makeDeps(parseResult = "{}"): StepDeps & { merges: Array<{ fields: unknown; next: string | null }>; sent: string[] } {
  const merges: Array<{ fields: unknown; next: string | null }> = [];
  const sent: string[] = [];
  return {
    merges,
    sent,
    isQuestionOrOther: vi.fn(async () => false),
    answerQuestionMidFlow: vi.fn(async () => "answer"),
    parseWithClaude: vi.fn(async () => parseResult),
    mergeAndAdvance: vi.fn(async (_phone, fields, next) => { merges.push({ fields, next: next as string | null }); }),
    sendMessage: vi.fn(async (_chatId, text) => { sent.push(String(text)); }),
  };
}

describe("client onboarding — self-seeker path", () => {
  it("ask_name mirrors the name into seniorName and skips the who-are-you-caring-for step", async () => {
    const session = {
      onboardingStep: "client_ask_name",
      onboardingData: { relationship: "self" }, // set by the role handler
    } as unknown as AgentSession;
    const deps = makeDeps("Rosa");

    await runStep(steps.client_ask_name, { phone: "+15550001111", chatId: "c1", text: "Rosa", session }, deps);

    expect(deps.merges[0]).toEqual({
      fields: { firstName: "Rosa", seniorName: "Rosa" },
      next: "client_ask_needs", // client_ask_senior skipped
    });
    // The next question speaks to them directly, not about a loved one.
    expect(deps.sent[0]).toContain("you");
    expect(deps.sent[0]).not.toContain("Who are we caring for");
  });

  it("ask_name without self keeps the family path (regression)", async () => {
    const session = {
      onboardingStep: "client_ask_name",
      onboardingData: {},
    } as unknown as AgentSession;
    const deps = makeDeps("Imran");

    await runStep(steps.client_ask_name, { phone: "+15550001111", chatId: "c1", text: "Imran", session }, deps);

    expect(deps.merges[0]).toEqual({
      fields: { firstName: "Imran" },
      next: "client_ask_senior",
    });
  });

  it('ask_senior maps an "it\'s for me" answer to the sender as the recipient', async () => {
    const session = {
      onboardingStep: "client_ask_senior",
      onboardingData: { firstName: "Rosa" },
    } as unknown as AgentSession;
    const deps = makeDeps('{"seniorName":"SELF","relationship":"self"}');

    await runStep(steps.client_ask_senior, { phone: "+15550001111", chatId: "c1", text: "it's for me", session }, deps);

    expect(deps.merges[0]).toEqual({
      fields: { seniorName: "Rosa", relationship: "self" },
      next: "client_ask_needs",
    });
    // Direct address, no third person.
    expect(deps.sent[0]).toContain("you");
    expect(deps.sent[0]).not.toContain("How old is Rosa");
  });

  it("ask_senior keeps the family mapping for a normal answer (regression)", async () => {
    const session = {
      onboardingStep: "client_ask_senior",
      onboardingData: { firstName: "Imran" },
    } as unknown as AgentSession;
    const deps = makeDeps('{"seniorName":"Dorothy","relationship":"mom"}');

    await runStep(steps.client_ask_senior, { phone: "+15550001111", chatId: "c1", text: "my mom Dorothy", session }, deps);

    expect(deps.merges[0]).toEqual({
      fields: { seniorName: "Dorothy", relationship: "mom" },
      next: "client_ask_needs",
    });
  });
});
