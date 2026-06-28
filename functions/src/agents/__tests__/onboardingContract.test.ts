import { describe, it, expect } from "vitest";
import {
  CLIENT_REQUIRED_FIELDS,
  CAREGIVER_REQUIRED_FIELDS,
  requiredFieldsForRole,
  isAllowedField,
  missingRequiredFields,
  firstGateStep,
  isOnboardingTool,
  ONBOARDING_TOOL_NAMES,
} from "../onboardingContract";

describe("onboardingContract", () => {
  it("client required fields are the dispatcher's contract", () => {
    expect(CLIENT_REQUIRED_FIELDS).toEqual(["firstName", "seniorName", "age", "city", "schedule"]);
  });

  it("caregiver required fields match the caregiver step parse targets", () => {
    expect(CAREGIVER_REQUIRED_FIELDS).toEqual([
      "name", "city", "yearsExperience", "specialties",
      "availability", "jobType", "hourlyRate", "email", "bio",
    ]);
  });

  it("requiredFieldsForRole routes by role", () => {
    expect(requiredFieldsForRole("client")).toBe(CLIENT_REQUIRED_FIELDS);
    expect(requiredFieldsForRole("caregiver")).toBe(CAREGIVER_REQUIRED_FIELDS);
  });

  describe("missingRequiredFields (the complete_collection gate)", () => {
    it("empty client data → every required field missing", () => {
      expect(missingRequiredFields("client", {})).toEqual(
        ["firstName", "seniorName", "age", "city", "schedule"],
      );
    });

    it("fully-filled client data → nothing missing (handoff allowed)", () => {
      const data = {
        firstName: "Imran", seniorName: "Dorothy", age: 82,
        city: "Austin", schedule: { days: 5, timeOfDay: "mornings" },
      };
      expect(missingRequiredFields("client", data)).toEqual([]);
    });

    it("partial client data → only the unfilled fields, in flow order", () => {
      const data = { firstName: "Imran", seniorName: "Dorothy" };
      expect(missingRequiredFields("client", data)).toEqual(["age", "city", "schedule"]);
    });

    it("treats empty string / zero / empty array as unfilled (isFieldFilled)", () => {
      const data = { firstName: "  ", seniorName: "Dorothy", age: 0, city: "Austin", schedule: [] };
      expect(missingRequiredFields("client", data)).toEqual(["firstName", "age", "schedule"]);
    });

    it("caregiver gate checks the caregiver set", () => {
      const data = { name: "Maria", city: "Austin", yearsExperience: 5 };
      expect(missingRequiredFields("caregiver", data)).toEqual([
        "specialties", "availability", "jobType", "hourlyRate", "email", "bio",
      ]);
    });
  });

  describe("isAllowedField", () => {
    it("accepts required and optional client fields", () => {
      expect(isAllowedField("client", "seniorName")).toBe(true);
      expect(isAllowedField("client", "relationship")).toBe(true);
      expect(isAllowedField("client", "budget")).toBe(true);
    });

    it("rejects unknown / invented fields", () => {
      expect(isAllowedField("client", "favoriteColor")).toBe(false);
      expect(isAllowedField("caregiver", "ssn")).toBe(false);
    });

    it("scopes fields by role", () => {
      expect(isAllowedField("caregiver", "hourlyRate")).toBe(true);
      expect(isAllowedField("client", "hourlyRate")).toBe(false);
    });
  });

  describe("onboarding tool surface (U3)", () => {
    it("restricts to exactly the three onboarding tools", () => {
      expect([...ONBOARDING_TOOL_NAMES].sort()).toEqual(
        ["complete_collection", "complete_task", "save_onboarding_field"],
      );
    });
    it("isOnboardingTool accepts the onboarding tools and rejects others", () => {
      expect(isOnboardingTool("save_onboarding_field")).toBe(true);
      expect(isOnboardingTool("complete_collection")).toBe(true);
      expect(isOnboardingTool("complete_task")).toBe(true);
      expect(isOnboardingTool("cancel_appointment")).toBe(false);
      expect(isOnboardingTool("get_care_plan")).toBe(false);
    });
  });

  describe("firstGateStep", () => {
    it("client hands off to the legacy post-collection step", () => {
      expect(firstGateStep("client")).toBe("client_ask_start");
    });
    it("caregiver hands off to the first upload gate", () => {
      expect(firstGateStep("caregiver")).toBe("caregiver_send_photo");
    });
  });
});
