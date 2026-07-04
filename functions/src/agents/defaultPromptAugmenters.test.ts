import { describe, it, expect } from "vitest";
import {
  languageAugmenter,
  unconfirmedIdentityAugmenter,
  personaReinjectAugmenter,
  communicationPreferencesAugmenter,
  buildCurrentTimeBlock,
  DEFAULT_AUGMENTERS,
} from "./defaultPromptAugmenters";
import type { AugmenterContext } from "./promptAugmenters";
import { createTurnMetrics } from "./turnMetrics";

const baseCtx = (over: Partial<AugmenterContext> = {}): AugmenterContext => ({
  text:      "hi",
  phone:     "+15555550100",
  userId:    "u-1",
  seniorId:  "s-1",
  userType:  "client",
  turnCount: 0,
  metrics:   createTurnMetrics({ phone: "+15555550100", userType: "client", pathway: "qa" }),
  ...over,
});

describe("languageAugmenter", () => {
  it("fires when session.preferredLanguage === 'es'", () => {
    const ctx = baseCtx({ session: { preferredLanguage: "es" } });
    expect(languageAugmenter.predicate!(ctx)).toBe(true);
    const out = languageAugmenter.augment(ctx) as string;
    expect(out).toContain("Spanish");
    expect(out).toMatch(/^LANGUAGE:/);
  });

  it("skips for English-default sessions", () => {
    expect(languageAugmenter.predicate!(baseCtx())).toBe(false);
    expect(languageAugmenter.predicate!(baseCtx({ session: { preferredLanguage: "en" } }))).toBe(false);
  });

  it("skips when session is undefined", () => {
    expect(languageAugmenter.predicate!(baseCtx({ session: undefined }))).toBe(false);
  });
});

describe("unconfirmedIdentityAugmenter", () => {
  it("fires when session.__unconfirmedIdentity is truthy", () => {
    const ctx = baseCtx({ session: { __unconfirmedIdentity: true } });
    expect(unconfirmedIdentityAugmenter.predicate!(ctx)).toBe(true);
    const out = unconfirmedIdentityAugmenter.augment(ctx) as string;
    expect(out).toMatch(/^UNCONFIRMED IDENTITY:/);
    expect(out).toContain("not completed onboarding");
    expect(out).toContain("treat as if you have no profile context");
  });

  it("skips for confirmed identity", () => {
    expect(unconfirmedIdentityAugmenter.predicate!(baseCtx())).toBe(false);
    expect(unconfirmedIdentityAugmenter.predicate!(baseCtx({ session: { __unconfirmedIdentity: false } }))).toBe(false);
  });
});

describe("personaReinjectAugmenter", () => {
  it("fires on every 4th turn", () => {
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 0 }))).toBe(false);
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 1 }))).toBe(false);
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 3 }))).toBe(false);
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 4 }))).toBe(true);
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 8 }))).toBe(true);
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 12 }))).toBe(true);
  });

  it("fires when the previous turn had a lint violation, regardless of turn count", () => {
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 1, session: { recentLintViolation: true } }))).toBe(true);
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 3, session: { recentLintViolation: true } }))).toBe(true);
  });

  it("does NOT fire when no lint violation AND turn count is not divisible by 4", () => {
    expect(personaReinjectAugmenter.predicate!(baseCtx({ turnCount: 5, session: { recentLintViolation: false } }))).toBe(false);
  });

  it("emits a <system_reminder> directive with the persona + epistemic guard", () => {
    const out = personaReinjectAugmenter.augment(baseCtx({ turnCount: 4 })) as string;
    expect(out).toMatch(/^<system_reminder>/);
    expect(out).toContain("warm, direct, specific");
    expect(out).toContain("Lead with the human before the data");
  });
});

