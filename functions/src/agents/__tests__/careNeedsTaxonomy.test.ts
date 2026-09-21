import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn(async () => "{}") }));

import { CARE_NEED_SUBS, canonicalizeCareNeeds, describeCareNeeds, isCanonicalCareNeeds } from "../careNeedsTaxonomy";

describe("care-needs taxonomy mirrors the website", () => {
  it("is byte-for-byte the CARE_NEED_SUBS map in components/CarePlan.tsx and the wizard's Step3CareNeeds.tsx", () => {
    for (const rel of ["components/CarePlan.tsx", "components/client/postJob/Step3CareNeeds.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "../../../../", rel), "utf8");
      const m = src.match(/const CARE_NEED_SUBS: Record<string, string\[\]> = (\{[\s\S]*?\n\});/);
      expect(m, `${rel} CARE_NEED_SUBS block`).toBeTruthy();
      // The site block is a plain object literal — evaluate it as one.
      const siteMap = new Function(`return ${m![1]};`)() as Record<string, string[]>;
      expect(siteMap).toEqual(CARE_NEED_SUBS);
    }
  });
});

describe("canonicalizeCareNeeds", () => {
  it("maps exact category / sub-task names without calling the model", async () => {
    const complete = vi.fn(async () => "{}");
    const r = await canonicalizeCareNeeds(["bathing", "Companionship", "Meal Preparation"], complete);
    expect(complete).not.toHaveBeenCalled();
    expect(r.careNeeds).toEqual(["Personal Care", "Companionship", "Meal Preparation"]);
    expect(r.careNeedDetails).toEqual({ "Personal Care": ["Bathing"] });
    expect(r.unmapped).toEqual([]);
  });

  it("asks the model only for the family's own words and keeps just taxonomy names from its answer", async () => {
    const complete = vi.fn(async (_system: string, _user: string) => JSON.stringify({
      "help with meals": { category: "Meal Preparation", sub: null },
      "someone to sit with her": { category: "Companionship", sub: null },
      "walks to the mailbox": { category: "Mobility Assistance", sub: "Ambulation" },
      "invented thing": { category: "Concierge", sub: "Made up" },
    }));
    const r = await canonicalizeCareNeeds(["bathing", "help with meals", "someone to sit with her", "walks to the mailbox", "invented thing"], complete);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(complete.mock.calls[0][1])).toEqual(["help with meals", "someone to sit with her", "walks to the mailbox", "invented thing"]);
    expect(r.careNeeds).toEqual(["Mobility Assistance", "Personal Care", "Companionship", "Meal Preparation"]);
    expect(r.careNeedDetails).toEqual({ "Personal Care": ["Bathing"], "Mobility Assistance": ["Ambulation"] });
    expect(r.unmapped).toEqual(["invented thing"]);
  });

  it("a failed or malformed model reply loses nothing: the words stay as unmapped", async () => {
    const r = await canonicalizeCareNeeds(["something odd"], async () => { throw new Error("down"); });
    expect(r.careNeeds).toEqual([]);
    expect(r.unmapped).toEqual(["something odd"]);
    const r2 = await canonicalizeCareNeeds(["x"], async () => "not json");
    expect(r2.unmapped).toEqual(["x"]);
  });

  it("isCanonicalCareNeeds / describeCareNeeds", () => {
    expect(isCanonicalCareNeeds(["Personal Care", "Bathing"])).toBe(true);
    expect(isCanonicalCareNeeds(["bathing", "companionship"])).toBe(true);
    expect(isCanonicalCareNeeds(["help around the house"])).toBe(false);
    expect(isCanonicalCareNeeds([])).toBe(false);
    expect(describeCareNeeds(["Personal Care", "Companionship"], { "Personal Care": ["Bathing", "Feeding"] })).toBe("Personal Care (Bathing, Feeding), Companionship");
  });
});
