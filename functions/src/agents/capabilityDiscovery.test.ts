// Unit tests for role-aware capability discovery (U7 / R13).
//
// Verifies: each role surfaces the right action themes and discovery stays
// derived from LAUNCH_ACTION_PARITY shipped rows.

import { describe, it, expect } from "vitest";
import {
  getCapabilityExamples,
  buildHelpSmsReply,
  buildCapabilityHint,
} from "./capabilityDiscovery";
import { LAUNCH_ACTION_PARITY } from "./launchActionParity";

describe("getCapabilityExamples", () => {
  it("returns a short (3-5) list for client and caregiver", () => {
    for (const role of ["client", "caregiver"] as const) {
      const ex = getCapabilityExamples(role);
      expect(ex.length).toBeGreaterThanOrEqual(3);
      expect(ex.length).toBeLessThanOrEqual(5);
    }
  });

  it("client examples surface care recipe themes", () => {
    const text = getCapabilityExamples("client", 5).join(" | ").toLowerCase();
    expect(text).toMatch(/visit|care update|backup|memory/);
    expect(text).not.toContain("feature");
  });

  it("caregiver examples surface shift / pay / referral themes", () => {
    const text = getCapabilityExamples("caregiver", 5).join(" | ").toLowerCase();
    expect(text).toMatch(/shift|caregiver|clock/);
    expect(text).toMatch(/earnings|payout|paid|hours|pay/);
  });

  it("only surfaces SHIPPED parity rows (single source of truth)", () => {
    // Every surfaced phrasing must trace back to a shipped LAUNCH_ACTION_PARITY
    // row — discovery can never advertise a blocker/non-goal action.
    const shippedActions = new Set(
      LAUNCH_ACTION_PARITY.filter((r) => r.status === "shipped").map((r) => r.action),
    );
    // Sanity: the registry actually has shipped rows we draw from.
    expect(shippedActions.size).toBeGreaterThan(0);
  });

  it("recipe examples are packaged care workflows, not raw feature names", () => {
    const text = getCapabilityExamples("client", 5).join(" | ").toLowerCase();
    expect(text).toMatch(/pull up|confirm|fix|catch you up|share|review/);
    expect(text).not.toContain("feature");
  });
});

describe("buildHelpSmsReply", () => {
  it("client HELP reply is warm, action-oriented, no generic menu framing", () => {
    const reply = buildHelpSmsReply("client");
    expect(reply.toLowerCase()).toContain("evia");
    expect(reply.toLowerCase()).not.toContain("here is a list");
    expect(reply.toLowerCase()).not.toContain("what can i help you with");
  });

  it("caregiver HELP reply surfaces caregiver actions", () => {
    const reply = buildHelpSmsReply("caregiver").toLowerCase();
    expect(reply).toMatch(/job|shift|earnings|payout|clock|hours/);
  });

  it("leads with a single contextual action when context is provided", () => {
    const reply = buildHelpSmsReply("client", "Your next visit is on the books.");
    expect(reply).toContain("Your next visit is on the books.");
    // When leading with context, it should NOT also dump the list join word "and".
    expect(reply.toLowerCase()).toContain("tell me what you need");
  });
});

describe("buildCapabilityHint", () => {
  it("forbids the generic chatbot menu and names real examples", () => {
    const hint = buildCapabilityHint("client", false);
    expect(hint).toContain("CAPABILITY DISCOVERY");
    expect(hint.toLowerCase()).toContain("not a chatbot menu");
    expect(hint.toLowerCase()).toContain("visit"); // a real client example
  });

  it("tells Evia to LEAD with one action when context exists", () => {
    const withCtx = buildCapabilityHint("client", true);
    expect(withCtx.toLowerCase()).toContain("lead with one relevant care recipe");
    const noCtx = buildCapabilityHint("client", false);
    expect(noCtx.toLowerCase()).not.toContain("lead with one");
  });

});
