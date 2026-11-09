import { describe, it, expect } from "vitest";
import { invoiceSubscriptionId, subscriptionPeriod, withTopLevelPeriod } from "../stripeCompat";

const OLD_INVOICE = { id: "in_1", subscription: "sub_old" } as any;
const OLD_INVOICE_EXPANDED = { id: "in_1", subscription: { id: "sub_exp" } } as any;
const NEW_INVOICE = { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_new" } } } as any;

describe("invoiceSubscriptionId — old and 2025+ payload shapes", () => {
  it("reads the old top-level field (string or expanded)", () => {
    expect(invoiceSubscriptionId(OLD_INVOICE)).toBe("sub_old");
    expect(invoiceSubscriptionId(OLD_INVOICE_EXPANDED)).toBe("sub_exp");
  });
  it("reads invoice.parent.subscription_details.subscription", () => {
    expect(invoiceSubscriptionId(NEW_INVOICE)).toBe("sub_new");
  });
  it("a one-off invoice (no subscription) or nothing → undefined", () => {
    expect(invoiceSubscriptionId({ id: "in_2", parent: null } as any)).toBeUndefined();
    expect(invoiceSubscriptionId({ id: "in_2", subscription: null } as any)).toBeUndefined();
    expect(invoiceSubscriptionId(undefined)).toBeUndefined();
  });
});

const OLD_SUB = { id: "sub_1", current_period_start: 1_700_000_000, current_period_end: 1_702_592_000, items: { data: [{ price: { id: "p" } }] } } as any;
const NEW_SUB = { id: "sub_1", items: { data: [{ price: { id: "p" }, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 }] } } as any;

describe("subscriptionPeriod / withTopLevelPeriod", () => {
  it("reads the old top-level fields and the new item-level ones to the same answer", () => {
    expect(subscriptionPeriod(OLD_SUB)).toEqual({ start: 1_700_000_000, end: 1_702_592_000 });
    expect(subscriptionPeriod(NEW_SUB)).toEqual({ start: 1_700_000_000, end: 1_702_592_000 });
  });
  it("fills the top-level fields from the item, so `new Date(sub.current_period_end * 1000)` is a real date", () => {
    const n = withTopLevelPeriod(NEW_SUB);
    expect(n.current_period_end).toBe(1_702_592_000);
    expect(Number.isNaN(new Date(n.current_period_end * 1000).getTime())).toBe(false);
    expect(NEW_SUB.current_period_end).toBeUndefined(); // the input is not mutated
  });
  it("leaves an old-shape or period-less subscription untouched", () => {
    expect(withTopLevelPeriod(OLD_SUB)).toBe(OLD_SUB);
    const bare = { id: "sub_2", items: { data: [] } } as any;
    expect(withTopLevelPeriod(bare)).toBe(bare);
  });
});