describe("communicationPreferencesAugmenter", () => {
  const prefs = {
    dndEnabled:           true,
    dndStart:             "22:00",
    dndEnd:               "08:00",
    activeHours:          { start: "08:00", end: "21:00" },
    preferredSummaryTime: "18:00",
    preferSMS:            true,
    timezone:             "America/Los_Angeles",
  };

  it("skips when no preferences are on ctx.extras", () => {
    expect(communicationPreferencesAugmenter.predicate!(baseCtx())).toBe(false);
    expect(communicationPreferencesAugmenter.predicate!(baseCtx({ extras: {} }))).toBe(false);
  });

  it("fires when preferences ride in via ctx.extras", () => {
    const ctx = baseCtx({ extras: { preferences: prefs } });
    expect(communicationPreferencesAugmenter.predicate!(ctx)).toBe(true);
  });

  it("surfaces the DND window, channel preference, and hold-until-morning guidance", () => {
    const out = communicationPreferencesAugmenter.augment(baseCtx({ extras: { preferences: prefs } })) as string;
    expect(out).toMatch(/^COMMUNICATION PREFERENCES/);
    expect(out).toContain("22:00-08:00");
    expect(out).toContain("America/Los_Angeles");
    expect(out).toContain("Prefers SMS");
    expect(out).toContain("I'll hold this until morning");
    expect(out).toContain("update_communication_preferences");
  });

  it("says quiet hours are not enabled when DND is off", () => {
    const out = communicationPreferencesAugmenter.augment(
      baseCtx({ extras: { preferences: { ...prefs, dndEnabled: false, preferSMS: false } } }),
    ) as string;
    expect(out).toContain("Quiet hours: not enabled");
    expect(out).not.toContain("22:00-08:00");
    expect(out).not.toContain("Prefers SMS");
  });

  it("is registered in DEFAULT_AUGMENTERS (after the migrated trio)", () => {
    expect(DEFAULT_AUGMENTERS.map((a) => a.name)).toEqual([
      "language",
      "unconfirmed-identity",
      "persona-reinject",
      "frustration-recovery",
      "communication-preferences",
    ]);
  });
});

describe("buildCurrentTimeBlock", () => {
  // 2026-07-03T21:00:00Z = Friday 2026-07-03, 2:00 PM PDT.
  const fixedNow = new Date("2026-07-03T21:00:00Z");

  it("states ISO date, day-of-week, local time, and timezone for a stored tz", () => {
    const out = buildCurrentTimeBlock("America/Los_Angeles", fixedNow);
    expect(out).toMatch(/^CURRENT TIME: Today is 2026-07-03 \(Friday\)\./);
    expect(out).toContain("2:00 PM PDT");
    expect(out).toContain("(America/Los_Angeles)");
    expect(out).not.toContain("No timezone is on file");
  });

  it("respects a non-default stored timezone", () => {
    const out = buildCurrentTimeBlock("America/New_York", fixedNow);
    expect(out).toContain("5:00 PM EDT");
    expect(out).toContain("(America/New_York)");
    expect(out).not.toContain("No timezone is on file");
  });

  it("falls back to America/Los_Angeles and states the assumption when no tz is provided", () => {
    const out = buildCurrentTimeBlock(undefined, fixedNow);
    expect(out).toContain("(America/Los_Angeles)");
    expect(out).toContain("No timezone is on file");
    expect(out).toContain("Santa Clara County");
  });

  it("falls back safely on an invalid IANA name", () => {
    const out = buildCurrentTimeBlock("Not/AZone", fixedNow);
    expect(out).toContain("(America/Los_Angeles)");
    expect(out).toContain("No timezone is on file");
  });

  it("tells the model to resolve relative dates against the block", () => {
    const out = buildCurrentTimeBlock("America/Los_Angeles", fixedNow);
    expect(out).toContain("Resolve every relative date");
    expect(out).toContain("quiet hours");
  });

  it("crosses the date line correctly relative to UTC", () => {
    // 2026-07-04T05:30:00Z is still Friday 2026-07-03 in LA (10:30 PM PDT).
    const out = buildCurrentTimeBlock("America/Los_Angeles", new Date("2026-07-04T05:30:00Z"));
    expect(out).toContain("2026-07-03 (Friday)");
    expect(out).toContain("10:30 PM PDT");
  });
});
