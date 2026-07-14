import { describe, it, expect } from "vitest";
import {
  decideInShiftPrompt,
  decideHeartbeat,
  pickRotatingQuestion,
  timeOfDayFromMinutes,
  LADDER_FIRST_DELAY_MIN,
  LADDER_INTERVAL_MIN,
  END_SUPPRESSION_MIN,
  MAX_FAMILY_UPDATES_PER_SHIFT,
  HEARTBEAT_AFTER_MIN,
} from "../inShiftUpdatePolicy";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

// Base: a 4h shift that arrived 90 min ago, no prompt yet, room under the ceiling.
function basePrompt(over: Partial<Parameters<typeof decideInShiftPrompt>[0]> = {}) {
  return {
    anchorMs:          NOW - 90 * MIN,
    scheduledEndMs:    NOW + 150 * MIN,
    durationHours:     4,
    lastPromptAtMs:    null,
    familyUpdateCount: 0,
    awaitingReply:     false,
    cadenceMinutes:    LADDER_INTERVAL_MIN,
    cadenceOverridden: false,
    nowMs:             NOW,
    ...over,
  };
}

describe("decideInShiftPrompt", () => {
  it("prompts once past the first-delay with no prior prompt", () => {
    expect(decideInShiftPrompt(basePrompt()).action).toBe("prompt");
  });

  it("skips before the first-delay elapses", () => {
    const d = decideInShiftPrompt(basePrompt({ anchorMs: NOW - (LADDER_FIRST_DELAY_MIN - 5) * MIN }));
    expect(d).toEqual({ action: "skip", reason: "too_early" });
  });

  it("skips shifts at or under the short-shift threshold", () => {
    const d = decideInShiftPrompt(basePrompt({ durationHours: 1.5 }));
    expect(d).toEqual({ action: "skip", reason: "shift_too_short" });
  });

  it("keeps prompting shifts just over the short-shift threshold", () => {
    const d = decideInShiftPrompt(basePrompt({ durationHours: 2 }));
    expect(d.action).toBe("prompt");
  });

  it("respects the cadence between prompts", () => {
    const d = decideInShiftPrompt(basePrompt({
      lastPromptAtMs: NOW - (LADDER_INTERVAL_MIN - 10) * MIN,
    }));
    expect(d).toEqual({ action: "skip", reason: "cadence" });
  });

  it("prompts again once the cadence has elapsed", () => {
    const d = decideInShiftPrompt(basePrompt({
      lastPromptAtMs: NOW - (LADDER_INTERVAL_MIN + 1) * MIN,
    }));
    expect(d.action).toBe("prompt");
  });

  it("honors a shorter family cadence override", () => {
    const d = decideInShiftPrompt(basePrompt({
      cadenceMinutes: 60,
      cadenceOverridden: true,
      lastPromptAtMs: NOW - 61 * MIN,
    }));
    expect(d.action).toBe("prompt");
  });

  it("an explicit slow cadence also delays the FIRST prompt", () => {
    // "every 8 hours please" on a long shift: 90 min in must NOT prompt.
    const d = decideInShiftPrompt(basePrompt({
      durationHours: 10,
      scheduledEndMs: NOW + 510 * MIN,
      cadenceMinutes: 480,
      cadenceOverridden: true,
    }));
    expect(d).toEqual({ action: "skip", reason: "too_early" });
  });

  it("an explicit fast cadence accelerates the FIRST prompt", () => {
    const d = decideInShiftPrompt(basePrompt({
      anchorMs: NOW - 46 * MIN, // before the default 60-min first delay
      cadenceMinutes: 45,
      cadenceOverridden: true,
    }));
    expect(d.action).toBe("prompt");
  });

  it("suppresses prompts within the end-of-shift window", () => {
    const d = decideInShiftPrompt(basePrompt({
      scheduledEndMs: NOW + (END_SUPPRESSION_MIN - 5) * MIN,
    }));
    expect(d).toEqual({ action: "skip", reason: "near_end" });
  });

  it("stops at the per-shift ceiling", () => {
    const d = decideInShiftPrompt(basePrompt({ familyUpdateCount: MAX_FAMILY_UPDATES_PER_SHIFT }));
    expect(d).toEqual({ action: "skip", reason: "ceiling_reached" });
  });

  it("does not double-ask while a prompt is unanswered", () => {
    const d = decideInShiftPrompt(basePrompt({ awaitingReply: true }));
    expect(d).toEqual({ action: "skip", reason: "awaiting_reply" });
  });

  it("skips when there is no arrival anchor", () => {
    const d = decideInShiftPrompt(basePrompt({ anchorMs: null }));
    expect(d).toEqual({ action: "skip", reason: "no_anchor" });
  });
});

