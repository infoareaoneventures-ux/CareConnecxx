import { describe, expect, it } from "vitest";
import {
  CARE_RECIPES,
  findAdvertisedRecipeWithoutBacking,
  findCareRecipe,
  getCareRecipeExamples,
  hasPaymentAuthorityLeak,
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

  it("secondary-family recipes stay care-update scoped and never imply payment authority", () => {
    const offenders = CARE_RECIPES
      .filter((recipe) => recipe.roleScope.includes("family-secondary"))
      .filter((recipe) =>
        !["family_group_allowed", "private_primary"].includes(recipe.deliveryRule) ||
        hasPaymentAuthorityLeak([
          recipe.phrase,
          recipe.label,
          recipe.triggerPhrases.join(" "),
          recipe.toolPlan.join(" "),
        ].join(" ")),
      )
      .map((recipe) => recipe.id);

    expect(offenders).toEqual([]);
  });

  it("returns role-specific recipe examples", () => {
    expect(getCareRecipeExamples("client", 5).join(" ")).toMatch(/visit|care|share|hours/i);
    expect(getCareRecipeExamples("caregiver", 5).join(" ")).toMatch(/clock|hours|pay|caregiver/i);
    expect(getCareRecipeExamples("family-secondary", 5).join(" ")).toMatch(/care|share|visit/i);
  });

  it("share latest update is backed by family add and care journal tools", () => {
    const recipe = findCareRecipe("share_latest_update");
    expect(recipe?.toolPlan).toContain("add_family_member");
    expect(recipe?.toolPlan).toContain("get_care_journal_client");
    expect(recipe?.toolPlan).not.toContain("buildOrUpdateFamilyGroup");
    expect(recipe?.sideEffects).toContain("buildOrUpdateFamilyGroup");
  });

  it("does not flag current advertised recipes as missing shipped backing", () => {
    expect(findAdvertisedRecipeWithoutBacking(
      "I can share the latest care update with another family member.",
      "client",
    )).toBeUndefined();
  });
});
