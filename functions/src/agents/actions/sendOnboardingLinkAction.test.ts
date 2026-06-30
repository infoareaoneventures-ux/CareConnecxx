import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  sendOnboardingLink.mockClear();
  logAgentAction.mockClear();
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

  it("keeps the action visible to Cara but not public", () => {
    expect(sendOnboardingLinkCaraAction.modelVisible).toBe(true);
    expect(sendOnboardingLinkCaraAction.publicAllowed).toBe(false);
  });
});
