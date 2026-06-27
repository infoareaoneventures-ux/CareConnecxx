import { describe, it, expect } from "vitest";
import {
  runOnboardingDryRun,
  isOnboardingDryRun,
  recordSideEffect,
  guardSideEffect,
} from "./onboardingDryRun";

// U10: the isolation primitive. These prove the contract every guarded
// side-effect site in onboardingConversation.ts relies on:
//   - inside a dry-run, `guardSideEffect` NEVER invokes the real effect, returns
//     the placeholder, and records the attempt;
//   - outside a dry-run, it runs the real effect and records nothing;
//   - the context survives awaits (AsyncLocalStorage), so a guard deep in an
//     async call chain still sees the dry-run.
describe("onboardingDryRun (U10)", () => {
  it("reports not-in-dry-run outside a dry-run scope", () => {
    expect(isOnboardingDryRun()).toBe(false);
  });

  it("suppresses the real effect and records it inside a dry-run", async () => {
    let realRan = false;
    const { result, recorded } = await runOnboardingDryRun(async () => {
      expect(isOnboardingDryRun()).toBe(true);
      const v = await guardSideEffect(
        "stripe.checkout.sessions.create",
        async () => { realRan = true; return { id: "REAL" }; },
        { id: "cs_dryrun" },
        { who: "client" },
      );
      return v.id;
    });
    expect(realRan).toBe(false);            // real Stripe call never happened
    expect(result).toBe("cs_dryrun");       // caller got the placeholder
    expect(recorded).toEqual([{ kind: "stripe.checkout.sessions.create", detail: { who: "client" } }]);
  });

  it("runs the real effect and records nothing outside a dry-run", async () => {
    let realRan = false;
    const v = await guardSideEffect(
      "auth.createUser",
      async () => { realRan = true; return { uid: "real-uid" }; },
      { uid: "dryrun-uid" },
    );
    expect(realRan).toBe(true);
    expect(v.uid).toBe("real-uid");
  });

  it("preserves the dry-run context across nested awaits", async () => {
    const { recorded } = await runOnboardingDryRun(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      // deep async chain still sees the dry-run
      async function deep() { recordSideEffect("firestore.update:agent_sessions", { phone: "x" }); }
      await deep();
    });
    expect(recorded).toEqual([{ kind: "firestore.update:agent_sessions", detail: { phone: "x" } }]);
  });

  it("collects multiple recorded effects in order", async () => {
    const { recorded } = await runOnboardingDryRun(async () => {
      await guardSideEffect("checkr.invitation.create", async () => 1, 0);
      await guardSideEffect("stripe.accounts.create", async () => 1, 0);
    });
    expect(recorded.map((r) => r.kind)).toEqual(["checkr.invitation.create", "stripe.accounts.create"]);
  });
});
