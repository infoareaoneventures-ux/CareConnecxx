import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const addMock    = vi.fn().mockResolvedValue({ id: "ip-1" });
  const docGetMock = vi.fn();
  const sessionDocGetMock = vi.fn().mockResolvedValue({
    exists: true,
    data: () => ({
      pendingInstantPayoutAmount: "5000",
    }),
  });

  const docFn = vi.fn((id?: string) => ({
    update: updateMock,
    get:    id && id.startsWith("+") ? sessionDocGetMock : docGetMock,
  }));
  const collectionMock = vi.fn(() => ({ doc: docFn, add: addMock }));

  const sendMessage         = vi.fn().mockResolvedValue({ message_id: "x" });
  const parseWithClaude     = vi.fn();
  const quickComplete       = vi.fn();
  // generateCaraMessage wraps an LLM call but deterministically returns its
  // `fallback` on empty/error output — that fallback is the contract the error
  // paths rely on, so the mock mirrors it instead of a constant.
  const generateCaraMessage = vi.fn(async (opts: any) => opts?.fallback ?? "ack");

  // Stripe balance mock (preview only — the payout itself goes through the
  // shared executeInstantPayout, mocked separately below).
  const balanceRetrieve = vi.fn();
  class StripeMock {
    balance = { retrieve: balanceRetrieve };
  }
  const stripeFactory: any = StripeMock;

  // Shared payout module mock
  const executeInstantPayout = vi.fn();
  class InstantPayoutError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "InstantPayoutError";
    }
  }

  return {
    updateMock, addMock, docGetMock, sessionDocGetMock, collectionMock,
    sendMessage, parseWithClaude, quickComplete, generateCaraMessage,
    balanceRetrieve, stripeFactory, executeInstantPayout, InstantPayoutError,
  };
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

vi.mock("../utils/parseWithClaude", () => ({
  parseWithClaude: (...args: unknown[]) => hoisted.parseWithClaude(...args),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: (...args: unknown[]) => hoisted.generateCaraMessage(...(args as [unknown])),
}));

vi.mock("stripe", () => ({
  default: hoisted.stripeFactory,
}));

// Single shared payout implementation — the handler must delegate to it.
vi.mock("../payoutCommon", () => ({
  executeInstantPayout: (...args: unknown[]) => hoisted.executeInstantPayout(...args),
  InstantPayoutError: hoisted.InstantPayoutError,
}));

const { updateMock, sendMessage, parseWithClaude, docGetMock, balanceRetrieve, executeInstantPayout } = hoisted;

import { startInstantPayout, handleInstantPayoutConfirm } from "./instantPayoutHandler";

const CG_ID = "cg-1";
const PHONE = "+15555550100";
const CHAT  = "chat-1";

