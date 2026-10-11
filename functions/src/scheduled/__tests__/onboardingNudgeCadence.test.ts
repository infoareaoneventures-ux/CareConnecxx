import { describe, it, expect } from "vitest";
import { decideNudge, MAX_NUDGES, NUDGE_DAYS, ABANDONED_AFTER_DAYS } from "../onboardingNudgeCadence";

// One cadence for the onboarding reminders (caregiver sweep A8, 2026-10-11):
// three texts per silence at ~2, 5 and 12 days after the last message, never
// two in one day, nothing after 14 idle days, a reply restarts the series.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-11T17:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("decideNudge", () => {
  it("the series is 2, 5, 12 days — three nudges, none after 14 idle days", () => {
    expect(NUDGE_DAYS).toEqual([2, 5, 12]);
    expect(MAX_NUDGES).toBe(3);
    expect(ABANDONED_AFTER_DAYS).toBe(14);
  });

  it("nothing before day 2; the first nudge on/after day 2", () => {
    expect(decideNudge({ lastInboundAt: ago(1.5) }, NOW).due).toBe(0);
    const d = decideNudge({ lastInboundAt: ago(2.5) }, NOW);
    expect(d).toEqual({ due: 1, anchorAt: ago(2.5), countSoFar: 0 });
  });

  it("the second waits for day 5, the third for day 12 — counted against the same anchor", () => {
    const anchor = ago(6);
    expect(decideNudge({ lastInboundAt: anchor, nudgeAnchorAt: anchor, nudgeCount: 1, nudgeSentAt: ago(3) }, NOW).due).toBe(2);
    expect(decideNudge({ lastInboundAt: ago(4), nudgeAnchorAt: ago(4), nudgeCount: 1, nudgeSentAt: ago(2) }, NOW).due).toBe(0);
    expect(decideNudge({ lastInboundAt: ago(13), nudgeAnchorAt: ago(13), nudgeCount: 2, nudgeSentAt: ago(8) }, NOW).due).toBe(3);
    expect(decideNudge({ lastInboundAt: ago(10), nudgeAnchorAt: ago(10), nudgeCount: 2, nudgeSentAt: ago(5) }, NOW).due).toBe(0);
  });

  it("never two in one day, never a fourth, never after 14 idle days", () => {
    expect(decideNudge({ lastInboundAt: ago(6), nudgeAnchorAt: ago(6), nudgeCount: 1, nudgeSentAt: ago(0.4) }, NOW).due).toBe(0);
    expect(decideNudge({ lastInboundAt: ago(13), nudgeAnchorAt: ago(13), nudgeCount: 3, nudgeSentAt: ago(1) }, NOW).due).toBe(0);
    expect(decideNudge({ lastInboundAt: ago(20) }, NOW).due).toBe(0);
  });

  it("a reply after the nudges restarts the series from that reply", () => {
    const d = decideNudge({ lastInboundAt: ago(3), nudgeAnchorAt: ago(30), nudgeCount: 3, nudgeSentAt: ago(18) }, NOW);
    expect(d).toEqual({ due: 1, anchorAt: ago(3), countSoFar: 0 });
  });

  it("a session that never texted (web bridge) counts from its creation; legacy counts without an anchor start fresh", () => {
    expect(decideNudge({ createdAt: ago(2.1) }, NOW)).toEqual({ due: 1, anchorAt: ago(2.1), countSoFar: 0 });
    // Pre-2026-10-11 sessions carry nudgeCount but no nudgeAnchorAt.
    expect(decideNudge({ createdAt: ago(3), nudgeCount: 2, nudgeSentAt: ago(1.5) }, NOW).due).toBe(1);
    expect(decideNudge({}, NOW)).toEqual({ due: 0, anchorAt: null, countSoFar: 0 });
  });
});
