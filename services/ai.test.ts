import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * U10 (R15) — sanitizeAiText wiring on the three SPA AI text surfaces in
 * services/ai.ts: generateShiftNote, searchCaregivers.responseText, and
 * conversationalBooking.response. A meta-response from the model (the model
 * replying to its prompt author instead of writing the user-facing text) must
 * render the surface's canned fallback, never the raw text; normal output
 * passes through unchanged.
 *
 * The aiProxy callable is mocked at the firebase/functions boundary —
 * services/ai.ts builds its callable at module load via
 * httpsCallable(getFunctions(), "v1-aiProxy").
 * VITEST GOTCHA: beforeEach callbacks use braces — a returned mock is invoked
 * as a cleanup hook.
 */

const proxyCall = vi.hoisted(() => vi.fn());
vi.mock("firebase/functions", () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => proxyCall),
}));

import { aiService } from "./ai";

// A meta-response shape that trips the sanitizer's conjunction rule:
// context-request (a) + briefing reference / role question (b).
const META_OUTPUT =
  "Got it, but I need the briefing context to write this message, who's the caregiver and what visit is this about?";

const SEARCH_FALLBACK_TEXT =
  "I'm having trouble connecting right now, but you can browse the list manually!";
const BOOKING_FALLBACK_RESPONSE =
  "I'm here to help you book a caregiver! Could you tell me what type of care you need?";

const modelReturns = (text: string) => {
  proxyCall.mockResolvedValue({ data: { text } });
};

const CAREGIVERS = [
  { id: "cg1", name: "Maria", hourlyRate: 25, distance: 2, verified: true, rating: 4.8 },
] as any[];

beforeEach(() => {
  proxyCall.mockReset();
});

describe("generateShiftNote", () => {
  it("returns normal professional note text unchanged", async () => {
    modelReturns("Client ambulated to the garden with standby assist and consumed a full lunch.");
    await expect(aiService.generateShiftNote("walked garden, ate lunch"))
      .resolves.toBe("Client ambulated to the garden with standby assist and consumed a full lunch.");
  });

  it("meta-response falls back to the caregiver's own shorthand, never the raw text", async () => {
    modelReturns(META_OUTPUT);
    await expect(aiService.generateShiftNote("walked garden, ate lunch"))
      .resolves.toBe("walked garden, ate lunch");
  });
});

describe("searchCaregivers responseText", () => {
  const searchPayload = (responseText: string) =>
    JSON.stringify({
      responseText,
      recommendedIds: ["cg1"],
      recommendations: [{ id: "cg1", reason: "great match", highlights: [] }],
      suggestions: [],
    });

  it("passes normal response text through, keeping the rest of the payload", async () => {
    modelReturns(searchPayload("Maria is a great match for mobility support."));
    const r = await aiService.searchCaregivers("need mobility help", CAREGIVERS);
    expect(r.responseText).toBe("Maria is a great match for mobility support.");
    expect(r.recommendedIds).toEqual(["cg1"]);
  });

  it("meta-response renders the canned search fallback, never the raw text", async () => {
    modelReturns(searchPayload(META_OUTPUT));
    const r = await aiService.searchCaregivers("need mobility help", CAREGIVERS);
    expect(r.responseText).toBe(SEARCH_FALLBACK_TEXT);
    expect(r.responseText).not.toContain("briefing");
    // Only the rendered text is sanitized — structured fields stay intact.
    expect(r.recommendedIds).toEqual(["cg1"]);
  });
});

describe("conversationalBooking response", () => {
  const bookingPayload = (response: string) =>
    JSON.stringify({
      response,
      isEmergency: false,
      missingInfo: [],
      nextQuestion: null,
      readyToShowMatches: true,
      readyToConfirm: false,
      extractedInfo: { service: "companionship", date: "2026-07-18", time: "09:00", duration: 3 },
      suggestions: [],
    });

  it("passes a normal booking reply through, keeping the rest of the payload", async () => {
    modelReturns(bookingPayload("Great — I can show you caregivers for Friday morning."));
    const r = await aiService.conversationalBooking(
      [{ role: "user", content: "I need help Friday morning" }],
      {},
    );
    expect(r.response).toBe("Great — I can show you caregivers for Friday morning.");
    expect(r.readyToShowMatches).toBe(true);
  });

  it("meta-response renders the canned booking fallback, never the raw text", async () => {
    modelReturns(bookingPayload(META_OUTPUT));
    const r = await aiService.conversationalBooking(
      [{ role: "user", content: "I need help Friday morning" }],
      {},
    );
    expect(r.response).toBe(BOOKING_FALLBACK_RESPONSE);
    expect(r.response).not.toContain("briefing");
  });
});
