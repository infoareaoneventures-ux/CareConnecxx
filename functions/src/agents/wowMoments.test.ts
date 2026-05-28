import { describe, it, expect } from "vitest";

import {
  WOW_MOMENTS,
  findEligibleWowMoments,
  pickWowCandidate,
  renderWowCandidate,
  type WowContext,
  type WowMoment,
  type FireRecord,
} from "./wowMoments";

const baseCtx = (overrides: Partial<WowContext> = {}): WowContext => ({
  clientName:        "Alice",
  seniorName:        "Mom",
  recentEvents:      [],
  completedVisits:   0,
  recentCaregiverIds: [],
  billingCleanDays:  0,
  now:               new Date("2026-05-28T12:00:00Z"),
  ...overrides,
});

const moment = (name: string): WowMoment => {
  const m = WOW_MOMENTS.find(x => x.name === name);
  if (!m) throw new Error(`no wow-moment named ${name}`);
  return m;
};

describe("WOW_MOMENTS registry", () => {
  it("has unique names", () => {
    const names = WOW_MOMENTS.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every moment has a description and a buildMessage that returns non-empty", () => {
    for (const m of WOW_MOMENTS) {
      expect(m.description.length).toBeGreaterThan(10);
      const sample = m.buildMessage(baseCtx({ completedVisits: 10, firstVisitAt: "2024-05-28T00:00:00Z" }));
      expect(typeof sample).toBe("string");
      expect(sample.trim().length).toBeGreaterThan(0);
    }
  });

  it("every buildMessage stays under 280 chars (SMS-shaped)", () => {
    for (const m of WOW_MOMENTS) {
      const sample = m.buildMessage(baseCtx({
        completedVisits: 250,
        firstVisitAt:    "2020-05-28T00:00:00Z",
        seniorName:      "Mom",
      }));
      expect(sample.length).toBeLessThanOrEqual(280);
    }
  });
});

describe("first_booking_confirmed", () => {
  const m = moment("first_booking_confirmed");

  it("fires when exactly one booking_confirmed happened in the last 48h", () => {
    expect(m.predicate(baseCtx({
      recentEvents: [{ type: "booking_confirmed", timestamp: "2026-05-27T12:00:00Z" }],
    }))).toBe(true);
  });

  it("does NOT fire when there have been multiple confirms (not first anymore)", () => {
    expect(m.predicate(baseCtx({
      recentEvents: [
        { type: "booking_confirmed", timestamp: "2026-05-27T12:00:00Z" },
        { type: "booking_confirmed", timestamp: "2026-05-20T12:00:00Z" },
      ],
    }))).toBe(false);
  });

  it("does NOT fire when the lone confirm is more than 48h old", () => {
    expect(m.predicate(baseCtx({
      recentEvents: [{ type: "booking_confirmed", timestamp: "2026-05-20T12:00:00Z" }],
    }))).toBe(false);
  });
});

describe("care_anniversary", () => {
  const m = moment("care_anniversary");

  it("fires in the first week of the anniversary month, 1+ year later", () => {
    expect(m.predicate(baseCtx({
      firstVisitAt: "2024-05-03T00:00:00Z",
      now:          new Date("2026-05-05T12:00:00Z"),
    }))).toBe(true);
  });

  it("does NOT fire in the wrong month", () => {
    expect(m.predicate(baseCtx({
      firstVisitAt: "2024-05-03T00:00:00Z",
      now:          new Date("2026-06-05T12:00:00Z"),
    }))).toBe(false);
  });

  it("does NOT fire after the first week of the month", () => {
    expect(m.predicate(baseCtx({
      firstVisitAt: "2024-05-03T00:00:00Z",
      now:          new Date("2026-05-20T12:00:00Z"),
    }))).toBe(false);
  });

  it("does NOT fire in the same calendar year as the first visit", () => {
    expect(m.predicate(baseCtx({
      firstVisitAt: "2026-05-03T00:00:00Z",
      now:          new Date("2026-05-05T12:00:00Z"),
    }))).toBe(false);
  });

  it("pluralizes years correctly", () => {
    const msg1 = m.buildMessage(baseCtx({
      firstVisitAt: "2025-05-03T00:00:00Z",
      now:          new Date("2026-05-05T12:00:00Z"),
    }));
    expect(msg1).toMatch(/1 year /);

    const msg2 = m.buildMessage(baseCtx({
      firstVisitAt: "2023-05-03T00:00:00Z",
      now:          new Date("2026-05-05T12:00:00Z"),
    }));
    expect(msg2).toMatch(/3 years /);
  });
});

describe("visit_milestone", () => {
  const m = moment("visit_milestone");

  it.each([10, 25, 50, 100, 250])("fires at %i visits", (n) => {
    expect(m.predicate(baseCtx({ completedVisits: n }))).toBe(true);
  });

  it("does NOT fire at intermediate counts", () => {
    for (const n of [0, 1, 9, 11, 24, 26, 99, 101, 249, 251]) {
      expect(m.predicate(baseCtx({ completedVisits: n }))).toBe(false);
    }
  });
});

