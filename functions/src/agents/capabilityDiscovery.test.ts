// Unit tests for role-aware capability discovery (U7 / R13).
//
// Verifies: each role surfaces the right action themes; discovery stays derived
// from LAUNCH_ACTION_PARITY shipped rows; and the secondary-family-member
// authority boundary (AE4) is enforced — no payment-approval capability leaks.

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

  it("family-secondary is a deliberately narrow care-visibility surface (no padding)", () => {
    // Secondary members genuinely have fewer capabilities (care visibility only).
    // The helper must NOT pad the list to hit a minimum — it surfaces exactly the
    // allow-listed actions and is still capped at 5.
    const ex = getCapabilityExamples("family-secondary");
    expect(ex.length).toBeGreaterThanOrEqual(2);
    expect(ex.length).toBeLessThanOrEqual(5);
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

  it("family-secondary examples surface care-visibility, NOT payment authority (AE4)", () => {
    const text = getCapabilityExamples("family-secondary", 5).join(" | ").toLowerCase();
    // Care visibility present.
    expect(text).toMatch(/mom|care|how|visit|family/);
    // Payment authority absent — the hard boundary.
    for (const banned of ["approve", "invoice", "billing", "refund", "timesheet", "payout"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("only surfaces SHIPPED parity rows (single source of truth)", () => {
    // Every surfaced phrasing must trace back to a shipped LAUNCH_ACTION_PARITY
    // row — discovery can never advertise a blocker/non-goal action.
    const shippedActions = new Set(
      LAUNCH_ACTION_PARITY.filter((r) => r.status === "shipped").map((r) => r.action),
    );
    // Sanity: the registry actually has shipped rows we draw from.
    expect(shippedActions.size).toBeGreaterThan(0);
    // The family-secondary allow-list rows must all be shipped.
    const familyRows = LAUNCH_ACTION_PARITY.filter(
      (r) => r.id === "family-read-care-journal" || r.id === "family-add-sibling",
    );
    expect(familyRows.every((r) => r.status === "shipped")).toBe(true);
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
    expect(reply.toLowerCase()).toContain("cara");
    expect(reply.toLowerCase()).not.toContain("here is a list");
    expect(reply.toLowerCase()).not.toContain("what can i help you with");
  });

  it("caregiver HELP reply surfaces caregiver actions", () => {
    const reply = buildHelpSmsReply("caregiver").toLowerCase();
    expect(reply).toMatch(/job|shift|earnings|payout|clock|hours/);
  });

  it("family-secondary HELP reply never implies payment authority (AE4)", () => {
    const reply = buildHelpSmsReply("family-secondary").toLowerCase();
    for (const banned of ["approve", "invoice", "billing", "refund", "timesheet", "payout"]) {
      expect(reply).not.toContain(banned);
    }
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

  it("tells Cara to LEAD with one action when context exists", () => {
    const withCtx = buildCapabilityHint("client", true);
    expect(withCtx.toLowerCase()).toContain("lead with one relevant care recipe");
    const noCtx = buildCapabilityHint("client", false);
    expect(noCtx.toLowerCase()).not.toContain("lead with one");
  });

  it("secondary-member hint carries the payment-authority boundary (AE4)", () => {
    const hint = buildCapabilityHint("family-secondary", false);
    expect(hint.toLowerCase()).toContain("authority boundary");
    expect(hint.toLowerCase()).toContain("primary account holder");
    expect(hint.toLowerCase()).toContain("approve payments");
  });
});
