import { describe, it, expect } from "vitest";
import { CANONICAL_CARE_CATEGORIES, toCanonicalCareCategory, normalizeCareNeeds } from "../careNeedCategories";

// 2026-09-11: Evia's SMS job-posting flow was storing fine-grained terms
// ("bathing", "medication reminders") straight into careNeeds instead of the
// parent category — CarePlan.tsx showed them as flat items with no parent,
// and caregiver skill-matching (tagged at category granularity) never found
// a single match. These lock in the normalization that fixes both.

describe("toCanonicalCareCategory", () => {
  it.each(CANONICAL_CARE_CATEGORIES)("passes an exact canonical category through unchanged: %s", (cat) => {
    expect(toCanonicalCareCategory(cat)).toBe(cat);
  });

  it("is case-insensitive on exact matches", () => {
    expect(toCanonicalCareCategory("personal care")).toBe("Personal Care");
    expect(toCanonicalCareCategory("MEDICATION REMINDERS")).toBe("Medication Reminders");
  });

  it("maps the exact fine-grained terms from the live bug report", () => {
    expect(toCanonicalCareCategory("bathing")).toBe("Personal Care");
    expect(toCanonicalCareCategory("medication reminders")).toBe("Medication Reminders");
  });

  it("maps other fine-grained personal-care sub-tasks", () => {
    expect(toCanonicalCareCategory("grooming")).toBe("Personal Care");
    expect(toCanonicalCareCategory("dressing")).toBe("Personal Care");
    expect(toCanonicalCareCategory("toileting")).toBe("Personal Care");
  });

  it("maps near-miss category variants an LLM might return instead of the exact string", () => {
    expect(toCanonicalCareCategory("Memory Care")).toBe("Dementia / Memory Care");
    expect(toCanonicalCareCategory("Memory Care / Dementia")).toBe("Dementia / Memory Care");
    expect(toCanonicalCareCategory("Mobility & Movement")).toBe("Mobility Assistance");
    expect(toCanonicalCareCategory("Meals & Nutrition")).toBe("Meal Preparation");
    expect(toCanonicalCareCategory("Medications")).toBe("Medication Reminders");
  });

  it("maps mobility/dementia/meal/transport sub-tasks", () => {
    expect(toCanonicalCareCategory("walking assistance")).toBe("Mobility Assistance");
    expect(toCanonicalCareCategory("Alzheimer's support")).toBe("Dementia / Memory Care");
    expect(toCanonicalCareCategory("cooking dinner")).toBe("Meal Preparation");
    expect(toCanonicalCareCategory("driving to appointments")).toBe("Transportation");
  });

  it("returns null for unrecognized text rather than passing it through", () => {
    expect(toCanonicalCareCategory("something unrelated")).toBeNull();
    expect(toCanonicalCareCategory("")).toBeNull();
    expect(toCanonicalCareCategory("   ")).toBeNull();
  });
});

describe("normalizeCareNeeds", () => {
  it("normalizes the exact flat array from the live bug report into canonical categories", () => {
    expect(normalizeCareNeeds(["bathing", "medication reminders"])).toEqual([
      "Personal Care",
      "Medication Reminders",
    ]);
  });

  it("deduplicates when multiple raw terms map to the same category", () => {
    expect(normalizeCareNeeds(["bathing", "grooming", "dressing"])).toEqual(["Personal Care"]);
  });

  it("drops unrecognized terms instead of keeping them as-is", () => {
    expect(normalizeCareNeeds(["bathing", "something unrelated"])).toEqual(["Personal Care"]);
  });

  it("returns an empty array for an empty or fully-unrecognized input", () => {
    expect(normalizeCareNeeds([])).toEqual([]);
    expect(normalizeCareNeeds(["gibberish"])).toEqual([]);
  });
});
