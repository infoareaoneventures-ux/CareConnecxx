import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const messagesCreate = vi.fn();
  const addMock        = vi.fn().mockResolvedValue({ id: "log-1" });
  return { messagesCreate, addMock };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    firestore: () => ({
      collection: () => ({ add: hoisted.addMock }),
    }),
  },
  firestore: () => ({
    collection: () => ({ add: hoisted.addMock }),
  }),
}));

vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({
    messages: { create: (...args: unknown[]) => hoisted.messagesCreate(...args) },
  }),
}));

import { supervise } from "./supervisor";

function mockHaikuReply(json: object): void {
  hoisted.messagesCreate.mockResolvedValueOnce({
    content: [{ text: JSON.stringify(json) }],
  });
}

describe("supervise", () => {
  beforeEach(() => {
    hoisted.messagesCreate.mockReset();
    hoisted.addMock.mockClear();
  });

  it("returns the original (linted) message when Haiku reports no violation", async () => {
    const msg = "I found two caregivers for your mom. Want me to set up intros?";
    mockHaikuReply({ violation: false, revised: msg });
    const out = await supervise(msg, { phone: "+15550001111" });
    expect(out).toBe(msg);
    expect(hoisted.addMock).not.toHaveBeenCalled();
  });

  it("strips banned phrases from Haiku rewrites so they never reach the user", async () => {
    // Regression: Haiku used to inject 'I'm not able to' + 'contact our care team'
    // + 'our main number' + 'Is there anything else' boilerplate after wrongly
    // flagging an onboarding ask as a PHI violation. Those phrases bypassed the
    // upfront linter; re-linting the rewrite kills them.
    mockHaikuReply({
      violation: true,
      revised:
        "I'm not able to confirm personal health information. " +
        "Please contact our care team directly at our main number. " +
        "Is there anything else I can help you with?",
    });
    const out = await supervise("any reply", { phone: "+15550001111" });
    expect(out.toLowerCase()).not.toContain("i'm not able to");
    expect(out.toLowerCase()).not.toContain("is there anything else");
    // The phrase 'contact our care team' isn't in BANNED_PHRASES today, but
    // 'I'm not able to' anchors the sentence — once stripped, what remains
    // must not be the full refusal boilerplate.
    expect(out).not.toMatch(/^I'm not able to/i);
  });

  it("falls back to the linted original when the rewrite collapses to empty after re-lint", async () => {
    // The em-dash gets normalized to a comma by the upfront linter — the fallback
    // returns that linted form (it never goes back to raw input).
    const original = "Sure, I'll set up the onboarding now.";
    mockHaikuReply({
      violation: true,
      // Every clause here is a banned phrase; lintMessage strips it to empty.
      revised: "I'm not able to. I cannot. I am unable. Is there anything else I can help you with?",
    });
    const out = await supervise(original, { phone: "+15550001111" });
    expect(out).toBe(original);
  });

  it("falls back to the linted original on Haiku failure (fail-open, not fail-shut)", async () => {
    hoisted.messagesCreate.mockRejectedValueOnce(new Error("haiku down"));
    const msg = "Booking Maria for Thursday at 9am.";
    const out = await supervise(msg, { phone: "+15550001111" });
    expect(out).toBe(msg);
  });

  it("strips the new bureaucratic banned phrases from rewrites", async () => {
    // Regression: the screenshot reply included "Go ahead and share those and
    // I'll get everything on file for you." — customer-service tone that Evia
    // is forbidden from. Linter now bans those phrases.
    mockHaikuReply({
      violation: true,
      revised:
        "Got it. Go ahead and share those, and I'll get everything on file for you. " +
        "What's your name?",
    });
    const out = await supervise("any reply", { phone: "+15550001111" });
    expect(out.toLowerCase()).not.toContain("go ahead and share");
    expect(out.toLowerCase()).not.toContain("on file for you");
    // The salvageable question should remain
    expect(out).toMatch(/what.*name/i);
  });

  it("falls back when Haiku returns malformed JSON", async () => {
    hoisted.messagesCreate.mockResolvedValueOnce({
      content: [{ text: "not json at all" }],
    });
    const msg = "I'll check the schedule.";
    const out = await supervise(msg, { phone: "+15550001111" });
    expect(out).toBe(msg);
  });
});
