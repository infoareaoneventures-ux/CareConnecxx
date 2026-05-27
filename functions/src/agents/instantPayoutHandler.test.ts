import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const addMock    = vi.fn().mockResolvedValue({ id: "ip-1" });
  const docGetMock = vi.fn();
  const sessionDocGetMock = vi.fn().mockResolvedValue({
    exists: true,
    data: () => ({
      pendingInstantPayoutStripeAccount: "acct_123",
      pendingInstantPayoutAmount: "5000",
      pendingInstantPayoutCurrency: "usd",
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
  const generateCaraMessage = vi.fn().mockResolvedValue("ack");

  // Stripe balance + payouts mocks
  const balanceRetrieve = vi.fn();
  const payoutsCreate   = vi.fn();

  // The handler calls `new Stripe(...)` — vi.fn() arrow functions are NOT
  // constructable, so we expose a real class. The class returns a shared
  // instance referencing the spy mocks above.
  class StripeMock {
    balance = { retrieve: balanceRetrieve };
    payouts = { create:   payoutsCreate   };
  }
  const stripeFactory: any = StripeMock;

  return {
    updateMock, addMock, docGetMock, sessionDocGetMock, collectionMock,
    sendMessage, parseWithClaude, quickComplete, generateCaraMessage,
    balanceRetrieve, payoutsCreate, stripeFactory,
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
  generateCaraMessage: (...args: unknown[]) => hoisted.generateCaraMessage(...args),
}));

// The handler does `const Stripe = require("stripe")` so we mock the module.
vi.mock("stripe", () => ({
  default: hoisted.stripeFactory,
}));

const { updateMock, sendMessage, parseWithClaude, docGetMock, balanceRetrieve, payoutsCreate, addMock } = hoisted;

import { startInstantPayout, handleInstantPayoutConfirm } from "./instantPayoutHandler";

const CG_ID = "cg-1";
const PHONE = "+15555550100";
const CHAT  = "chat-1";

describe("instantPayoutHandler", () => {
  beforeEach(() => {
    updateMock.mockClear();
    sendMessage.mockClear();
    addMock.mockClear();
    parseWithClaude.mockReset();
    hoisted.quickComplete.mockReset();
    balanceRetrieve.mockReset();
    payoutsCreate.mockReset();
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

    it("zero balance → tells caregiver and skips confirmation", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ stripeAccountId: "acct_123" }) });
      balanceRetrieve.mockResolvedValueOnce({ instant_available: [{ amount: 0, currency: "usd" }] });
      await startInstantPayout(CG_ID, PHONE, CHAT);
      expect(sendMessage.mock.calls[0][1]).toMatch(/don't have any funds available/);
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ pendingInstantPayoutConfirm: expect.anything() }));
    });

    it("positive balance → shows confirmation and persists state", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ stripeAccountId: "acct_123" }) });
      balanceRetrieve.mockResolvedValueOnce({ instant_available: [{ amount: 5000, currency: "usd" }] });
      await startInstantPayout(CG_ID, PHONE, CHAT);

      // Confirmation message
      expect(sendMessage.mock.calls[0][1]).toMatch(/\$50\.00.*YES.*NO/i);
      // State persisted with confirm flag + amount
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ pendingInstantPayoutConfirm: expect.any(String) }));
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pendingInstantPayoutAmount:        "5000",
        pendingInstantPayoutStripeAccount: "acct_123",
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
      hoisted.quickComplete.mockResolvedValueOnce("The fee is 1.5%.");

      await handleInstantPayoutConfirm(CG_ID, PHONE, "what's the fee?", CHAT);

      expect(payoutsCreate).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][1]).toMatch(/fee is 1\.5%/);
    });

    it("YES path → creates Stripe instant payout and records it", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES"); // decision
      payoutsCreate.mockResolvedValueOnce({ id: "po_123" });

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes send it", CHAT);

      expect(payoutsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 5000, currency: "usd", method: "instant" }),
        expect.objectContaining({ stripeAccount: "acct_123" }),
      );
      // Record written
      expect(addMock).toHaveBeenCalledWith(expect.objectContaining({
        caregiverId: CG_ID,
        amountCents: 5000,
        stripePayoutId: "po_123",
      }));
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/\$50\.00 is on the way/);
    });

    it("NO path → no payout, friendly ack", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce("NO"); // decision

      await handleInstantPayoutConfirm(CG_ID, PHONE, "wait, never mind", CHAT);

      expect(payoutsCreate).not.toHaveBeenCalled();
      expect(addMock).not.toHaveBeenCalled();
    });

    it("Stripe payout failure → tells caregiver funds are safe", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES"); // decision
      payoutsCreate.mockRejectedValueOnce(new Error("Bank not enabled"));

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes", CHAT);

      expect(payoutsCreate).toHaveBeenCalled();
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/funds are safe/i);
      expect(addMock).not.toHaveBeenCalled();
    });

    it("YES path always clears pendingInstantPayoutConfirm state", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");
      payoutsCreate.mockResolvedValueOnce({ id: "po_123" });

      await handleInstantPayoutConfirm(CG_ID, PHONE, "yes", CHAT);

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pendingInstantPayoutConfirm:       "__DELETE__",
        pendingInstantPayoutAmount:        "__DELETE__",
        pendingInstantPayoutStripeAccount: "__DELETE__",
      }));
    });
  });
});
