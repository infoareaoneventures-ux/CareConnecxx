import { describe, it, expect, afterEach } from "vitest";
import {
  shouldRouteOnboardingToLoop,
  CLIENT_REQUIRED_FIELDS,
  CAREGIVER_REQUIRED_FIELDS,
  CLIENT_COLLECTION_STEPS,
  CAREGIVER_COLLECTION_STEPS,
  collectionStepsForRole,
  requiredFieldsForRole,
  isAllowedField,
  missingRequiredFields,
  firstGateStep,
  isOnboardingTool,
  ONBOARDING_TOOL_NAMES,
  normalizeOnboardingFieldValue,
  CAREGIVER_JOB_TYPES,
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

  describe("normalizeOnboardingFieldValue (Fix 3 — enum canonicalization)", () => {
    it("canonicalizes free-form jobType spellings to the enum", () => {
      expect(normalizeOnboardingFieldValue("jobType", "Full time")).toBe("full_time");
      expect(normalizeOnboardingFieldValue("jobType", "full-time")).toBe("full_time");
      expect(normalizeOnboardingFieldValue("jobType", "FT")).toBe("full_time");
      expect(normalizeOnboardingFieldValue("jobType", "Part Time")).toBe("part_time");
      expect(normalizeOnboardingFieldValue("jobType", "part-time")).toBe("part_time");
      expect(normalizeOnboardingFieldValue("jobType", "occasional")).toBe("occasional");
      expect(normalizeOnboardingFieldValue("jobType", "as needed")).toBe("occasional");
    });

    it("passes already-canonical values through unchanged", () => {
      for (const v of CAREGIVER_JOB_TYPES) {
        expect(normalizeOnboardingFieldValue("jobType", v)).toBe(v);
      }
    });

    it("keeps an unrecognized jobType value raw (never silently dropped)", () => {
      expect(normalizeOnboardingFieldValue("jobType", "weekends only")).toBe("weekends only");
    });

    it("leaves non-jobType fields and non-string values untouched", () => {
      expect(normalizeOnboardingFieldValue("city", "Full time")).toBe("Full time");
      expect(normalizeOnboardingFieldValue("jobType", 40)).toBe(40);
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

    it("does NOT route a caregiver when only 'client' is flagged (per-role gating)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      expect(shouldRouteOnboardingToLoop({ ...base, role: "caregiver", step: "caregiver_ask_name" })).toBe(false);
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

  describe("shouldRouteOnboardingToLoop — canary cohort scoping", () => {
    const base = { role: "client", step: "client_ask_needs", hasText: true, hasMedia: false, hasLocation: false, phone: "+15551234567" };
    afterEach(() => {
      delete process.env.ONBOARDING_AGENT_LOOP;
      delete process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT;
      delete process.env.ONBOARDING_AGENT_LOOP_PHONES;
    });

    it("default (no cohort narrowing) routes the whole enabled role", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
    });

    it("pct=0 excludes the phone even with the role enabled", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "0";
      expect(shouldRouteOnboardingToLoop(base)).toBe(false);
    });

    it("allowlist routes only listed phones (suffix match)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client";
      process.env.ONBOARDING_AGENT_LOOP_PHONES = "4567";
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
      expect(shouldRouteOnboardingToLoop({ ...base, phone: "+15550000000" })).toBe(false);
    });
  });

  describe("caregiver collection steps (the loop's caregiver surface)", () => {
    it("mirror the scripted caregiver_ask_* sequence, in flow order", () => {
      expect([...CAREGIVER_COLLECTION_STEPS]).toEqual([
        "caregiver_ask_name", "caregiver_ask_location", "caregiver_ask_story",
        "caregiver_ask_experience", "caregiver_ask_specialties", "caregiver_ask_profile",
        "caregiver_ask_availability", "caregiver_ask_job_type", "caregiver_ask_rate",
        "caregiver_ask_email", "caregiver_ask_bio",
      ]);
    });

    it("exclude every deterministic gate/awaiting step and the confirm-name step", () => {
      for (const gate of [
        "caregiver_confirm_name",
        "caregiver_send_photo", "caregiver_awaiting_photo",
        "caregiver_send_documents", "caregiver_awaiting_documents",
        "caregiver_ask_mvr", "caregiver_send_mvr", "caregiver_awaiting_mvr",
        "caregiver_send_membership", "caregiver_awaiting_membership",
        "caregiver_send_bgcheck", "caregiver_awaiting_bgcheck",
        "caregiver_send_stripe_connect", "caregiver_awaiting_stripe",
        "verify_phone",
      ]) {
        expect(CAREGIVER_COLLECTION_STEPS).not.toContain(gate);
      }
    });

    it("collectionStepsForRole routes by role", () => {
      expect(collectionStepsForRole("client")).toBe(CLIENT_COLLECTION_STEPS);
      expect(collectionStepsForRole("caregiver")).toBe(CAREGIVER_COLLECTION_STEPS);
    });

    it("caregiver loop may save the optional scripted-flow fields (story/profile/service-area)", () => {
      for (const f of ["certifications", "skills", "zipCode", "gender", "languages", "canDrive"]) {
        expect(isAllowedField("caregiver", f)).toBe(true);
      }
    });
  });

  describe("shouldRouteOnboardingToLoop — caregiver role", () => {
    const base = { role: "caregiver", step: "caregiver_ask_experience", hasText: true, hasMedia: false, hasLocation: false };
    afterEach(() => { delete process.env.ONBOARDING_AGENT_LOOP; });

    it("DEFAULT (flag unset): caregiver stays on the scripted runner", () => {
      expect(shouldRouteOnboardingToLoop(base)).toBe(false);
    });

    it("ONBOARDING_AGENT_LOOP=client,caregiver routes a caregiver collection step", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
      // and every collection step routes
      for (const step of CAREGIVER_COLLECTION_STEPS) {
        expect(shouldRouteOnboardingToLoop({ ...base, step })).toBe(true);
      }
    });

    it("ONBOARDING_AGENT_LOOP=caregiver alone also routes (role list, not a pair flag)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "caregiver";
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
      // while the client stays scripted
      expect(shouldRouteOnboardingToLoop({ ...base, role: "client", step: "client_ask_needs" })).toBe(false);
    });

    it("never routes a caregiver gate/awaiting step, even with the flag on", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
      for (const step of [
        "caregiver_confirm_name", "caregiver_send_photo", "caregiver_awaiting_photo",
        "caregiver_awaiting_documents", "caregiver_ask_mvr", "caregiver_awaiting_membership",
        "caregiver_awaiting_bgcheck", "caregiver_awaiting_stripe", "verify_phone", "ask_role",
      ]) {
        expect(shouldRouteOnboardingToLoop({ ...base, step })).toBe(false);
      }
    });

    it("never routes caregiver media/location/empty-text turns", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
      expect(shouldRouteOnboardingToLoop({ ...base, hasMedia: true })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, hasLocation: true })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, hasText: false })).toBe(false);
    });

    it("cohort narrowing applies to caregivers too (pct=0 fails closed)", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
      process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT = "0";
      expect(shouldRouteOnboardingToLoop({ ...base, phone: "+15551234567" })).toBe(false);
      delete process.env.ONBOARDING_AGENT_LOOP_COHORT_PCT;
    });

    it("unknown roles never route", () => {
      process.env.ONBOARDING_AGENT_LOOP = "client,caregiver";
      expect(shouldRouteOnboardingToLoop({ ...base, role: undefined })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, role: "admin" })).toBe(false);
    });
  });
});
