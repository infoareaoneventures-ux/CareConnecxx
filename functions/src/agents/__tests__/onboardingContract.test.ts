import { describe, it, expect } from "vitest";
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
  caregiverJobTypesToWebIds,
  isChildcareVerticalSession,
  isPendingVerticalSession,
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

  describe("caregiverJobTypesToWebIds (webapp 'Looking for' parity)", () => {
    it("maps the underscored enum to hyphenated webapp ids", () => {
      expect(caregiverJobTypesToWebIds("full_time", undefined)).toEqual(["full-time"]);
      expect(caregiverJobTypesToWebIds("part_time", undefined)).toEqual(["part-time"]);
      expect(caregiverJobTypesToWebIds("occasional", undefined)).toEqual(["occasional"]);
    });
    it("keeps every type when more than one was named, in stable order", () => {
      expect(caregiverJobTypesToWebIds("part_time", ["occasional", "part_time"]))
        .toEqual(["occasional", "part-time"]);
    });
    it("tolerates already-hyphenated values and dedupes", () => {
      expect(caregiverJobTypesToWebIds("part-time", ["part_time"])).toEqual(["part-time"]);
    });
    it("returns [] when nothing usable", () => {
      expect(caregiverJobTypesToWebIds(undefined, undefined)).toEqual([]);
      expect(caregiverJobTypesToWebIds("weekends only", [])).toEqual([]);
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

  describe("shouldRouteOnboardingToLoop (loop-only routing gate)", () => {
    // Loop-only (2026-07-08): the loop is the SOLE collection path — no feature
    // flag, no cohort narrowing. Any text turn at a collection step routes here.
    const base = { role: "client", step: "client_ask_needs", hasText: true, hasMedia: false };

    it("routes a client collection step unconditionally (no flag)", () => {
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
    });

    it("does NOT route a transactional/gate/confirm-name step (not a collection step)", () => {
      expect(shouldRouteOnboardingToLoop({ ...base, step: "client_send_payment" })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, step: "verify_phone" })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, step: "client_ask_start" })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, step: "client_confirm_name" })).toBe(false);
    });

    it("does NOT route media turns (fall to handleInboundMedia) or empty text", () => {
      // Location pins are converted to text before the predicate (webhooks 2a),
      // so hasLocation is no longer a routing input.
      expect(shouldRouteOnboardingToLoop({ ...base, hasMedia: true })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, hasText: false })).toBe(false);
    });

    it("does NOT route unknown roles", () => {
      expect(shouldRouteOnboardingToLoop({ ...base, role: undefined })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, role: "admin" })).toBe(false);
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
        "caregiver_send_bgcheck", "caregiver_awaiting_bgcheck_consent", "caregiver_awaiting_bgcheck",
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

  describe("shouldRouteOnboardingToLoop — caregiver role (loop-only)", () => {
    const base = { role: "caregiver", step: "caregiver_ask_experience", hasText: true, hasMedia: false };

    it("routes every caregiver collection step unconditionally", () => {
      expect(shouldRouteOnboardingToLoop(base)).toBe(true);
      for (const step of CAREGIVER_COLLECTION_STEPS) {
        expect(shouldRouteOnboardingToLoop({ ...base, step })).toBe(true);
      }
    });

    it("never routes a caregiver gate/awaiting/confirm step", () => {
      for (const step of [
        "caregiver_confirm_name", "caregiver_send_photo", "caregiver_awaiting_photo",
        "caregiver_awaiting_documents", "caregiver_ask_mvr", "caregiver_awaiting_membership",
        "caregiver_awaiting_bgcheck_consent", "caregiver_awaiting_bgcheck",
        "caregiver_awaiting_stripe", "verify_phone", "ask_role",
      ]) {
        expect(shouldRouteOnboardingToLoop({ ...base, step })).toBe(false);
      }
    });

    it("never routes caregiver media / empty-text turns", () => {
      expect(shouldRouteOnboardingToLoop({ ...base, hasMedia: true })).toBe(false);
      expect(shouldRouteOnboardingToLoop({ ...base, hasText: false })).toBe(false);
    });
  });

  // ── Front door Stage 1: vertical stamps at the routing predicate ───────────
  //
  // docs/architecture/childcare-front-door-design.md. U5 added the child guard
  // on the assumption that a CAREGIVER childcare stamp could never exist. Stage
  // 1 makes it possible, so the guard is broadened here and pinned: neither a
  // stamped child session nor a session whose vertical is still being RESOLVED
  // may enter either collection funnel.
  describe("shouldRouteOnboardingToLoop — vertical stamps (R-FD1/R-FD5)", () => {
    const client = { role: "client", step: "client_ask_needs", hasText: true, hasMedia: false };
    const caregiver = { role: "caregiver", step: "caregiver_ask_location", hasText: true, hasMedia: false };

    it("a senior session (no stamp at all) routes exactly as before", () => {
      expect(shouldRouteOnboardingToLoop(client)).toBe(true);
      expect(shouldRouteOnboardingToLoop(caregiver)).toBe(true);
      expect(shouldRouteOnboardingToLoop({ ...client, careVertical: null, verticalIntent: null })).toBe(true);
      expect(shouldRouteOnboardingToLoop({ ...client, careVertical: "senior", verticalIntent: "senior" })).toBe(true);
    });

    it("a childcare stamp never routes into the senior loop — for EITHER role", () => {
      for (const base of [client, caregiver]) {
        expect(shouldRouteOnboardingToLoop({ ...base, careVertical: "child" })).toBe(false);
        expect(shouldRouteOnboardingToLoop({ ...base, verticalIntent: "child" })).toBe(false);
      }
    });

    it("a PENDING vertical never routes into either funnel (nothing is decided yet)", () => {
      for (const base of [client, caregiver]) {
        expect(shouldRouteOnboardingToLoop({ ...base, verticalIntent: "pending" })).toBe(false);
        expect(shouldRouteOnboardingToLoop({ ...base, careVertical: "pending" })).toBe(false);
      }
    });
  });

  describe("isPendingVerticalSession", () => {
    it("is true only for the unresolved-classification stamps", () => {
      expect(isPendingVerticalSession({ verticalIntent: "pending" })).toBe(true);
      expect(isPendingVerticalSession({ careVertical: "pending" })).toBe(true);
      expect(isPendingVerticalSession({ verticalIntent: "child" })).toBe(false);
      expect(isPendingVerticalSession({ careVertical: "senior" })).toBe(false);
      expect(isPendingVerticalSession({})).toBe(false);
      expect(isPendingVerticalSession(null)).toBe(false);
    });

    it("is DISTINCT from a childcare session — pending belongs to no vertical", () => {
      const pending = { verticalIntent: "pending" };
      expect(isChildcareVerticalSession(pending)).toBe(false);
      expect(isPendingVerticalSession(pending)).toBe(true);
      const child = { careVertical: "child", verticalIntent: "child" };
      expect(isChildcareVerticalSession(child)).toBe(true);
      expect(isPendingVerticalSession(child)).toBe(false);
    });
  });
});