describe("caregiver_streak", () => {
  const m = moment("caregiver_streak");

  it("fires when last 5 caregiver IDs are identical", () => {
    expect(m.predicate(baseCtx({ recentCaregiverIds: ["c1", "c1", "c1", "c1", "c1"] }))).toBe(true);
  });

  it("does NOT fire on a 4-visit streak", () => {
    expect(m.predicate(baseCtx({ recentCaregiverIds: ["c1", "c1", "c1", "c1"] }))).toBe(false);
  });

  it("does NOT fire when one different caregiver is in the run", () => {
    expect(m.predicate(baseCtx({ recentCaregiverIds: ["c1", "c1", "c2", "c1", "c1"] }))).toBe(false);
  });

  it("does NOT fire when the array is empty", () => {
    expect(m.predicate(baseCtx({ recentCaregiverIds: [] }))).toBe(false);
  });
});

describe("smooth_billing_quarter", () => {
  const m = moment("smooth_billing_quarter");

  it("fires at 90+ clean days", () => {
    expect(m.predicate(baseCtx({ billingCleanDays: 90 }))).toBe(true);
    expect(m.predicate(baseCtx({ billingCleanDays: 365 }))).toBe(true);
  });

  it("does NOT fire under 90 days", () => {
    expect(m.predicate(baseCtx({ billingCleanDays: 89 }))).toBe(false);
    expect(m.predicate(baseCtx({ billingCleanDays: 0 }))).toBe(false);
  });
});

describe("findEligibleWowMoments + cooldown", () => {
  it("returns only matching moments", () => {
    const eligible = findEligibleWowMoments(baseCtx({ completedVisits: 25 }));
    expect(eligible.map(m => m.name)).toEqual(["visit_milestone"]);
  });

  it("returns multiple when multiple conditions match", () => {
    const eligible = findEligibleWowMoments(baseCtx({
      completedVisits:    25,
      billingCleanDays:   120,
      recentCaregiverIds: ["c1", "c1", "c1", "c1", "c1"],
    }));
    const names = eligible.map(m => m.name);
    expect(names).toContain("visit_milestone");
    expect(names).toContain("caregiver_streak");
    expect(names).toContain("smooth_billing_quarter");
  });

  it("mutes a moment that fired recently within its cooldown", () => {
    const ctx   = baseCtx({ completedVisits: 25, now: new Date("2026-05-28T12:00:00Z") });
    const fires: FireRecord[] = [{ name: "visit_milestone", firedAt: "2026-05-25T00:00:00Z" }];
    expect(findEligibleWowMoments(ctx, fires).map(m => m.name)).toEqual([]);
  });

  it("unmutes a moment once cooldown has elapsed", () => {
    const ctx   = baseCtx({ completedVisits: 25, now: new Date("2026-05-28T12:00:00Z") });
    const fires: FireRecord[] = [{ name: "visit_milestone", firedAt: "2026-01-01T00:00:00Z" }];
    expect(findEligibleWowMoments(ctx, fires).map(m => m.name)).toEqual(["visit_milestone"]);
  });

  it("ignores fire records for unknown moments (forward-compat for retired ones)", () => {
    const ctx   = baseCtx({ completedVisits: 25 });
    const fires: FireRecord[] = [{ name: "moment_no_longer_in_registry", firedAt: "2026-05-25T00:00:00Z" }];
    expect(findEligibleWowMoments(ctx, fires).map(m => m.name)).toEqual(["visit_milestone"]);
  });

  it("survives a throwing predicate", () => {
    // Mutate registry temporarily — restore in finally so other tests pass.
    const orig = WOW_MOMENTS[0].predicate;
    WOW_MOMENTS[0].predicate = () => { throw new Error("boom"); };
    try {
      expect(() => findEligibleWowMoments(baseCtx())).not.toThrow();
    } finally {
      WOW_MOMENTS[0].predicate = orig;
    }
  });
});

describe("pickWowCandidate", () => {
  it("returns null when nothing matches", () => {
    expect(pickWowCandidate(baseCtx())).toBeNull();
  });

  it("returns the first matching moment rendered", () => {
    const out = pickWowCandidate(baseCtx({ completedVisits: 25 }));
    expect(out).not.toBeNull();
    expect(out!.name).toBe("visit_milestone");
    expect(out!.message).toMatch(/25 visits/);
  });
});

describe("renderWowCandidate", () => {
  it("trims the message", () => {
    const fake: WowMoment = {
      name:         "x",
      description:  "test",
      predicate:    () => true,
      buildMessage: () => "   hello   ",
    };
    expect(renderWowCandidate(fake, baseCtx()).message).toBe("hello");
  });
});
