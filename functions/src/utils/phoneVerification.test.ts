import { describe, it, expect } from "vitest";
import { generateOtp, verifyOtp, formatOtpForDisplay } from "./phoneVerification";

describe("phoneVerification", () => {
  describe("generateOtp", () => {
    it("produces a 6-digit zero-padded code", () => {
      for (let i = 0; i < 50; i++) {
        const state = generateOtp();
        expect(state.code).toMatch(/^\d{6}$/);
      }
    });

    it("sets expiresAt ~15min in the future", () => {
      const before = Date.now();
      const state = generateOtp();
      const expiresMs = new Date(state.expiresAt).getTime();
      // 15min ± 1s window for clock drift
      expect(expiresMs - before).toBeGreaterThan(14 * 60 * 1000);
      expect(expiresMs - before).toBeLessThan(16 * 60 * 1000);
    });

    it("starts with zero attempts", () => {
      expect(generateOtp().attempts).toBe(0);
    });
  });

  describe("verifyOtp", () => {
    it("returns ok on exact match", () => {
      const state = generateOtp();
      expect(verifyOtp(state.code, state)).toEqual({ status: "ok" });
    });

    it("accepts formatted code with dashes", () => {
      const state = generateOtp();
      const formatted = `${state.code.slice(0, 3)}-${state.code.slice(3)}`;
      expect(verifyOtp(formatted, state)).toEqual({ status: "ok" });
    });

    it("rejects wrong code and reports attempts left", () => {
      const state = generateOtp();
      // Get a code that's definitely different
      const wrong = state.code === "000000" ? "111111" : "000000";
      const result = verifyOtp(wrong, state);
      expect(result.status).toBe("wrong");
      if (result.status === "wrong") {
        expect(result.attemptsLeft).toBe(4);
      }
    });

    it("rejects when no state present", () => {
      expect(verifyOtp("123456", undefined)).toEqual({ status: "no_state" });
    });

    it("rejects expired codes", () => {
      const state = generateOtp();
      state.expiresAt = new Date(Date.now() - 1000).toISOString();
      expect(verifyOtp(state.code, state)).toEqual({ status: "expired" });
    });

    it("locks after 5 failed attempts", () => {
      const state = generateOtp();
      state.attempts = 5;
      expect(verifyOtp(state.code, state)).toEqual({ status: "locked" });
    });

    it("strips non-digits before comparing", () => {
      const state = generateOtp();
      const messy = state.code.split("").join(" ");
      expect(verifyOtp(messy, state)).toEqual({ status: "ok" });
    });

    it("rejects input shorter than 6 digits as wrong", () => {
      const state = generateOtp();
      const short = state.code.slice(0, 5);
      const result = verifyOtp(short, state);
      expect(result.status).toBe("wrong");
    });
  });

  describe("formatOtpForDisplay", () => {
    it("inserts a dash for 6-digit codes", () => {
      expect(formatOtpForDisplay("845290")).toBe("845-290");
    });

    it("leaves non-6-digit codes untouched", () => {
      expect(formatOtpForDisplay("845")).toBe("845");
    });
  });
});
