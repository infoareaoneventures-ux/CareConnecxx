import { describe, it, expect } from "vitest";
import {
  languageAugmenter,
  unconfirmedIdentityAugmenter,
  personaReinjectAugmenter,
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
