// U1 — MVR configuration validation.
//
// Guards the two silent-failure modes the MVR feature must forbid:
//   - charged/offered but no check (STRIPE_MVR_PRICE_ID unset or placeholder)
//   - check runs with no real MVR package (CHECKR_PACKAGE_MVR* unset or == base)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertMvrPaymentConfig,
  isMvrPaymentConfigured,
  assertMvrCheckConfig,
  isMvrCheckConfigured,
  canChargeBundledMvr,
  basePackage,
} from "../mvrConfig";

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.STRIPE_MVR_PRICE_ID;
  delete process.env.CHECKR_PACKAGE;
  delete process.env.CHECKR_PACKAGE_MVR;
  delete process.env.CHECKR_PACKAGE_MVR_ONLY;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("MVR payment config", () => {
  it("resolves the price id when set", () => {
    process.env.STRIPE_MVR_PRICE_ID = "price_mvr_123";
    expect(isMvrPaymentConfigured()).toBe(true);
    expect(assertMvrPaymentConfig()).toBe("price_mvr_123");
  });

  it("treats an unset price id as not configured and throws on assert", () => {
    expect(isMvrPaymentConfigured()).toBe(false);
    expect(() => assertMvrPaymentConfig()).toThrow(/STRIPE_MVR_PRICE_ID/);
  });

  it("treats a FILL_IN placeholder as not configured", () => {
    process.env.STRIPE_MVR_PRICE_ID = "FILL_IN_price";
    expect(isMvrPaymentConfigured()).toBe(false);
    expect(() => assertMvrPaymentConfig()).toThrow();
  });

  it("ignores surrounding whitespace", () => {
    process.env.STRIPE_MVR_PRICE_ID = "  price_mvr_123  ";
    expect(assertMvrPaymentConfig()).toBe("price_mvr_123");
  });
});

describe("MVR check (Checkr package) config", () => {
  it("resolves an mvr_only package distinct from the base", () => {
    process.env.CHECKR_PACKAGE = "criminal_basic";
    process.env.CHECKR_PACKAGE_MVR_ONLY = "mvr_only_pkg";
    expect(assertMvrCheckConfig("mvr_only")).toBe("mvr_only_pkg");
  });

  it("resolves a bundled package distinct from the base", () => {
    process.env.CHECKR_PACKAGE = "criminal_basic";
    process.env.CHECKR_PACKAGE_MVR = "criminal_plus_mvr";
    expect(assertMvrCheckConfig("bundled")).toBe("criminal_plus_mvr");
  });

  it("throws when the mvr_only package is unset", () => {
    process.env.CHECKR_PACKAGE = "criminal_basic";
    expect(() => assertMvrCheckConfig("mvr_only")).toThrow(/CHECKR_PACKAGE_MVR_ONLY is unset/);
  });

  it("throws when the MVR package equals the base package (the charged-but-no-MVR mode)", () => {
    process.env.CHECKR_PACKAGE = "driver_pro";
    process.env.CHECKR_PACKAGE_MVR_ONLY = "driver_pro";
    expect(() => assertMvrCheckConfig("mvr_only")).toThrow(/must differ from CHECKR_PACKAGE/);
  });

  it("throws when the bundled package equals the defaulted base package", () => {
    // CHECKR_PACKAGE unset → basePackage() falls back to "driver_pro"
    expect(basePackage()).toBe("driver_pro");
    process.env.CHECKR_PACKAGE_MVR = "driver_pro";
    expect(() => assertMvrCheckConfig("bundled")).toThrow(/must differ from CHECKR_PACKAGE/);
  });
});

describe("canChargeBundledMvr — the signup MVR charge gate (U8)", () => {
  it("is true only when both the price and a distinct bundled package are configured", () => {
    process.env.STRIPE_MVR_PRICE_ID = "price_mvr";
    process.env.CHECKR_PACKAGE = "criminal_basic";
    process.env.CHECKR_PACKAGE_MVR = "criminal_plus_mvr";
    expect(canChargeBundledMvr()).toBe(true);
    expect(isMvrCheckConfigured("bundled")).toBe(true);
  });

  it("is false when the price is missing (would charge nothing) — prevents includeMVR without charge", () => {
    process.env.CHECKR_PACKAGE = "criminal_basic";
    process.env.CHECKR_PACKAGE_MVR = "criminal_plus_mvr";
    // STRIPE_MVR_PRICE_ID unset
    expect(canChargeBundledMvr()).toBe(false);
  });

  it("is false when the bundled package is missing (would run a non-MVR check) even if price is set", () => {
    process.env.STRIPE_MVR_PRICE_ID = "price_mvr";
    process.env.CHECKR_PACKAGE = "criminal_basic";
    // CHECKR_PACKAGE_MVR unset
    expect(canChargeBundledMvr()).toBe(false);
  });
});
