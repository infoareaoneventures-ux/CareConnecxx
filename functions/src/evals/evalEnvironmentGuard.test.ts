import { describe, expect, it } from "vitest";

import {
  checkEvalEnvironment,
  assertSafeEvalEnvironment,
  PRODUCTION_PROJECT_ID,
} from "./evalEnvironmentGuard";

const sandboxEnv = { GCLOUD_PROJECT: "careconnex-eval-sandbox" } as NodeJS.ProcessEnv;

describe("evalEnvironmentGuard (U0/AE22 — refusal is mandatory, no bypass)", () => {
  it("passes a provable sandbox project", () => {
    const r = checkEvalEnvironment(sandboxEnv);
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe("careconnex-eval-sandbox");
    expect(() => assertSafeEvalEnvironment(sandboxEnv)).not.toThrow();
  });

  it("refuses the production project id from every resolution path", () => {
    for (const env of [
      { GCLOUD_PROJECT: PRODUCTION_PROJECT_ID },
      { GOOGLE_CLOUD_PROJECT: PRODUCTION_PROJECT_ID },
      { FIREBASE_PROJECT_ID: PRODUCTION_PROJECT_ID },
      { FIREBASE_CONFIG: JSON.stringify({ projectId: PRODUCTION_PROJECT_ID }) },
    ] as NodeJS.ProcessEnv[]) {
      const r = checkEvalEnvironment(env);
      expect(r.ok).toBe(false);
      expect(() => assertSafeEvalEnvironment(env)).toThrow(/PRODUCTION|refused/i);
    }
  });

  it("refuses when no project id is present — unprovable identity fails closed", () => {
    const r = checkEvalEnvironment({} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/cannot be proven/);
  });

  it("refuses live-mode Stripe credentials even in a sandbox project", () => {
    const r = checkEvalEnvironment({ ...sandboxEnv, STRIPE_SECRET_KEY: "sk_live_abc123" });
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/LIVE-mode Stripe/);
    expect(checkEvalEnvironment({ ...sandboxEnv, STRIPE_SECRET_KEY: "sk_test_abc123" }).ok).toBe(true);
  });

  it("refuses a production database URL", () => {
    const r = checkEvalEnvironment({
      ...sandboxEnv,
      FIREBASE_DATABASE_URL: `https://${PRODUCTION_PROJECT_ID}.firebaseio.com`,
    });
    expect(r.ok).toBe(false);
  });

  it("exposes no bypass: assert takes only an env and throws on violation", () => {
    // Signature-level check — the function accepts nothing that could disable it.
    expect(assertSafeEvalEnvironment.length).toBeLessThanOrEqual(1);
    expect(() => assertSafeEvalEnvironment({ GCLOUD_PROJECT: PRODUCTION_PROJECT_ID } as NodeJS.ProcessEnv))
      .toThrow(/no bypass exists/);
  });
});
