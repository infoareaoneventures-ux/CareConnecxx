import { describe, it, expect, vi } from "vitest";
vi.mock("firebase-admin", () => { const stub: any = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} }) }; return { __esModule: true, default: stub, ...stub }; });
import { classifyPaymentFailure } from "../shiftHours";

describe("classifyPaymentFailure — who the family is told to fix (live 2026-11-18)", () => {
  it("a missing payout account / platform funds is OUR side, never 'the card was declined'", () => {
    expect(classifyPaymentFailure("Your destination account needs to have at least one of the following capabilities enabled: transfers")).toBe("payout");
    expect(classifyPaymentFailure("You have insufficient available funds in your Stripe account.")).toBe("payout");
    expect(classifyPaymentFailure("No such destination: 'acct_123'")).toBe("payout");
  });
  it("no card on file", () => {
    expect(classifyPaymentFailure("Customer cus_1 has no payment method on file")).toBe("no_card");
  });
  it("a bank decline is the card", () => {
    expect(classifyPaymentFailure("Your card was declined.")).toBe("card");
  });
});