describe("instantPayoutHandler", () => {
  beforeEach(() => {
    updateMock.mockClear();
    sendMessage.mockClear();
    hoisted.addMock.mockClear();
    parseWithClaude.mockReset();
    hoisted.quickComplete.mockReset();
    balanceRetrieve.mockReset();
    executeInstantPayout.mockReset();
    docGetMock.mockReset();
  });

  describe("startInstantPayout", () => {
    it("missing caregiver doc → friendly error", async () => {
      docGetMock.mockResolvedValueOnce({ exists: false, data: () => null });
      await startInstantPayout(CG_ID, PHONE, CHAT);
      expect(sendMessage.mock.calls[0][1]).toMatch(/couldn't find your caregiver profile/);
    });

    it("no Stripe Connect account → tells caregiver to finish setup", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ name: "Maria" }) });
      await startInstantPayout(CG_ID, PHONE, CHAT);
      expect(sendMessage.mock.calls[0][1]).toMatch(/payout account isn't set up/);
    });

    it("zero balance → explains automatic daily payouts and skips confirmation", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ stripeAccountId: "acct_123" }) });
      balanceRetrieve.mockResolvedValueOnce({ instant_available: [{ amount: 0, currency: "usd" }] });
      await startInstantPayout(CG_ID, PHONE, CHAT);
      expect(sendMessage.mock.calls[0][1]).toMatch(/pay out automatically/);
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ pendingInstantPayoutConfirm: expect.anything() }));
    });

    it("positive balance → shows the fee and what arrives, and persists state", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ stripeAccountId: "acct_123" }) });
      balanceRetrieve.mockResolvedValueOnce({ instant_available: [{ amount: 5000, currency: "usd" }] });
      await startInstantPayout(CG_ID, PHONE, CHAT);

      // Confirmation message — Stripe's fee and the net amount, YES/NO gate
      expect(sendMessage.mock.calls[0][1]).toMatch(/\$50\.00[\s\S]*YES[\s\S]*NO/i);
      expect(sendMessage.mock.calls[0][1]).toMatch(/\$0\.50/);
      expect(sendMessage.mock.calls[0][1]).toMatch(/\$49\.50/);
      expect(sendMessage.mock.calls[0][1]).not.toMatch(/free instant/i);
      // State persisted with confirm flag + amount
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pendingInstantPayoutConfirm: expect.any(String),
        pendingInstantPayoutAmount:  "5000",
      }));
    });

    it("Stripe balance lookup fails → graceful error", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ stripeAccountId: "acct_123" }) });
      balanceRetrieve.mockRejectedValueOnce(new Error("Stripe down"));
      await startInstantPayout(CG_ID, PHONE, CHAT);
      expect(sendMessage.mock.calls[0][1]).toMatch(/couldn't pull your balance/);
    });
  });

  describe("handleInstantPayoutConfirm", () => {
    it("question route → answers and does NOT create payout", async () => {
      parseWithClaude.mockResolvedValueOnce("YES"); // isQuestionOrOther
      hoisted.quickComplete.mockResolvedValueOnce("Stripe charges 1% (minimum $0.50) for instant payouts.");

      await handleInstantPayoutConfirm(CG_ID, PHONE, "is there a fee?", CHAT);

      expect(executeInstantPayout).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/1%/);
    });

    it("YES path → delegates to shared executeInstantPayout", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES"); // decision
      executeInstantPayout.mockResolvedValueOnce({
        payoutDocId: "p1", stripePayoutId: "po_123", amountCents: 4950, grossCents: 5000, feeCents: 50, status: "pending", arrivalDate: null,
      });

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes send it", CHAT);

      expect(executeInstantPayout).toHaveBeenCalledWith(
        expect.objectContaining({ caregiverId: CG_ID, source: "cara_sms" }),
      );
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/\$49\.50 is on the way.*\$0\.50 instant fee/i);
    });

    it("NO path → no payout, friendly ack", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce("NO"); // decision

      await handleInstantPayoutConfirm(CG_ID, PHONE, "wait, never mind", CHAT);

      expect(executeInstantPayout).not.toHaveBeenCalled();
    });

    it("Stripe payout failure → tells caregiver funds are safe", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES"); // decision
      executeInstantPayout.mockRejectedValueOnce(new hoisted.InstantPayoutError("STRIPE_ERROR", "Bank not enabled"));

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes", CHAT);

      expect(executeInstantPayout).toHaveBeenCalled();
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/funds are safe/i);
    });

    it("balance already swept between preview and YES → automatic-payout reassurance", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");
      executeInstantPayout.mockRejectedValueOnce(new hoisted.InstantPayoutError("NO_BALANCE", "nothing available"));

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes", CHAT);

      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/paid out automatically/i);
    });

    it("replayed YES → duplicate guard message, no double payout", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");
      executeInstantPayout.mockRejectedValueOnce(new hoisted.InstantPayoutError("DUPLICATE", "already processing"));

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes", CHAT);

      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/already sent/i);
    });

    it("YES path always clears pending state", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");
      executeInstantPayout.mockResolvedValueOnce({
        payoutDocId: "p1", stripePayoutId: "po_123", amountCents: 4950, grossCents: 5000, feeCents: 50, status: "pending", arrivalDate: null,
      });

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes", CHAT);

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pendingInstantPayoutConfirm: "__DELETE__",
        pendingInstantPayoutAmount:  "__DELETE__",
      }));
    });
  });
});
