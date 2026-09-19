// The service fee and the instant-payout fee: one calculation each, and the
// site's mirror (utils/pricing.ts) must carry the same numbers — a display that
// disagrees with the charge is the one thing this change must never do.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { serviceFeeCentsFor, totalChargeCentsFor, instantPayoutFeeCentsFor } from "./shiftBillingAmounts";
import {
  SHIFT_PLATFORM_FEE_RATE, SHIFT_PLATFORM_FEE_MIN_DOLLARS, INSTANT_PAYOUT_FEE_RATE, INSTANT_PAYOUT_FEE_MIN_DOLLARS,
} from "./config";

describe("service fee — 9% of the caregiver total, $1 minimum, integer cents, rounded once", () => {
  it("typical visits", () => {
    expect(serviceFeeCentsFor(10000)).toBe(900);   // $100 → $9.00
    expect(serviceFeeCentsFor(5000)).toBe(450);    // $50 → $4.50
    expect(serviceFeeCentsFor(2000)).toBe(180);    // $20 → $1.80
    expect(totalChargeCentsFor(10000)).toBe(10900);
  });
  it("the $1 minimum and the rounding boundary", () => {
    expect(serviceFeeCentsFor(295)).toBe(100);     // last night's $2.95 test visit → $1.00
    expect(serviceFeeCentsFor(1111)).toBe(100);    // 9% = 99.99 → 100 either way
    expect(serviceFeeCentsFor(1112)).toBe(100);    // 100.08 → 100
    expect(serviceFeeCentsFor(1117)).toBe(101);    // 100.53 → 101
    expect(serviceFeeCentsFor(19235)).toBe(1731);  // 1731.15 → 1731
  });
  it("nothing owed → no fee; junk → no fee", () => {
    expect(serviceFeeCentsFor(0)).toBe(0);
    expect(serviceFeeCentsFor(-5)).toBe(0);
    expect(serviceFeeCentsFor(NaN)).toBe(0);
    expect(totalChargeCentsFor(0)).toBe(0);
  });
});

describe("instant payout fee — Stripe's 1%, $0.50 minimum, passed to the caregiver", () => {
  it("amounts", () => {
    expect(instantPayoutFeeCentsFor(10000)).toBe(100);
    expect(instantPayoutFeeCentsFor(5000)).toBe(50);
    expect(instantPayoutFeeCentsFor(2000)).toBe(50);   // minimum
    expect(instantPayoutFeeCentsFor(100)).toBe(50);    // $1 payout → 50¢ fee, 50¢ arrives
    expect(instantPayoutFeeCentsFor(0)).toBe(0);
  });
});

describe("the site mirror (utils/pricing.ts) carries the same constants", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../../utils/pricing.ts"), "utf8");
  const num = (name: string) => {
    const m = src.match(new RegExp(`export const ${name} = ([0-9.]+);`));
    if (!m) throw new Error(`utils/pricing.ts lost ${name}`);
    return Number(m[1]);
  };
  it("service fee rate and minimum", () => {
    expect(num("SERVICE_FEE_RATE")).toBe(SHIFT_PLATFORM_FEE_RATE);
    expect(num("SERVICE_FEE_MIN_CENTS")).toBe(Math.round(SHIFT_PLATFORM_FEE_MIN_DOLLARS * 100));
    expect(src).toContain(`SERVICE_FEE_PERCENT_LABEL = '${Math.round(SHIFT_PLATFORM_FEE_RATE * 100)}%'`);
  });
  it("instant payout fee rate and minimum", () => {
    expect(num("INSTANT_PAYOUT_FEE_RATE")).toBe(INSTANT_PAYOUT_FEE_RATE);
    expect(num("INSTANT_PAYOUT_FEE_MIN_CENTS")).toBe(Math.round(INSTANT_PAYOUT_FEE_MIN_DOLLARS * 100));
  });
  it("the site's arithmetic is the backend's arithmetic", () => {
    // Evaluate the site helper's body against the backend for a sweep of amounts.
    const body = src.match(/export function serviceFeeCents\(grossCents: number\): number \{([\s\S]*?)\n\}/);
    if (!body) throw new Error("serviceFeeCents body not found");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const siteFn = new Function("grossCents", "SERVICE_FEE_RATE", "SERVICE_FEE_MIN_CENTS", body[1]
      .replace(/const g = /, "var g = ")) as (g: number, r: number, m: number) => number;
    for (const cents of [0, 1, 99, 100, 295, 1111, 1112, 1117, 2000, 5000, 10000, 19235, 123456]) {
      expect(siteFn(cents, SHIFT_PLATFORM_FEE_RATE, Math.round(SHIFT_PLATFORM_FEE_MIN_DOLLARS * 100))).toBe(serviceFeeCentsFor(cents));
    }
  });
});
