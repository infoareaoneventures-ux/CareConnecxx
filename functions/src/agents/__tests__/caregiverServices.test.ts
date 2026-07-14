import { describe, it, expect, vi, beforeEach } from "vitest";

const parseWithClaude = vi.fn(async (..._a: unknown[]) => "[]");
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: (...a: unknown[]) => parseWithClaude(...a),
}));

import {
  canonicalizeCaregiverServices,
  CANONICAL_SERVICES,
  PRIMARY_SERVICES,
} from "../caregiverServices";

beforeEach(() => {
  parseWithClaude.mockReset();
  parseWithClaude.mockResolvedValue("[]");
});

describe("canonical enum parity with the webapp", () => {
  it("holds the exact 8 primary + 6 additional service strings", () => {
    expect(PRIMARY_SERVICES).toEqual([
      "Mobility Assistance",
      "Dementia / Memory Care",
      "Medication Reminders",
      "Personal Care",
      "Companionship",
      "Transportation",
      "Meal Preparation",
      "Light Housekeeping",
    ]);
    expect(CANONICAL_SERVICES).toHaveLength(14);
  });
});

describe("canonicalizeCaregiverServices", () => {
  it("maps model output onto exact canonical strings, deduped and ordered", async () => {
    parseWithClaude.mockResolvedValueOnce(
      JSON.stringify(["Companionship", "Dementia / Memory Care"]),
    );
    const out = await canonicalizeCaregiverServices(["companionship", "some dementia work"]);
    // canonical order: Dementia comes before Companionship in the enum
    expect(out).toEqual(["Dementia / Memory Care", "Companionship"]);
  });

  it("resolves common synonyms via direct hits even when the model returns nothing", async () => {
    parseWithClaude.mockResolvedValueOnce("[]");
    const out = await canonicalizeCaregiverServices(["cooking", "driving", "bathing"]);
    expect(out).toEqual(
      expect.arrayContaining(["Personal Care", "Transportation", "Meal Preparation"]),
    );
    // every returned value is canonical
    for (const s of out) expect(CANONICAL_SERVICES).toContain(s);
  });

  it("drops non-canonical values the model hallucinates", async () => {
    parseWithClaude.mockResolvedValueOnce(
      JSON.stringify(["Companionship", "Gardening", "Pet Care"]),
    );
    const out = await canonicalizeCaregiverServices(["companionship and pets"]);
    expect(out).toEqual(["Companionship"]);
  });

  it("passes already-canonical values straight through", async () => {
    parseWithClaude.mockResolvedValueOnce("[]");
    const out = await canonicalizeCaregiverServices(["Light Housekeeping"]);
    expect(out).toEqual(["Light Housekeeping"]);
  });

  it("returns [] for empty input without calling the model", async () => {
    expect(await canonicalizeCaregiverServices([])).toEqual([]);
    expect(await canonicalizeCaregiverServices(undefined)).toEqual([]);
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("survives a model parse error by falling back to direct hits", async () => {
    parseWithClaude.mockResolvedValueOnce("__parse_error__");
    const out = await canonicalizeCaregiverServices(["dementia"]);
    expect(out).toEqual(["Dementia / Memory Care"]);
  });

  it("returns [] when nothing maps (no box should be checked)", async () => {
    parseWithClaude.mockResolvedValueOnce("[]");
    const out = await canonicalizeCaregiverServices(["astrophysics tutoring"]);
    expect(out).toEqual([]);
  });
});
