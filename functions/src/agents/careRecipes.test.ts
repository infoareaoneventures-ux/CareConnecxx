import { describe, expect, it } from "vitest";
import {
  CARE_RECIPES,
  findAdvertisedRecipeWithoutBacking,
  getCareRecipeExamples,
} from "./careRecipes";
import { LAUNCH_ACTION_PARITY } from "./launchActionParity";

describe("CARE_RECIPES", () => {
  const parityById = new Map(LAUNCH_ACTION_PARITY.map((row) => [row.id, row]));

  it("maps every recipe to shipped launch parity rows", () => {
    const broken = CARE_RECIPES.flatMap((recipe) =>
      recipe.parityIds
        .map((id) => ({ recipe: recipe.id, row: parityById.get(id), id }))
        .filter(({ row }) => !row || row.status !== "shipped")
        .map(({ recipe, id, row }) => `${recipe} -> ${id} (${row?.status ?? "missing"})`),
    );
    expect(broken).toEqual([]);
  });

  it("every recipe declares authority, delivery, failure handling, and a tool plan", () => {
    const incomplete = CARE_RECIPES.filter((recipe) =>
      !recipe.authorityRule.trim() ||
      !recipe.failureVisibility.trim() ||
      recipe.toolPlan.length === 0 ||
      recipe.triggerPhrases.length === 0 ||
      recipe.requiredContext.length === 0,
    ).map((recipe) => recipe.id);

    expect(incomplete).toEqual([]);
  });

  it("returns role-specific recipe examples", () => {
    expect(getCareRecipeExamples("client", 5).join(" ")).toMatch(/visit|care|share|hours/i);
    expect(getCareRecipeExamples("caregiver", 5).join(" ")).toMatch(/clock|hours|pay|caregiver/i);
  });

  it("does not flag current advertised recipes as missing shipped backing", () => {
    expect(findAdvertisedRecipeWithoutBacking(
      "I can catch you up on the latest care note.",
      "client",
    )).toBeUndefined();
  });
});
