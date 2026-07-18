import { describe, it, expect } from "vitest";
import { sanitizeAiText } from "./sanitizeAiText";

/**
 * U10 web-app AI output sanitizer (hallucination hardening, R15).
 *
 * The marker logic mirrors functions/src/safety/outputGuard.ts (aligned by
 * review — separate bundles), so these cases track that module's suite:
 * the leaked incident text, the conjunction rule (bare "briefing"/"transcript"
 * mentions never match), and the 2026-07-06 word-boundary regression.
 */

const FALLBACK = "canned fallback copy";

describe("sanitizeAiText", () => {
  it("replaces the exact leaked incident meta-response with the fallback", () => {
    const leaked =
      "Got it, but I need the briefing context to write this message, who's the caregiver and what visit is this about?";
    expect(sanitizeAiText(leaked, FALLBACK)).toBe(FALLBACK);
  });

  it("replaces an inability-shaped meta-response with the fallback", () => {
    const meta = "I can't see the briefing for this shift, so who is the client here?";
    expect(sanitizeAiText(meta, FALLBACK)).toBe(FALLBACK);
  });

  it("returns normal shift-note text unchanged", () => {
    const note =
      "Client ambulated to the garden with standby assist, consumed a full lunch, and rested comfortably in the afternoon.";
    expect(sanitizeAiText(note, FALLBACK)).toBe(note);
  });

  it("returns the fallback for empty text", () => {
    expect(sanitizeAiText("", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for whitespace-only text", () => {
    expect(sanitizeAiText("   \n\t ", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for non-string input (defensive — parsed JSON fields)", () => {
    expect(sanitizeAiText(undefined as unknown as string, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeAiText(null as unknown as string, FALLBACK)).toBe(FALLBACK);
  });

  it('leaves a bare "morning briefing" mention unchanged (conjunction rule)', () => {
    const text = "I'll include that in tomorrow's morning briefing.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  it('leaves a bare "certificate or transcript" mention unchanged (conjunction rule)', () => {
    const text = "You can send a photo of your certificate or transcript.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  it('never matches inside "debriefing" (2026-07-06 word-boundary regression)', () => {
    const text = "We scheduled a debriefing session with the team; I don't have details or info on the exact time yet.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  it("leaves a warm role-question line unchanged when there is no briefing reference", () => {
    const text = "Maria, who is your caregiver, will arrive at 2 PM.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });
});
