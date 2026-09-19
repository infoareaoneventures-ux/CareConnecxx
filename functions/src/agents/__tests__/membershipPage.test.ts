// The Membership page as data — the card's plan, status, next billing / end
// date, and the buttons the family sees in that state.
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({}) }) }) }) }));

import { shapeMembershipPage } from "../membershipPage";

const END = { seconds: Math.floor(Date.parse("2026-10-17T07:00:00.000Z") / 1000) }; // Oct 17, 2026 Pacific

describe("shapeMembershipPage", () => {
  it("no record → the plan card with Select a plan", () => {
    const p = shapeMembershipPage(null);
    expect(p).toMatchObject({ hasMembership: false, isActive: false, cancelScheduled: false, actions: ["select_plan"], plan: { name: "Standard Plan", price: "$29.95/month" } });
    expect(p.summary).toContain('"Select a plan"');
  });

  it("active → next billing date, Cancel + Manage", () => {
    const p = shapeMembershipPage({ status: "active", current_period_end: END, cancel_at_period_end: false, price_id: "price_1" });
    expect(p).toMatchObject({ isActive: true, cancelScheduled: false, periodEnd: "2026-10-17", priceId: "price_1", actions: ["cancel", "manage"] });
    expect(p.periodEndLabel).toBe("Next billing date: Saturday, October 17, 2026");
    expect(p.summary).toBe("Standard Plan ($29.95/month) — active, next billing date Saturday, October 17, 2026.");
  });

  it("cancel scheduled → the end date, Reactivate + Manage", () => {
    const p = shapeMembershipPage({ status: "active", current_period_end: END, cancel_at_period_end: true });
    expect(p).toMatchObject({ isActive: true, cancelScheduled: true, actions: ["reactivate", "manage"] });
    expect(p.periodEndLabel).toBe("Your membership ends on Saturday, October 17, 2026");
  });

  it("past due → not active, says the payment didn't go through", () => {
    const p = shapeMembershipPage({ status: "past_due", current_period_end: END });
    expect(p.isActive).toBe(false);
    expect(p.actions).toEqual(["select_plan"]);
    expect(p.summary).toContain("past due");
  });

  it("caregiver role → the caregiver plan card", () => {
    expect(shapeMembershipPage({ status: "active", current_period_end: END }, "caregiver").plan.price).toBe("$54.99/year");
  });
});
