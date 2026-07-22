import { describe, expect, it } from "vitest";

import { decideForRecipient, type PolicyCandidate, type RecipientState } from "./proactiveDecisionEngine";

const now = new Date("2026-07-22T18:00:00Z");
const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
const candidate = (over: Partial<PolicyCandidate>): PolicyCandidate => ({
  source: "test",
  category: "warmth",
  urgency: 0,
  evidenceCount: 0,
  dedupeKey: `k-${Math.random().toString(36).slice(2, 8)}`,
  createdAt: now.toISOString(),
  expiresAt: future,
  ...over,
});
const state = (over: Partial<RecipientState> = {}): RecipientState => ({
  optionalSendsToday: 0, inDnd: false, ...over,
});

describe("decideForRecipient (U8/R40-R44/AE13)", () => {
  it("at most one send per pass; losers get explicit dispositions with re-entry (AE13)", () => {
    const decisions = decideForRecipient([
      candidate({ category: "visit_risk", urgency: 3, dedupeKey: "a" }),
      candidate({ category: "warmth", dedupeKey: "b" }),
      candidate({ category: "re_engagement", dedupeKey: "c" }),
    ], state(), now);

    const sends = decisions.filter((d) => d.disposition === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].candidate.category).toBe("visit_risk");
    const deferred = decisions.filter((d) => d.disposition === "deferred");
    expect(deferred).toHaveLength(2);
    for (const d of deferred) expect(d.nextEligibleAt).toBeDefined();
  });

  it("health patterns win but stay review-first (R42), and are suppressed without evidence", () => {
    const withEvidence = decideForRecipient([
      candidate({ category: "health_pattern", urgency: 2, evidenceCount: 3, dedupeKey: "h" }),
      candidate({ category: "warmth", dedupeKey: "w" }),
    ], state(), now);
    expect(withEvidence.find((d) => d.candidate.dedupeKey === "h")!.disposition).toBe("review_first");

    const withoutEvidence = decideForRecipient([
      candidate({ category: "health_pattern", urgency: 2, evidenceCount: 0, dedupeKey: "h2" }),
    ], state(), now);
    expect(withoutEvidence[0].disposition).toBe("suppressed");
    expect(withoutEvidence[0].reason).toBe("no_deterministic_evidence");
  });

  it("DND and daily budget defer everything (never silently drop)", () => {
    for (const s of [state({ inDnd: true }), state({ optionalSendsToday: 1 })]) {
      const decisions = decideForRecipient([candidate({ urgency: 3, dedupeKey: "x" })], s, now);
      expect(decisions[0].disposition).toBe("deferred");
      expect(decisions[0].nextEligibleAt).toBeDefined();
    }
  });

  it("muted categories are suppressed; duplicates collapse; expired are marked", () => {
    const decisions = decideForRecipient([
      candidate({ category: "warmth", dedupeKey: "same" }),
      candidate({ category: "warmth", dedupeKey: "same" }),
      candidate({ category: "satisfaction", dedupeKey: "m" }),
      candidate({ dedupeKey: "e", expiresAt: new Date(now.getTime() - 1000).toISOString() }),
    ], state({ mutedCategories: ["satisfaction"] }), now);

    expect(decisions.filter((d) => d.disposition === "suppressed" && d.reason === "duplicate_intent")).toHaveLength(1);
    expect(decisions.find((d) => d.candidate.dedupeKey === "m")!.disposition).toBe("suppressed");
    expect(decisions.find((d) => d.candidate.dedupeKey === "e")!.disposition).toBe("expired");
    expect(decisions.filter((d) => d.disposition === "send")).toHaveLength(1);
  });

  it("is deterministic regardless of input order", () => {
    const cands = [
      candidate({ category: "billing_heads_up", urgency: 1, dedupeKey: "b" }),
      candidate({ category: "visit_risk", urgency: 1, dedupeKey: "v" }),
    ];
    const a = decideForRecipient(cands, state(), now).find((d) => d.disposition === "send")!;
    const b = decideForRecipient([...cands].reverse(), state(), now).find((d) => d.disposition === "send")!;
    expect(a.candidate.dedupeKey).toBe("v");
    expect(b.candidate.dedupeKey).toBe("v");
  });
});
