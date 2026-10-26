import { describe, it, expect, vi, beforeEach } from "vitest";

// Live 2026-10-26 (Basra, a job post for a toddler): "Meals bathing" came back as Personal Care /
// Meal Preparation — the senior names — and was then rejected as "not on Mahad's list". The mapper
// now knows whose post it is: direct hits take their child twin, and the model is told it is a child.
const parseWithClaude = vi.fn(async (..._a: unknown[]) => "[]");
vi.mock("../../utils/parseWithClaude", () => ({ parseWithClaude: (...a: unknown[]) => parseWithClaude(...a) }));

import { mapCaregiverServices } from "../caregiverServices";
import { canonicalizeCareNeeds } from "../careNeedsTaxonomy";

beforeEach(() => { parseWithClaude.mockReset(); parseWithClaude.mockResolvedValue("[]"); });

describe("mapCaregiverServices with kinds", () => {
  it("a child-care post: senior direct hits become their child twins, no model call", async () => {
    const m = await mapCaregiverServices("meals, bathing, laundry", { kinds: ["child"] });
    expect(m.matched).toEqual(expect.arrayContaining(["Meals & Snacks", "Bathing & Dressing", "Tidying & Laundry"]));
    expect(m.matched).not.toContain("Personal Care");
    expect(m.matched).not.toContain("Meal Preparation");
    expect(parseWithClaude).not.toHaveBeenCalled();
  });

  it("a child-care post: free words are read with the child hint, and a senior name coming back is mapped to its twin", async () => {
    parseWithClaude.mockResolvedValueOnce('{"services":["Personal Care"],"medical":[],"unmapped":[]}');
    const m = await canonicalizeCareNeeds(["help with baths"], { kinds: ["child"] });
    expect(String(parseWithClaude.mock.calls[0][0])).toContain("These words are about a CHILD");
    expect(m.careNeeds).toEqual(["Bathing & Dressing"]);
  });

  it("a senior-care post keeps the senior names and tells the model it is an adult", async () => {
    parseWithClaude.mockResolvedValueOnce('{"services":["Personal Care"],"medical":[],"unmapped":[]}');
    const m = await mapCaregiverServices("help with baths", { kinds: ["senior"] });
    expect(String(parseWithClaude.mock.calls[0][0])).toContain("These words are about an ADULT");
    expect(m.matched).toEqual(["Personal Care"]);
  });

  it("no kinds (a mixed post, or a care provider's own services) → unchanged behaviour", async () => {
    const m = await mapCaregiverServices("meals, bathing");
    expect(m.matched).toEqual(expect.arrayContaining(["Meal Preparation", "Personal Care"]));
    expect(parseWithClaude).not.toHaveBeenCalled();
  });
});