describe("decideHeartbeat", () => {
  it("sends a heartbeat when a prompt goes unanswered past the wait window", () => {
    const d = decideHeartbeat({
      awaitingReply: true,
      promptSentAtMs: NOW - (HEARTBEAT_AFTER_MIN + 1) * MIN,
      familyUpdateCount: 0,
      nowMs: NOW,
    });
    expect(d.action).toBe("heartbeat");
  });

  it("keeps waiting inside the wait window", () => {
    const d = decideHeartbeat({
      awaitingReply: true,
      promptSentAtMs: NOW - (HEARTBEAT_AFTER_MIN - 1) * MIN,
      familyUpdateCount: 0,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "skip", reason: "still_waiting" });
  });

  it("does nothing when no prompt is outstanding", () => {
    const d = decideHeartbeat({ awaitingReply: false, promptSentAtMs: null, familyUpdateCount: 0, nowMs: NOW });
    expect(d).toEqual({ action: "skip", reason: "not_awaiting" });
  });

  it("does not exceed the per-shift ceiling with heartbeats", () => {
    const d = decideHeartbeat({
      awaitingReply: true,
      promptSentAtMs: NOW - (HEARTBEAT_AFTER_MIN + 5) * MIN,
      familyUpdateCount: MAX_FAMILY_UPDATES_PER_SHIFT,
      nowMs: NOW,
    });
    expect(d).toEqual({ action: "skip", reason: "ceiling_reached" });
  });
});

describe("timeOfDayFromMinutes", () => {
  it("buckets by wall-clock minutes", () => {
    expect(timeOfDayFromMinutes(9 * 60)).toBe("morning");
    expect(timeOfDayFromMinutes(13 * 60)).toBe("midday");
    expect(timeOfDayFromMinutes(15 * 60)).toBe("afternoon");
    expect(timeOfDayFromMinutes(19 * 60)).toBe("evening");
  });
});

describe("pickRotatingQuestion", () => {
  it("asks a time-appropriate question on the first slot", () => {
    const q = pickRotatingQuestion({
      seniorFirstName: "Dorothy", slotIndex: 0, timeOfDay: "midday",
      hasMeds: false, medsPromptedAlready: false,
    });
    expect(q.topic).toBe("meal");
    expect(q.text).toContain("Dorothy");
  });

  it("works a medication question in when the plan has meds and it hasn't been asked", () => {
    const q = pickRotatingQuestion({
      seniorFirstName: "Dorothy", slotIndex: 1, timeOfDay: "afternoon",
      hasMeds: true, medsPromptedAlready: false,
    });
    expect(q.topic).toBe("medication");
  });

  it("does not repeat the medication question once asked", () => {
    const q = pickRotatingQuestion({
      seniorFirstName: "Dorothy", slotIndex: 1, timeOfDay: "afternoon",
      hasMeds: true, medsPromptedAlready: true,
    });
    expect(q.topic).not.toBe("medication");
  });

  it("falls back to a generic subject when no name is known", () => {
    const q = pickRotatingQuestion({
      seniorFirstName: "", slotIndex: 0, timeOfDay: "morning",
      hasMeds: false, medsPromptedAlready: false,
    });
    expect(q.text).toContain("your client");
  });
});
