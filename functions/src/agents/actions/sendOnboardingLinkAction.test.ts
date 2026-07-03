import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendOnboardingLink = vi.fn(async (_phone: string, linkType: string) => ({
  success: true,
  linkType,
}));
const logAgentAction = vi.fn(async () => undefined);

vi.mock("../onboardingConversation", () => ({
  sendOnboardingLink: (...args: unknown[]) => sendOnboardingLink(...args),
}));

vi.mock("../../observability/actionLedger", () => ({
  logAgentAction: (...args: unknown[]) => logAgentAction(...args),
}));

import { runSendOnboardingLinkAction, sendOnboardingLinkCaraAction } from "./sendOnboardingLinkAction";
import {
  setCaraActionExecutionStoreForTest,
  type CaraActionExecutionClaim,
} from "../actionNative/actionExecutionLedger";

const ledgerDocs = new Map<string, unknown>();

beforeEach(() => {
  sendOnboardingLink.mockClear();
  logAgentAction.mockClear();
  ledgerDocs.clear();
  // In-memory ledger store — the action is failClosed, so an unavailable
  // ledger would (correctly) refuse to run instead of failing open.
  setCaraActionExecutionStoreForTest({
    async claim(key): Promise<CaraActionExecutionClaim> {
      if (ledgerDocs.has(key)) return { cached: true, result: ledgerDocs.get(key) };
      return { cached: false };
    },
    async settle(key, outcome) {
      if (outcome.ok) ledgerDocs.set(key, outcome.result);
      else ledgerDocs.delete(key);
    },
  });
});

afterEach(() => {
  setCaraActionExecutionStoreForTest(null);
});

describe("sendOnboardingLinkAction", () => {
  it("sends the link through the existing onboarding implementation and audits execution", async () => {
    const result = await runSendOnboardingLinkAction(
      { phone: "+15550001111", linkType: "client_payment" },
      { caller: "mcp", role: "client", phone: "+15550001111" },
    );

    expect(sendOnboardingLink).toHaveBeenCalledWith("+15550001111", "client_payment");
    expect(result).toEqual({ success: true, linkType: "client_payment", sent: true });
    expect(logAgentAction).toHaveBeenCalledTimes(2);
    expect(logAgentAction.mock.calls[0][0]).toMatchObject({
      actionType: "onboarding_link_sent",
      status: "confirmed",
      toolName: "send_onboarding_link",
    });
    expect(logAgentAction.mock.calls[1][0]).toMatchObject({
      actionType: "onboarding_link_sent",
      status: "executed",
      toolName: "send_onboarding_link",
      targetDocId: "+15550001111",
    });
  });

  it("keeps the action visible to Evia but not public", () => {
    expect(sendOnboardingLinkCaraAction.modelVisible).toBe(true);
    expect(sendOnboardingLinkCaraAction.publicAllowed).toBe(false);
  });

  it("is fail-closed: never sends when duplicate protection is unverifiable", () => {
    expect(sendOnboardingLinkCaraAction.failClosed).toBe(true);
  });

  it("dedupes an immediate duplicate but does not re-send within the TTL", async () => {
    const ctx = { caller: "mcp", role: "client", phone: "+15550001111" } as const;
    const input = { phone: "+15550001111", linkType: "client_payment" };

    const first = await runSendOnboardingLinkAction(input, ctx);
    const second = await runSendOnboardingLinkAction(input, ctx);

    expect(first).toEqual(second);
    expect(sendOnboardingLink).toHaveBeenCalledTimes(1); // duplicate replayed from ledger, not re-sent
  });
});
