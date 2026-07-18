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

  it("leaves a context-request shape ALONE unchanged — no briefing/transcript/role reference (pins the && conjunction)", () => {
    // A regression from `&&` to `||` in the meta-response rule would replace
    // this legitimate copy: one signal (a) with no signal (b) must pass.
    const text = "I need more information before I can help with that.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  // Imperative-ask meta shapes (mirrors outputGuard.ts): "please provide/
  // share/let me know" + an info-seeking object counts as signal (a); the
  // conjunction rule still requires a briefing/transcript reference or role
  // question before anything is replaced.
  it("replaces an imperative ask for names/details combined with a briefing reference", () => {
    const meta =
      "Please provide the caregiver's name and the shift details from the briefing so I can write this message.";
    expect(sanitizeAiText(meta, FALLBACK)).toBe(FALLBACK);
  });

  it("replaces a 'share … details' imperative combined with a transcript reference", () => {
    const meta = "Share the shift details from the transcript and I'll draft the text.";
    expect(sanitizeAiText(meta, FALLBACK)).toBe(FALLBACK);
  });

  it("leaves an ordinary imperative in real copy unchanged ('please let me know if 2pm works')", () => {
    const text = "Please let me know if 2pm works for you.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  it("leaves an imperative ask ALONE unchanged — no briefing/transcript/role reference (conjunction rule)", () => {
    const text = "Please provide your name when you arrive at the front desk.";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  // The SPA sanitizer deliberately has NO URL leg (see the module header —
  // outputGuard's URL check is SMS-specific). These pin that emails, prose
  // typos, and even real domains pass through unchanged here.
  it("leaves the platform email address unchanged (no URL leg in the SPA sanitizer)", () => {
    const text = "You can reach us at support@eviacares.com";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });

  it("leaves a missing-space typo like 'text.me later today' unchanged", () => {
    const text = "text.me later today";
    expect(sanitizeAiText(text, FALLBACK)).toBe(text);
  });
});
