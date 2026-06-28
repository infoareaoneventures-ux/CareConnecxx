import { describe, it, expect, afterEach } from "vitest";
import {
  shouldRouteOnboardingToLoop,
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
  it("client required fields are the flat keys downstream consumers read", () => {
    expect(CLIENT_REQUIRED_FIELDS).toEqual(
      ["firstName", "seniorName", "age", "careNeeds", "city", "daysPerWeek", "timeOfDay"],
    );
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
        ["firstName", "seniorName", "age", "careNeeds", "city", "daysPerWeek", "timeOfDay"],
      );
    });

    it("fully-filled client data → nothing missing (handoff allowed)", () => {
      const data = {
        firstName: "Imran", seniorName: "Dorothy", age: 82, careNeeds: ["bathing"],
        city: "Austin", daysPerWeek: 5, timeOfDay: "mornings",
      };
      expect(missingRequiredFields("client", data)).toEqual([]);
    });

    it("partial client data → only the unfilled fields, in flow order", () => {
      const data = { firstName: "Imran", seniorName: "Dorothy" };
      expect(missingRequiredFields("client", data)).toEqual(
        ["age", "careNeeds", "city", "daysPerWeek", "timeOfDay"],
      );
    });

    it("treats empty string / zero / empty array as unfilled (isFieldFilled)", () => {
      const data = { firstName: "  ", seniorName: "Dorothy", age: 0, careNeeds: ["meds"], city: "Austin", daysPerWeek: 3, timeOfDay: [] };
      expect(missingRequiredFields("client", data)).toEqual(["firstName", "age", "timeOfDay"]);
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

  describe("shouldRouteOnboardingToLoop (U4 routing gate)", () => {
    const base = { role: "client", step: "client_ask_needs", hasText: true, hasMedia: false, hasLocation: false };
    afterEach(() => { delete process.env.ONBOARDING_AGENT_LOOP; });

    it("routes a client collection step to the loop when the flag is on", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
    });

    it("does NOT route when the flag is off (default)", () => {
      expect(shouldRouteOnboardingToLoop(base)).toBe(false);
    });

    it("does NOT route a caregiver (client-first)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      expect(shouldRouteOnboardingToLoop({ ...base, role: "caregiver" })).toBe(false);
    });

    it("does NOT route a transactional/gate step (not a collection step)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      expect(shouldRouteOnboardingToLoop({ ...base, step: "client_send_payment" })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, step: "verify_phone" })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, step: "client_ask_start" })).toBe(false);
    });

    it("does NOT route media or location turns (stay on legacy handlers)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      expect(shouldRouteOnboardingToLoop({ ...base, hasMedia: true })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, hasLocation: true })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, hasText: false })).toBe(false);
    });

    it("routes only the role named in the flag", () => {
      process.env.ONBOARDING_AGENT_LOOP = "caregiver";
      expect(shouldRouteOnboardingToLoop(base)).toBe(false); // client not enabled
    });
  });
});
