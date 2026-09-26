// U5 — display pricing source of truth (R7).
//
// The accessors are deliberately trivial: the value of this suite is pinning
// the three canonical display strings so a change here is a conscious,
// reviewed pricing decision — and the bare/with-period variants can never
// drift apart, since both derive from one constant per price.

import { describe, it, expect } from "vitest";
import {
  clientMonthlyAmount,
  clientMonthlyDisplay,
  caregiverAnnualAmount,
  caregiverAnnualDisplay,
} from "./pricing";

describe("display pricing accessors (R7)", () => {
  it("returns the canonical display strings", () => {
    expect(clientMonthlyDisplay()).toBe("$29.95/month");
    expect(caregiverAnnualDisplay()).toBe("$69.99/year");
  });

  it("derives bare amounts from the same constants as the period forms", () => {
    expect(clientMonthlyAmount()).toBe("$29.95");
    expect(caregiverAnnualAmount()).toBe("$69.99");
    expect(clientMonthlyDisplay()).toBe(`${clientMonthlyAmount()}/month`);
    expect(caregiverAnnualDisplay()).toBe(`${caregiverAnnualAmount()}/year`);
  });
});
