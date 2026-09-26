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
  resolveOnboardingFieldName,
  allowedFieldNamesForRole,
  missingRequiredFields,
  firstGateStep,
  isOnboardingTool,
  ONBOARDING_TOOL_NAMES,
  normalizeOnboardingFieldValue,
  coerceClientRate,
  CAREGIVER_JOB_TYPES,
  caregiverJobTypesToWebIds,
} from "../onboardingContract";

describe("onboardingContract", () => {
  it("client required fields are the flat keys downstream consumers read (wizard canAdvanceAt parity)", () => {
    expect(CLIENT_REQUIRED_FIELDS).toEqual([
      "careFrequency", "homeStreet", "homeZipCode", "sameAsHomeAddress", "city", "zipCode",
      "startDate", "selectedDays",
      "relationship", "seniorName", "emergencyContactName", "emergencyContactPhone",
      "careNeeds", "rate", "email", "firstName",
    ]);
    // The wizard does NOT require timeOfDay (still asked, optional to answer).
    expect(CLIENT_REQUIRED_FIELDS).not.toContain("timeOfDay");
    expect(isAllowedField("client", "timeOfDay")).toBe(true);
  });

  it("caregiver required fields are the site wizard's steps, in the wizard's order (2026-09-25)", () => {
    expect(CAREGIVER_REQUIRED_FIELDS).toEqual([
      "name",
      "street", "zipCode", "city", "state",
      "profilePhoto",
      "jobType", "availability",
      "specialties", "yearsExperience",
      "transportDocuments",
      "hourlyRate", "serviceRadius",
      "email", "bio",
    ]);
  });

  it("requiredFieldsForRole routes by role", () => {
    expect(requiredFieldsForRole("client")).toBe(CLIENT_REQUIRED_FIELDS);
    expect(requiredFieldsForRole("caregiver")).toBe(CAREGIVER_REQUIRED_FIELDS);
  });

  describe("missingRequiredFields (the complete_collection gate)", () => {
    it("empty client data → every required field missing", () => {
      expect(missingRequiredFields("client", {})).toEqual([
        "careFrequency", "homeStreet", "homeZipCode", "sameAsHomeAddress", "city", "zipCode",
        "startDate", "selectedDays",
        "relationship", "seniorName", "emergencyContactName", "emergencyContactPhone",
        "careNeeds", "rate", "email", "firstName",
      ]);
    });

    const FULL = {
      careFrequency: "part_time", homeStreet: "1 Main St", homeZipCode: "78701", sameAsHomeAddress: true,
      city: "Austin", zipCode: "78701",
      startDate: "2026-09-01", selectedDays: ["MON", "WED"], timeOfDay: ["mornings"],
      relationship: "daughter", seniorName: "Dorothy",
      emergencyContactName: "Imran", emergencyContactPhone: "555-1234",
      careNeeds: ["bathing"], rate: 26, email: "imran@example.com", firstName: "Imran",
    };

    it("fully-filled client data → nothing missing (handoff allowed)", () => {
      expect(missingRequiredFields("client", FULL)).toEqual([]);
    });

    it("treats an explicit sameAsHomeAddress:false as filled, not missing", () => {
      expect(missingRequiredFields("client", { ...FULL, sameAsHomeAddress: false, zipCode: "78702" })).toEqual([]);
    });

    // Wizard canAdvanceAt(3): street AND zip are both required for the home address.
    it("home street is required, like the wizard's home-address step", () => {
      const { homeStreet: _omit, ...noStreet } = FULL;
      expect(missingRequiredFields("client", noStreet)).toEqual(["homeStreet"]);
    });

    // Wizard canAdvanceAt(6): `selectedDays.length > 0 || daysFlexible`.
    it("flexible-only days satisfy selectedDays; flexible:false with no days does not", () => {
      expect(missingRequiredFields("client", { ...FULL, selectedDays: [], daysFlexible: true })).toEqual([]);
      expect(missingRequiredFields("client", { ...FULL, selectedDays: undefined, daysFlexible: true })).toEqual([]);
      expect(missingRequiredFields("client", { ...FULL, selectedDays: [], daysFlexible: false })).toEqual(["selectedDays"]);
    });

    // The wizard never requires timeOfDay — a "not sure" answer may leave it empty.
    it("timeOfDay is optional", () => {
      expect(missingRequiredFields("client", { ...FULL, timeOfDay: undefined })).toEqual([]);
      expect(missingRequiredFields("client", { ...FULL, timeOfDay: [] })).toEqual([]);
    });

    it("partial client data → only the unfilled fields, in flow order", () => {
      const data = { careFrequency: "part_time", homeZipCode: "78701", city: "Austin", relationship: "daughter", seniorName: "Dorothy" };
      expect(missingRequiredFields("client", data)).toEqual([
        "homeStreet", "sameAsHomeAddress", "zipCode", "startDate", "selectedDays", "emergencyContactName",
        "emergencyContactPhone", "careNeeds", "rate", "email", "firstName",
      ]);
    });

    it("treats empty string / zero / empty array as unfilled (isFieldFilled)", () => {
      const data = { ...FULL, selectedDays: [], rate: 0, firstName: "  " };
      expect(missingRequiredFields("client", data)).toEqual(["selectedDays", "rate", "firstName"]);
    });

    it("caregiver gate checks the caregiver set", () => {
      const data = { name: "Maria", city: "Austin", yearsExperience: "3-5 years" };
      expect(missingRequiredFields("caregiver", data)).toEqual([
        "street", "zipCode", "state", "profilePhoto", "jobType", "availability", "specialties",
        "hourlyRate", "serviceRadius", "email", "bio",
      ]);
    });

    it("caregiver transport documents are required only when Transportation is offered, and only until all three are in", () => {
      const base = {
        name: "Maria", street: "1 Main St", zipCode: "95134", city: "San Jose", state: "CA", profilePhoto: "https://x/p.jpg",
        jobType: "part_time", availability: { days: ["Monday"], hours: "mornings" }, specialties: ["Companionship"],
        yearsExperience: "3-5 years", hourlyRate: 25, serviceRadius: 10, email: "m@x.com", bio: "x".repeat(150),
      };
      expect(missingRequiredFields("caregiver", base)).toEqual([]);
      const driver = { ...base, skills: ["Companionship", "Transportation"] };
      expect(missingRequiredFields("caregiver", driver)).toEqual(["transportDocuments"]);
      expect(missingRequiredFields("caregiver", { ...driver, transportDocs: { driversLicense: "u", insurance: "u" } })).toEqual(["transportDocuments"]);
      expect(missingRequiredFields("caregiver", { ...driver, transportDocs: { driversLicense: "u", insurance: "u", registration: "u" } })).toEqual([]);
    });
  });

  describe("isAllowedField", () => {
    it("accepts required and optional client fields", () => {
      expect(isAllowedField("client", "seniorName")).toBe(true);
      expect(isAllowedField("client", "relationship")).toBe(true);
      expect(isAllowedField("client", "homeStreet")).toBe(true);
      expect(isAllowedField("client", "daysFlexible")).toBe(true);
    });

    it("rejects unknown / invented fields", () => {
      expect(isAllowedField("client", "favoriteColor")).toBe(false);
      expect(isAllowedField("caregiver", "ssn")).toBe(false);
    });

    // Wizard parity: the site never asks for diagnoses (medical scope is out),
    // nor a budget/preferences (retired with the legacy post-collection steps).
    it("rejects the retired non-wizard client fields (conditions, budget, preferences)", () => {
      expect(isAllowedField("client", "conditions")).toBe(false);
      expect(isAllowedField("client", "budget")).toBe(false);
      expect(isAllowedField("client", "preferences")).toBe(false);
    });
  });

  // 2026-09-26: the model's near-miss keys ('smoking', 'pets', 'description')
  // must resolve onto the contract key instead of losing the answer.
  describe("resolveOnboardingFieldName", () => {
    it("passes exact keys through and resolves case/punctuation variants", () => {
      expect(resolveOnboardingFieldName("client", "smokingHousehold")).toBe("smokingHousehold");
      expect(resolveOnboardingFieldName("client", "Smoking Household")).toBe("smokingHousehold");
      expect(resolveOnboardingFieldName("caregiver", "hourly_rate")).toBe("hourlyRate");
    });
    it("maps the live near-misses", () => {
      expect(resolveOnboardingFieldName("client", "smoking")).toBe("smokingHousehold");
      expect(resolveOnboardingFieldName("client", "pets")).toBe("petsInHome");
      expect(resolveOnboardingFieldName("client", "description")).toBe("jobDescription");
      expect(resolveOnboardingFieldName("client", "notes")).toBe("jobDescription");
      expect(resolveOnboardingFieldName("client", "hourlyRate")).toBe("rate");
      expect(resolveOnboardingFieldName("caregiver", "description")).toBe("bio");
      expect(resolveOnboardingFieldName("caregiver", "rate")).toBe("hourlyRate");
    });
    it("still rejects unknown / out-of-scope keys", () => {
      expect(resolveOnboardingFieldName("client", "favoriteColor")).toBeNull();
      expect(resolveOnboardingFieldName("client", "conditions")).toBeNull();
      expect(resolveOnboardingFieldName("caregiver", "certifications")).toBeNull();
      expect(resolveOnboardingFieldName("client", "")).toBeNull();
    });
    it("lists the allowed keys for the tool error", () => {
      expect(allowedFieldNamesForRole("client")).toContain("smokingHousehold");
      expect(allowedFieldNamesForRole("caregiver")).toContain("bio");
    });
  });

  describe("coerceClientRate (wizard rate > 0, no 'flexible')", () => {
    it("accepts numbers and numeric strings", () => {
      expect(coerceClientRate(26)).toBe(26);
      expect(coerceClientRate("26")).toBe(26);
      expect(coerceClientRate("$28/hr")).toBe(28);
      expect(coerceClientRate("27.5")).toBe(27.5);
    });
    it("rejects 'flexible', prose, zero and negatives (caller re-asks for a number)", () => {
      expect(coerceClientRate("flexible")).toBeNull();
      expect(coerceClientRate("not sure")).toBeNull();
      expect(coerceClientRate(0)).toBeNull();
      expect(coerceClientRate(-5)).toBeNull();
      expect(coerceClientRate(undefined)).toBeNull();
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
      expect(isOnboardingTool("request_booking")).toBe(false);
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

  // 2026-08-22: a live SMS test saved relationship:"child" for "it's for my
  // parent" — never wrong data, but not the website's canonical enum either
  // (ClientJobPostingWizard.tsx step 9: myself/parent/spouse/other), which
  // CarePlan.tsx's duplicate-recipient guard exact-matches against.
  describe("normalizeOnboardingFieldValue — relationship canonicalization", () => {
    it("maps parent-indicating freeform values to the canonical 'parent'", () => {
      for (const v of ["daughter", "son", "child", "mother", "mom", "father", "dad"]) {
        expect(normalizeOnboardingFieldValue("relationship", v)).toBe("parent");
      }
    });
    it("maps spouse-indicating freeform values to the canonical 'spouse'", () => {
      for (const v of ["wife", "husband", "partner"]) {
        expect(normalizeOnboardingFieldValue("relationship", v)).toBe("spouse");
      }
    });
    it("leaves Evia's internal 'self' sentinel untouched (not the website enum)", () => {
      expect(normalizeOnboardingFieldValue("relationship", "self")).toBe("self");
    });
    it("passes already-canonical parent/spouse/other through unchanged", () => {
      for (const v of ["parent", "spouse", "other"]) {
        expect(normalizeOnboardingFieldValue("relationship", v)).toBe(v);
      }
    });
    it("maps anything unrecognized to 'other' rather than leaving a raw string", () => {
      expect(normalizeOnboardingFieldValue("relationship", "her caretaker")).toBe("other");
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
    it("client hands off straight to the intake confirmation (legacy start/preferences/budget steps removed)", () => {
      expect(firstGateStep("client")).toBe("client_confirm_intake");
    });
    it("caregiver hands off to membership — the site dashboard's first card after the wizard", () => {
      expect(firstGateStep("caregiver")).toBe("caregiver_send_membership");
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
      expect(shouldRouteOnboardingToLoop({ ...base, step: "client_confirm_intake" })).toBe(false);
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

    it("caregiver loop may save the derived fields, and nothing the site's wizard doesn't collect", () => {
      for (const f of ["skills", "services", "zipCode", "street", "state", "serviceRadius", "transportDocs"]) {
        expect(isAllowedField("caregiver", f)).toBe(true);
      }
      for (const f of ["certifications", "gender", "languages", "canDrive", "bioSkipped", "jobTypes", "wantsMvr"]) {
        expect(isAllowedField("caregiver", f)).toBe(false);
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
});
