import { describe, it, expect, vi, beforeEach } from "vitest";

const parseWithClaude = vi.fn(async (..._a: unknown[]) => "{}");
vi.mock("../../utils/parseWithClaude", () => ({ parseWithClaude: (...a: unknown[]) => parseWithClaude(...a) }));

import { CARE_NEED_CATEGORIES, canonicalizeCareNeeds, describeCareNeeds, isCanonicalCareNeeds } from "../careNeedsTaxonomy";
import { PRIMARY_SERVICES, CHILD_SERVICES } from "../caregiverServiceLabels";

beforeEach(() => { parseWithClaude.mockReset(); parseWithClaude.mockResolvedValue("{}"); });

describe("care needs = the care provider side's eight, nothing underneath (2026-10-04)", () => {
  it("the categories ARE the eight services", () => {
    expect(CARE_NEED_CATEGORIES).toEqual([...PRIMARY_SERVICES, ...CHILD_SERVICES.filter((s) => s !== "Transportation")]); // + the child eight since 2026-10-18
  });

  it("names and single words land offline; 'bathing' is Personal Care and no sub-task is stored", async () => {
    const r = await canonicalizeCareNeeds(["bathing", "Companionship", "Meal Preparation"]);
    expect(parseWithClaude).not.toHaveBeenCalled();
    expect(r.careNeeds).toEqual(["Personal Care", "Companionship", "Meal Preparation"]);
    expect(r.careNeedDetails).toEqual({});
    expect(r.unmapped).toEqual([]);
    expect(r.medical).toEqual([]);
  });

  it("the family's own words go to the shared mapper; medical and off-list words come back named, never stored", async () => {
    parseWithClaude.mockResolvedValueOnce(JSON.stringify({ services: ["Companionship"], medical: ["give her insulin"], unmapped: ["invented thing"] }));
    const r = await canonicalizeCareNeeds(["someone to sit with her", "give her insulin", "invented thing"]);
    expect(parseWithClaude).toHaveBeenCalledTimes(1);
    expect(r.careNeeds).toEqual(["Companionship"]);
    expect(r.medical).toEqual(["give her insulin"]);
    expect(r.unmapped).toEqual(["invented thing"]);
  });

  it("a failed model reply leaves the words unresolved instead of guessing", async () => {
    parseWithClaude.mockResolvedValueOnce("__parse_error__");
    const r = await canonicalizeCareNeeds(["something odd"]);
    expect(r.careNeeds).toEqual([]);
    expect(r.unresolved).toEqual(["something odd"]);
  });

  it("isCanonicalCareNeeds / describeCareNeeds use the shown names", () => {
    expect(isCanonicalCareNeeds(["Personal Care", "medication reminders only"])).toBe(true);
    expect(isCanonicalCareNeeds(["Bathing"])).toBe(false);
    expect(isCanonicalCareNeeds([])).toBe(false);
    expect(describeCareNeeds(["Medication Reminders", "Companionship"])).toBe("Medication Reminders Only, Companionship");
  });
});
