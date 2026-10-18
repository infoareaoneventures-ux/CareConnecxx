import { describe, it, expect, vi, beforeEach } from "vitest";

const parseWithClaude = vi.fn(async (..._a: unknown[]) => "[]");
vi.mock("../../utils/parseWithClaude", () => ({
  parseWithClaude: (...a: unknown[]) => parseWithClaude(...a),
}));

import {
  canonicalizeCaregiverServices,
  mapCaregiverServices,
  CANONICAL_SERVICES,
  PRIMARY_SERVICES,
  CHILD_SERVICES,
  RELATIONSHIPS,
  SERVICE_LABELS,
  serviceLabel,
  serviceMenuText,
  serviceFromNameOrLabel,
} from "../caregiverServices";
import * as fs from "node:fs";
import * as path from "node:path";

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
    // 2026-10-18: + the child-care eight (Transportation once) — 15 names either site list can store.
    expect(CHILD_SERVICES).toEqual(["Supervision", "Baby Care", "Bathing & Dressing", "Meals & Snacks", "Activities & Play", "School & Homework", "Transportation", "Tidying & Laundry"]);
    expect(CANONICAL_SERVICES).toHaveLength(15);
    expect(CANONICAL_SERVICES.filter((s) => s === "Transportation")).toHaveLength(1);
    expect(RELATIONSHIPS).toEqual(["Myself", "Parent", "Spouse or Partner", "Child", "Other"]);
  });

  it("the site's constants file holds the same eight and the same display label (byte parity)", () => {
    const site = fs.readFileSync(path.resolve(__dirname, "../../../../components/caregiver/signup/constants.ts"), "utf8");
    for (const s of PRIMARY_SERVICES) expect(site).toContain(`'${s}',`);
    for (const s of CHILD_SERVICES) expect(site).toContain(`'${s}',`);
    for (const r of RELATIONSHIPS) expect(site).toContain(`'${r}'`);
    expect(site).toContain("'Medication Reminders': 'Medication Reminders Only'");
  });

  it("Medication Reminders is shown as 'Medication Reminders Only'; the stored value never changes", () => {
    expect(serviceLabel("Medication Reminders")).toBe("Medication Reminders Only");
    expect(serviceLabel("Personal Care")).toBe("Personal Care");
    expect(SERVICE_LABELS).toEqual([
      "Mobility Assistance", "Dementia / Memory Care", "Medication Reminders Only", "Personal Care",
      "Companionship", "Transportation", "Meal Preparation", "Light Housekeeping",
    ]);
    expect(serviceMenuText().split("\n")).toEqual(SERVICE_LABELS);
    expect(serviceFromNameOrLabel("medication reminders only")).toBe("Medication Reminders");
    expect(serviceFromNameOrLabel("Medication Reminders")).toBe("Medication Reminders");
    expect(serviceFromNameOrLabel("hospice")).toBeNull();
    expect(CANONICAL_SERVICES).not.toContain("Medication Reminders Only");
  });
});

describe("mapCaregiverServices — the services step's gate", () => {
  it("names and single words land offline (no model call) — 'bathing' is Personal Care", async () => {
    const m = await mapCaregiverServices(["bathing", "cooking", "Medication Reminders Only", "Transportation"]);
    expect(m.matched).toEqual(["Medication Reminders", "Personal Care", "Transportation", "Meal Preparation"]);
    expect(m.medical).toEqual([]);
    expect(m.unmapped).toEqual([]);
    expect(m.unresolved).toEqual([]);
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("medical care is reported, never saved as a service", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ services: ["Personal Care"], medical: ["I give insulin shots"], unmapped: [] }));
    const m = await mapCaregiverServices(["help with bathing", "I give insulin shots"]);
    expect(m.matched).toEqual(["Personal Care"]);
    expect(m.medical).toEqual(["I give insulin shots"]);
  });

  it("off-list answers come back as unmapped, and hallucinated enum values are dropped", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ services: ["Companionship", "Gardening"], medical: [], unmapped: ["hospice"] }));
    const m = await mapCaregiverServices(["keeping her company", "hospice"]);
    expect(m.matched).toEqual(["Companionship"]);
    expect(m.unmapped).toEqual(["hospice"]);
  });

  it("a model failure leaves the phrases unresolved instead of guessing (direct hits still land)", async () => {
    parseWithClaude.mockResolvedValueOnce("__parse_error__");
    const m = await mapCaregiverServices(["dementia", "help around the house"]);
    expect(m.matched).toEqual(["Dementia / Memory Care"]);
    expect(m.unresolved).toEqual(["help around the house"]);
    expect(m.unmapped).toEqual([]);
  });

  it("a plain string splits on commas", async () => {
    const m = await mapCaregiverServices("meals, laundry");
    expect(m.matched).toEqual(["Meal Preparation", "Light Housekeeping"]);
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
