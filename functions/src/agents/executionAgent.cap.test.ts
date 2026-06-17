import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: () => ({ collection: () => ({}) }) }));

import { capConversationHistory } from "./executionAgent";

describe("capConversationHistory", () => {
  it("returns the array unchanged when under the cap", () => {
    const h = [1, 2, 3];
    expect(capConversationHistory(h, 24)).toBe(h);
  });

  it("keeps only the most recent N messages when over the cap", () => {
    const h = Array.from({ length: 30 }, (_, i) => i);
    const out = capConversationHistory(h, 24);
    expect(out).toHaveLength(24);
    expect(out[0]).toBe(6);    // oldest 6 dropped
    expect(out[23]).toBe(29);  // newest kept
  });

  it("defaults to a bounded cap (never unbounded)", () => {
    const h = Array.from({ length: 200 }, (_, i) => i);
    expect(capConversationHistory(h).length).toBeLessThanOrEqual(24);
  });
});
