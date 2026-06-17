import { describe, it, expect, vi } from "vitest";

// Stub the heavy collaborators so importing the module for one pure helper is cheap.
vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: () => ({ collection: () => ({}) }) }));
vi.mock("./../credentialVault", () => ({ storeCredential: vi.fn() }));
vi.mock("./../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn() }));
vi.mock("./../../utils/openaiClient", () => ({ quickComplete: vi.fn() }));

import { isPlausiblePassword } from "../credentialCollector";

describe("isPlausiblePassword (H-U7)", () => {
  it("accepts a real-looking password", () => {
    expect(isPlausiblePassword("s3cret-PW")).toBe(true);
    expect(isPlausiblePassword("ValidPass1")).toBe(true);
  });
  it("rejects too-short values", () => {
    expect(isPlausiblePassword("abc")).toBe(false);
    expect(isPlausiblePassword("")).toBe(false);
  });
  it("rejects values with whitespace (a sentence, not a password)", () => {
    expect(isPlausiblePassword("is this my password")).toBe(false);
    expect(isPlausiblePassword("pass word")).toBe(false);
  });
});
