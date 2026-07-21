import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendOnboardingLink = vi.fn(async (_phone: string, linkType: string) => ({
  success: true,
  linkType,
}));
const logAgentAction = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../onboardingConversation", () => ({
  sendOnboardingLink: (...args: unknown[]) => sendOnboardingLink(...(args as [string, string])),
}));

vi.mock("../../observability/actionLedger", () => ({
  logAgentAction: (...args: unknown[]) => logAgentAction(...args),
}));

// Gate-link resend cooldown seam (U9 follow-up, 2026-07-17). The window math
// itself is covered by resendCooldown.test.ts — here we pin how the ACTION
// consults it: throttled → no send + truthful structured result; real send →
// the parked step's window is stamped.
const checkGateLinkThrottle = vi.fn(async (..._args: unknown[]): Promise<{ throttled: boolean; step?: string; minutesSinceLastSend?: number }> => ({ throttled: false }));
const stampGateLinkResentIfParked = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../gateLinkCooldown", () => ({
  checkGateLinkThrottle: (...args: unknown[]) => checkGateLinkThrottle(...args),
  stampGateLinkResentIfParked: (...args: unknown[]) => stampGateLinkResentIfParked(...args),
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
  checkGateLinkThrottle.mockClear();
  checkGateLinkThrottle.mockResolvedValue({ throttled: false });
  stampGateLinkResentIfParked.mockClear();
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
    // The ledger replay executes no send — so it must not re-open the cooldown
    // window either (stamping lives inside run(), which a replay never enters).
    expect(stampGateLinkResentIfParked).toHaveBeenCalledTimes(1);
  });

  describe("gate-link resend cooldown (U9 follow-up)", () => {
    const ctx = { caller: "mcp", role: "caregiver", phone: "+15550001111" } as const;
    const input = { phone: "+15550001111", linkType: "caregiver_photo" };

    it("within the cooldown window: does NOT send and returns a truthful throttle result", async () => {
      checkGateLinkThrottle.mockResolvedValue({
        throttled: true, step: "caregiver_awaiting_photo", minutesSinceLastSend: 3,
      });

      const result = await runSendOnboardingLinkAction(input, ctx);

      expect(sendOnboardingLink).not.toHaveBeenCalled();
      expect(stampGateLinkResentIfParked).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        linkType: "caregiver_photo",
        sent: false,
        throttled: true,
        minutesSinceLastSend: 3,
      });
      // Truthful relay material: when it went out + the LINK escape hatch;
      // never an executed-send claim.
      expect(result.instruction).toContain("3 minutes ago");
      expect(result.instruction).toContain("reply LINK");
      expect(result.instruction).toContain("NO link was sent this turn");
      // The suppressed send never touched the action ledger/audit trail.
      expect(logAgentAction).not.toHaveBeenCalled();
    });

    it("outside the window: sends for real AND stamps the parked step's window", async () => {
      const result = await runSendOnboardingLinkAction(input, ctx);

      expect(checkGateLinkThrottle).toHaveBeenCalledWith("+15550001111", "caregiver_photo");
      expect(sendOnboardingLink).toHaveBeenCalledWith("+15550001111", "caregiver_photo");
      expect(stampGateLinkResentIfParked).toHaveBeenCalledWith("+15550001111", "caregiver_photo");
      expect(result).toMatchObject({ success: true, linkType: "caregiver_photo", sent: true });
      expect(result.throttled).toBeUndefined();
    });

    it("a FAILED send never opens the cooldown window", async () => {
      sendOnboardingLink.mockResolvedValueOnce({ success: false, linkType: "caregiver_photo" });

      const result = await runSendOnboardingLinkAction(input, ctx);

      expect(result.success).toBe(false);
      expect(stampGateLinkResentIfParked).not.toHaveBeenCalled();
    });
  });
});
