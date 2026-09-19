import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * U8 (hallucination hardening 2026-07-17, R11) — source-scan regression guard
 * in the groundedBriefings.test.ts / parity.test.ts style.
 *
 * The 2026-07-17 audit found 24 family-facing generateCaraMessage briefings
 * that interpolate a senior/client name WITHOUT who-is-who grounding — the
 * "book Anahi's first visits" conflation (care mis-attributed to the ACCOUNT
 * HOLDER when the visits are for the recipient, e.g. her mom Rosie).
 *
 * Rule (careRecipients.ts): any family-facing LLM context interpolating a
 * client name must include describeWhoIsWho — or, where the call site cannot
 * cheaply load recipient/relationship data, the explicit inline attribution
 * line ("the care recipient is/was {name}").
 *
 * These are pragmatic per-file count assertions (not a TS parser): each listed
 * file must reference the helper prefix / attribution phrase at least as many
 * times as it has audited family-facing sites. Dropping the grounding from any
 * site fails the corresponding count.
 */

const read  = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

// Every helper-wired context is prefixed with `(whoIsWho ? whoIsWho + " " : "")`
// (morningBriefing's primary briefing uses "\n") — count the stable prefix.
const HELPER_PREFIX = "whoIsWho ? whoIsWho + ";

// file (relative to this __tests__ dir) → number of family-facing briefing
// sites wired via describeWhoIsWho.
const HELPER_WIRED: Array<[string, number]> = [
  ["../../scheduled/firstVisitActivation.ts",   1],
  ["../../scheduled/familySilenceCheckin.ts",   1],
  ["../../scheduled/upcomingVisitReminder.ts",  1],
  ["../../scheduled/morningBriefing.ts",        2], // primary briefing + generateCaraMessage fallback
  ["../../linq/webhooks.ts",                    1], // awaiting-supply hold reply
  ["../../triggers/jobApplicationTriggers.ts",  1],
  // jobPostingFlow.ts deliberately dropped 2026-09-08: unlike every other file
  // here, a job post's recipient is CHOSEN mid-conversation and can differ
  // from the account's fixed onboarding senior (posting for someone new, or
  // for a second household member) — describeWhoIsWho's static, account-level
  // framing actively caused misattribution here (a job being set up for a new
  // person got described using the wrong, stale on-file senior; a mid-flow
  // answer's "for X" line got contradicted by describeWhoIsWho's own "never
  // for X" sentence right after it). Replaced with resolveJobRecipient /
  // recipientsDisplayName, which resolve the job's ACTUAL in-progress
  // recipient dynamically per call — strictly more correct for this file's
  // multi-recipient nature than the static helper the other files use.
  ["../permissionsConversation.ts",             1],
  ["../onboardingConversation.ts",              2], // pre-checkout msg7 + link-sent reassurance
];

// Sites that cannot cheaply load recipient/relationship data carry the
// explicit inline attribution line instead (bereavement keeps it minimal and
// past-tense — grief-sensitive copy).
const INLINE_WIRED: Array<[string, string, number]> = [
  ["../../linq/routeCaregiver.ts", "the care recipient is ${", 1], // family confirm (the cancel alert went with the removed emergency-replacement path, 2026-09-16)
  ["../issueEscalator.ts",         "the care recipient is ${", 2], // issue notice + next-day follow-up
  ["../bereavement.ts",            "the care recipient was ${", 3], // condolence + keepsake promise/delivery
];

describe("R11 — who-is-who grounding present at every audited family-facing briefing", () => {
  it.each(HELPER_WIRED)("%s wires describeWhoIsWho into %i briefing context(s)", (rel, sites) => {
    const src = read(rel);
    expect(src, `${rel} must import describeWhoIsWho from careRecipients`)
      .toMatch(/import\s*\{[^}]*describeWhoIsWho[^}]*\}\s*from\s*["'][^"']*careRecipients["']/);
    expect(count(src, "describeWhoIsWho("), `${rel} must CALL describeWhoIsWho`)
      .toBeGreaterThanOrEqual(1);
    expect(count(src, HELPER_PREFIX), `${rel} must prepend the whoIsWho line to ${sites} briefing context(s)`)
      .toBeGreaterThanOrEqual(sites);
  });

  it.each(INLINE_WIRED)("%s carries the inline attribution line at %i site(s)", (rel, phrase, sites) => {
    const src = read(rel);
    expect(count(src, phrase), `${rel} must attribute the care to the recipient at ${sites} site(s)`)
      .toBeGreaterThanOrEqual(sites);
  });

  it("prior-wave sites (staleSessionNudge, qaAgent) still reference describeWhoIsWho", () => {
    expect(read("../../scheduled/staleSessionNudge.ts")).toContain("describeWhoIsWho(");
    expect(read("../qaAgent.ts")).toContain("describeWhoIsWho(");
  });

  it("the self-signup sentinel stays intact (no disambiguation line for self-recipients)", () => {
    const src = read("../careRecipients.ts");
    expect(src).toContain('if (relationship === "self")');
    expect(src).toContain("arranging care for THEMSELVES");
  });
});
