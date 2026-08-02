// Front door STAGE 2 — the pure layer: R-FD5 role × vertical re-keying, the
// childcare caregiver contract, the deferred-category refusals, and the AE21
// delta plan.
//
// SENIOR PARITY is the load-bearing half of this file. The re-keying is only
// safe if the senior contract is byte-identical, so the first block pins:
//   • every legacy `…ForRole` wrapper returns the SAME OBJECT IDENTITY as before
//     (`toBe`, not `toEqual` — a copy would break `collectionStepsForRole(role)
//     === CLIENT_COLLECTION_STEPS` style comparisons and, worse, would let the
//     senior list drift);
//   • the new vertical parameter is OPTIONAL and defaults to senior everywhere;
//   • a senior caregiver's step and field sequence is unchanged, field for field.

import { describe, it, expect, vi } from "vitest";
import {
  // legacy senior seams
  CLIENT_COLLECTION_STEPS,
  CAREGIVER_COLLECTION_STEPS,
  CLIENT_REQUIRED_FIELDS,
  CAREGIVER_REQUIRED_FIELDS,
  CLIENT_ALLOWED_FIELDS,
  CAREGIVER_ALLOWED_FIELDS,
  collectionStepsForRole,
  requiredFieldsForRole,
  allowedFieldsForRole,
  isAllowedField,
  firstGateStep,
  missingRequiredFields,
  // R-FD5 additions
  collectionStepsFor,
  requiredFieldsFor,
  allowedFieldsFor,
  caregiverJobTypesFor,
  CAREGIVER_SENIOR_JOB_TYPES,
  CAREGIVER_CHILDCARE_JOB_TYPES,
  CAREGIVER_JOB_TYPES,
  CAREGIVER_CHILDCARE_COLLECTION_STEPS,
  CAREGIVER_CHILDCARE_REQUIRED_FIELDS,
  CAREGIVER_CHILDCARE_ALLOWED_FIELDS,
  CAREGIVER_CHILDCARE_FIRST_GATE_STEP,
  CLIENT_CHILDCARE_ALLOWED_FIELDS,
  DEFAULT_ONBOARDING_VERTICAL,
} from "../onboardingContract";
import {
  CHILDCARE_CAREGIVER_AGE_BANDS,
  CHILDCARE_CAREGIVER_ENABLEABLE_AGE_BANDS,
  CHILDCARE_CAREGIVER_STEP_ENROLL,
  CHILDCARE_CAREGIVER_STEP_FIELD,
  absorbChildcareCaregiverFields,
  buildChildcareCaregiverDirective,
  buildDeferredRefusal,
  childcareCaregiverQuestion,
  childcareCaregiverStepForMissing,
  classifyExplicitYesNo,
  computeChildcareCaregiverPlan,
  normalizeChildcareAgeBands,
  normalizeChildcareServices,
  seedFromVerifiedBaseProfile,
} from "../childcareCaregiverFunnel";
import {
  DEFERRED_CHILDCARE_CATEGORIES,
  ENABLEABLE_CHILDCARE_CATEGORIES,
} from "../../childcare/jurisdictionPolicy";

// ── SENIOR PARITY (the critical deliverable) ─────────────────────────────────

describe("R-FD5 re-keying is ADDITIVE: senior is byte-identical", () => {
  it("the default vertical is senior", () => {
    expect(DEFAULT_ONBOARDING_VERTICAL).toBe("senior");
  });

  it("legacy …ForRole wrappers return the SAME object identity as before", () => {
    expect(collectionStepsForRole("client")).toBe(CLIENT_COLLECTION_STEPS);
    expect(collectionStepsForRole("caregiver")).toBe(CAREGIVER_COLLECTION_STEPS);
    expect(requiredFieldsForRole("client")).toBe(CLIENT_REQUIRED_FIELDS);
    expect(requiredFieldsForRole("caregiver")).toBe(CAREGIVER_REQUIRED_FIELDS);
    expect(allowedFieldsForRole("client")).toBe(CLIENT_ALLOWED_FIELDS);
    expect(allowedFieldsForRole("caregiver")).toBe(CAREGIVER_ALLOWED_FIELDS);
  });

  it("omitting the vertical is identical to passing 'senior'", () => {
    for (const role of ["client", "caregiver"] as const) {
      expect(collectionStepsFor(role)).toBe(collectionStepsFor(role, "senior"));
      expect(requiredFieldsFor(role)).toBe(requiredFieldsFor(role, "senior"));
      expect(allowedFieldsFor(role)).toBe(allowedFieldsFor(role, "senior"));
      expect(firstGateStep(role)).toBe(firstGateStep(role, "senior"));
    }
    expect(collectionStepsFor("caregiver")).toBe(CAREGIVER_COLLECTION_STEPS);
    expect(firstGateStep("caregiver")).toBe("caregiver_send_photo");
    expect(firstGateStep("client")).toBe("client_ask_start");
  });

  it("a null/undefined/garbage vertical still resolves to senior (never child)", () => {
    expect(collectionStepsFor("caregiver", null)).toBe(CAREGIVER_COLLECTION_STEPS);
    expect(requiredFieldsFor("caregiver", undefined)).toBe(CAREGIVER_REQUIRED_FIELDS);
    expect(isAllowedField("caregiver", "specialties", null)).toBe(true);
  });

  // The pinned senior caregiver fixture: step order and the field each step
  // collects, byte for byte. If the childcare re-keying ever leaks into the
  // senior lists, this row is what fails.
  it("PINNED senior caregiver fixture: step sequence + field sequence unchanged", () => {
    expect([...CAREGIVER_COLLECTION_STEPS]).toEqual([
      "caregiver_ask_name", "caregiver_ask_location", "caregiver_ask_story",
      "caregiver_ask_experience", "caregiver_ask_specialties", "caregiver_ask_profile",
      "caregiver_ask_availability", "caregiver_ask_job_type", "caregiver_ask_rate",
      "caregiver_ask_email", "caregiver_ask_bio",
    ]);
    expect([...CAREGIVER_REQUIRED_FIELDS]).toEqual([
      "name", "city", "yearsExperience", "specialties",
      "availability", "jobType", "hourlyRate", "email", "bio",
    ]);
    // Walk the senior gate exactly as the loop does: each answer removes exactly
    // one field, in flow order, and nothing childcare-shaped ever appears.
    const answers: Array<[string, unknown]> = [
      ["name", "Maria"], ["city", "San Jose"], ["yearsExperience", 6],
      ["specialties", ["dementia"]], ["availability", { days: ["mon"] }],
      ["jobType", "part_time"], ["hourlyRate", 28], ["email", "m@x.com"], ["bio", "I care."],
    ];
    const data: Record<string, unknown> = {};
    const seen: string[][] = [];
    for (const [field, value] of answers) {
      seen.push(missingRequiredFields("caregiver", data));
      data[field] = value;
    }
    seen.push(missingRequiredFields("caregiver", data));
    expect(seen[0]).toEqual([...CAREGIVER_REQUIRED_FIELDS]);
    expect(seen[4]).toEqual(["availability", "jobType", "hourlyRate", "email", "bio"]);
    expect(seen[9]).toEqual([]);
    expect(JSON.stringify(seen)).not.toMatch(/childcare/i);
  });

  it("senior job types are EXACTLY the original three (no childcare leakage)", () => {
    expect([...CAREGIVER_SENIOR_JOB_TYPES].sort()).toEqual(["full_time", "occasional", "part_time"]);
    expect([...caregiverJobTypesFor("senior")].sort()).toEqual(["full_time", "occasional", "part_time"]);
    expect([...caregiverJobTypesFor()].sort()).toEqual(["full_time", "occasional", "part_time"]);
    for (const t of ["nanny", "babysitter", "after_school"]) {
      expect(CAREGIVER_SENIOR_JOB_TYPES.has(t)).toBe(false);
    }
  });

  it("CAREGIVER_JOB_TYPES gains the childcare types as a UNION (R-FD5)", () => {
    for (const t of CAREGIVER_SENIOR_JOB_TYPES) expect(CAREGIVER_JOB_TYPES.has(t)).toBe(true);
    for (const t of CAREGIVER_CHILDCARE_JOB_TYPES) expect(CAREGIVER_JOB_TYPES.has(t)).toBe(true);
    expect([...CAREGIVER_JOB_TYPES].sort()).toEqual(
      ["after_school", "babysitter", "full_time", "nanny", "occasional", "part_time"],
    );
  });

  it("the senior allowed-field set gains NOTHING childcare-shaped", () => {
    for (const f of [...CAREGIVER_ALLOWED_FIELDS]) expect(f).not.toMatch(/^childcare/);
    expect(isAllowedField("caregiver", "childcareAgeBands")).toBe(false);
    expect(isAllowedField("caregiver", "yearsChildcareExperience")).toBe(false);
  });
});

// ── The childcare caregiver contract ────────────────────────────────────────

describe("childcare caregiver contract (R-FD5 / R-FD6)", () => {
  it("shares the BASE steps and adds only childcare-delta steps", () => {
    expect([...CAREGIVER_CHILDCARE_COLLECTION_STEPS]).toEqual([
      "caregiver_ask_name",
      "caregiver_ask_location",
      "caregiver_ask_childcare_experience",
      "caregiver_ask_childcare_ages",
      "caregiver_ask_childcare_services",
      "caregiver_ask_childcare_credentials",
      "caregiver_ask_childcare_transport",
      "caregiver_ask_availability",
      "caregiver_ask_job_type",
      "caregiver_ask_rate",
      "caregiver_ask_email",
      "caregiver_ask_bio",
    ]);
    // Shared base steps are the SAME identifiers the senior funnel uses — that
    // identity is what makes AE21 mechanical.
    for (const shared of [
      "caregiver_ask_name", "caregiver_ask_location", "caregiver_ask_availability",
      "caregiver_ask_job_type", "caregiver_ask_rate", "caregiver_ask_email", "caregiver_ask_bio",
    ]) {
      expect(CAREGIVER_COLLECTION_STEPS).toContain(shared);
      expect(CAREGIVER_CHILDCARE_COLLECTION_STEPS).toContain(shared);
    }
    // Senior-only steps are absent.
    for (const seniorOnly of ["caregiver_ask_story", "caregiver_ask_experience", "caregiver_ask_specialties", "caregiver_ask_profile"]) {
      expect(CAREGIVER_CHILDCARE_COLLECTION_STEPS).not.toContain(seniorOnly);
    }
  });

  it("reuses the shared base FIELDS and never duplicates them", () => {
    for (const shared of ["name", "city", "availability", "jobType", "hourlyRate", "email", "bio"]) {
      expect(CAREGIVER_CHILDCARE_REQUIRED_FIELDS).toContain(shared);
    }
    // No childcare-prefixed duplicate of a shared base field exists.
    for (const dup of ["childcareName", "childcareCity", "childcareEmail", "childcareBio", "childcareAvailability", "childcareHourlyRate"]) {
      expect(CAREGIVER_CHILDCARE_ALLOWED_FIELDS.has(dup)).toBe(false);
    }
  });

  it("cannot write a SENIOR vertical field (R24/R-FD6 — no bleed)", () => {
    for (const seniorField of ["specialties", "yearsExperience", "skills", "services", "certifications"]) {
      expect(isAllowedField("caregiver", seniorField, "child")).toBe(false);
    }
  });

  it("R-FD4: a childcare CLIENT can collect NOTHING over the conversation", () => {
    expect(collectionStepsFor("client", "child")).toEqual([]);
    expect(requiredFieldsFor("client", "child")).toEqual([]);
    expect(CLIENT_CHILDCARE_ALLOWED_FIELDS.size).toBe(0);
    for (const childDetail of ["childName", "childAge", "age", "seniorName", "dob", "school", "address"]) {
      expect(isAllowedField("client", childDetail, "child")).toBe(false);
    }
  });

  it("firstGateStep(child) is the enrollment handoff, not an upload gate", () => {
    expect(firstGateStep("caregiver", "child")).toBe(CAREGIVER_CHILDCARE_FIRST_GATE_STEP);
    expect(firstGateStep("caregiver", "child")).toBe("childcare_caregiver_enroll");
    expect(firstGateStep("caregiver", "child")).not.toBe(firstGateStep("caregiver"));
  });

  it("adultAgeAttested only counts when explicitly TRUE (an attestation, not a value)", () => {
    const base = {
      name: "A", city: "San Jose", yearsChildcareExperience: 3,
      childcareAgeBands: ["toddler"], childcareServices: ["babysitting"],
      childcareTransport: false, availability: { days: ["mon"] }, jobType: "part_time",
      hourlyRate: 25, email: "a@b.com", bio: "hi",
    };
    expect(missingRequiredFields("caregiver", base, "child")).toEqual(["adultAgeAttested"]);
    expect(missingRequiredFields("caregiver", { ...base, adultAgeAttested: false }, "child")).toEqual(["adultAgeAttested"]);
    expect(missingRequiredFields("caregiver", { ...base, adultAgeAttested: true }, "child")).toEqual([]);
  });

  it("a transport NO satisfies the transport gate (asked once, never blocking — AE13)", () => {
    const partial = { name: "A", city: "San Jose", yearsChildcareExperience: 3, childcareAgeBands: ["toddler"], childcareServices: ["babysitting"], adultAgeAttested: true };
    expect(missingRequiredFields("caregiver", partial, "child")).toContain("childcareTransport");
    expect(missingRequiredFields("caregiver", { ...partial, childcareTransport: false }, "child"))
      .not.toContain("childcareTransport");
  });

  it("every required field maps to a step, and every step maps to a field", () => {
    for (const field of CAREGIVER_CHILDCARE_REQUIRED_FIELDS) {
      expect(Object.values(CHILDCARE_CAREGIVER_STEP_FIELD)).toContain(field);
    }
    for (const step of CAREGIVER_CHILDCARE_COLLECTION_STEPS) {
      expect(CHILDCARE_CAREGIVER_STEP_FIELD[step]).toBeTruthy();
      expect(childcareCaregiverQuestion(step)).toBeTruthy();
    }
  });

  it("the missing-field walk asks in flow order and ends at the enrollment gate", () => {
    const data: Record<string, unknown> = {};
    const steps: string[] = [];
    const answers: Array<[string, unknown]> = [
      ["name", "Ana"], ["city", "San Jose"], ["yearsChildcareExperience", 4],
      ["childcareAgeBands", ["toddler"]], ["childcareServices", ["babysitting"]],
      ["adultAgeAttested", true], ["childcareTransport", true],
      ["availability", { days: ["mon"] }], ["jobType", "part_time"],
      ["hourlyRate", 26], ["email", "ana@x.com"], ["bio", "Kids love me."],
    ];
    for (const [f, v] of answers) {
      steps.push(childcareCaregiverStepForMissing(missingRequiredFields("caregiver", data, "child")));
      data[f] = v;
    }
    expect(steps).toEqual([...CAREGIVER_CHILDCARE_COLLECTION_STEPS]);
    expect(childcareCaregiverStepForMissing(missingRequiredFields("caregiver", data, "child")))
      .toBe(CHILDCARE_CAREGIVER_STEP_ENROLL);
  });
});

// ── Deferred categories (the U1 hard block, at the conversation) ─────────────

describe("deferred categories are REFUSED, not silently dropped", () => {
  it("INFANT is refused as an age band and maps to the deferred infant_care category", () => {
    const split = normalizeChildcareAgeBands(["infant", "toddler", "teen"]);
    expect(split.accepted).toEqual(["toddler", "teen"]);
    expect(split.refusedCategories).toEqual(["infant_care"]);
    expect(CHILDCARE_CAREGIVER_ENABLEABLE_AGE_BANDS).not.toContain("infant");
  });

  it("newborn / baby / '0-1' all resolve to the refused infant band", () => {
    for (const phrase of ["newborn", "babies", "baby", "0-1"]) {
      const split = normalizeChildcareAgeBands([phrase]);
      expect(split.accepted).toEqual([]);
      expect(split.refusedCategories).toEqual(["infant_care"]);
    }
  });

  it("every DEFERRED service category is refused; every ENABLEABLE one is accepted", () => {
    for (const c of DEFERRED_CHILDCARE_CATEGORIES) {
      const split = normalizeChildcareServices([c]);
      expect(split.accepted).toEqual([]);
      expect(split.refusedCategories).toEqual([c]);
    }
    for (const c of ENABLEABLE_CHILDCARE_CATEGORIES) {
      expect(normalizeChildcareServices([c]).accepted).toEqual([c]);
    }
  });

  it("free-text spellings map onto the right side of the line", () => {
    const split = normalizeChildcareServices("nanny, overnights, after school, meds");
    expect(split.accepted).toEqual(["nanny_care", "after_school_care"]);
    expect(split.refusedCategories.sort()).toEqual(["medication_administration", "overnight_care"]);
  });

  it("unknown values fail closed (dropped and reported, never stored)", () => {
    const split = normalizeChildcareServices(["tutoring calculus"]);
    expect(split.accepted).toEqual([]);
    expect(split.refusedCategories).toEqual([]);
    expect(split.unrecognized).toEqual(["tutoring calculus"]);
  });

  it("the refusal copy names the category, promises nothing, and keeps the rest", () => {
    const msg = buildDeferredRefusal(["infant_care"]);
    expect(msg).toMatch(/infants/i);
    expect(msg).toMatch(/doesn't offer/i);
    expect(msg).not.toMatch(/soon|next month|coming|will be able/i);
    expect(msg).toMatch(/Everything else you do, I can/);
    expect(buildDeferredRefusal([])).toBe("");
    expect(buildDeferredRefusal(["babysitting"])).toBe(""); // enableable → not a refusal
  });

  it("age bands stay in canonical order regardless of how they were said", () => {
    expect(normalizeChildcareAgeBands(["teen", "toddler", "preteen"]).accepted)
      .toEqual(["toddler", "preteen", "teen"]);
    expect(CHILDCARE_CAREGIVER_AGE_BANDS).toEqual(
      ["infant", "toddler", "preschool", "school_age", "preteen", "teen"],
    );
  });
});

// ── AE21: the delta plan ─────────────────────────────────────────────────────

describe("AE21 delta reuse — an existing caregiver is never re-asked base work", () => {
  const seniorCaregiver = {
    name: "Maria Lopez",
    city: "San Jose",
    email: "maria@example.com",
    availability: { days: ["mon", "tue"], hours: "mornings" },
    jobType: "part_time",
    hourlyRate: 30,
    bio: "Six years with dementia clients.",
    // Senior-side state that must NEVER be read as childcare capability:
    verificationStatus: "verified",
    onboardingStatus: "profile_complete",
    rating: 4.9,
    specialties: ["dementia"],
  };

  it("seeds every shared base field from the verified profile", () => {
    const { seeded, reusedBaseFields } = seedFromVerifiedBaseProfile(seniorCaregiver, {});
    expect(reusedBaseFields.sort()).toEqual(
      ["availability", "bio", "city", "email", "hourlyRate", "jobType", "name"],
    );
    expect(seeded.name).toBe("Maria Lopez");
    expect(seeded.hourlyRate).toBe(30);
    // Senior approval/ratings are NOT seeded — they are not base work, they are
    // senior VERDICTS, and R-FD6 forbids copying them across (no bleed).
    expect(seeded.verificationStatus).toBeUndefined();
    expect(seeded.rating).toBeUndefined();
    expect(seeded.specialties).toBeUndefined();
  });

  it("the delta plan asks ONLY the childcare questions", () => {
    const plan = computeChildcareCaregiverPlan({ caregiverDoc: seniorCaregiver, collected: {} });
    expect(plan.deltaOnly).toBe(true);
    expect(plan.missing).toEqual([
      "yearsChildcareExperience", "childcareAgeBands", "childcareServices",
      "adultAgeAttested", "childcareTransport",
    ]);
    for (const neverAgain of ["name", "city", "email", "bio", "availability", "jobType", "hourlyRate"]) {
      expect(plan.missing).not.toContain(neverAgain);
    }
    expect(plan.step).toBe("caregiver_ask_childcare_experience");
  });

  it("a BRAND-NEW caregiver does base-then-delta, starting at the name", () => {
    const plan = computeChildcareCaregiverPlan({ caregiverDoc: null, collected: {} });
    expect(plan.deltaOnly).toBe(false);
    expect(plan.reusedBaseFields).toEqual([]);
    expect(plan.missing).toEqual([...CAREGIVER_CHILDCARE_REQUIRED_FIELDS]);
    expect(plan.step).toBe("caregiver_ask_name");
  });

  it("an in-progress vertical profile is also never re-asked (resume)", () => {
    const plan = computeChildcareCaregiverPlan({
      caregiverDoc: seniorCaregiver,
      verticalProfile: {
        ageBands: ["toddler", "preschool"],
        services: ["babysitting"],
        yearsChildcareExperience: 5,
        adultAgeAttested: true,
      },
      collected: {},
    });
    expect(plan.missing).toEqual(["childcareTransport"]);
    expect(plan.step).toBe("caregiver_ask_childcare_transport");
  });

  it("collection completes at the enrollment gate", () => {
    const plan = computeChildcareCaregiverPlan({
      caregiverDoc: seniorCaregiver,
      collected: {
        yearsChildcareExperience: 5, childcareAgeBands: ["toddler"],
        childcareServices: ["nanny_care"], adultAgeAttested: true, childcareTransport: true,
      },
    });
    expect(plan.collectionComplete).toBe(true);
    expect(plan.step).toBe(CHILDCARE_CAREGIVER_STEP_ENROLL);
  });

  it("the directive tells the model the base work is DONE on a delta run", () => {
    const delta = buildChildcareCaregiverDirective(
      computeChildcareCaregiverPlan({ caregiverDoc: seniorCaregiver, collected: {} }),
    );
    expect(delta).toMatch(/ALREADY AN EVIA CAREGIVER/);
    expect(delta).toMatch(/NEVER ask for any of them again/);
    expect(delta).toMatch(/do NOT ask again/); // the known-field checklist
    // The hard rules are always present, on both paths.
    for (const directive of [
      delta,
      buildChildcareCaregiverDirective(computeChildcareCaregiverPlan({ caregiverDoc: null, collected: {} })),
    ]) {
      expect(directive).toMatch(/NEVER ask about a specific child/);
      expect(directive).toMatch(/NEVER say they are approved/);
      expect(directive).toMatch(/does NOT offer infant care/);
    }
    const fresh = buildChildcareCaregiverDirective(
      computeChildcareCaregiverPlan({ caregiverDoc: null, collected: {} }),
    );
    expect(fresh).not.toMatch(/ALREADY AN EVIA CAREGIVER/);
  });
});

// ── Extraction: closed field set + deferred detection ────────────────────────

describe("absorbChildcareCaregiverFields", () => {
  const parseOf = (payload: unknown) => vi.fn(async () => JSON.stringify(payload));

  it("keeps allowlisted childcare fields and canonicalizes them", async () => {
    const { fields } = await absorbChildcareCaregiverFields(
      "I've nannied 6 years, toddlers and school age, part time, $28/hr, ana@x.com",
      {},
      {
        parse: parseOf({
          yearsChildcareExperience: 6,
          childcareAgeBands: ["toddler", "school_age"],
          childcareServices: ["nanny_care"],
          jobType: "Part Time",
          hourlyRate: 28,
          email: "ana@x.com",
        }),
      },
    );
    expect(fields).toEqual({
      yearsChildcareExperience: 6,
      childcareAgeBands: ["toddler", "school_age"],
      childcareServices: ["nanny_care"],
      jobType: "part_time",
      hourlyRate: 28,
      email: "ana@x.com",
    });
  });

  it("AE19: a field outside the childcare closed set is DROPPED", async () => {
    const { fields } = await absorbChildcareCaregiverFields("whatever", {}, {
      parse: parseOf({
        // Injection attempts and senior fields alike:
        approval: "approved", approvalState: "approved", verificationStatus: "verified",
        careVertical: "senior", userType: "admin", isAdmin: true,
        screeningConsent: true, evidenceStatus: "clear",
        specialties: ["dementia"], yearsExperience: 9,
        // ...and one legitimate field, to prove the filter is selective.
        childcareAgeBands: ["teen"],
      }),
    });
    expect(fields).toEqual({ childcareAgeBands: ["teen"] });
  });

  it("reports deferred categories separately so they can be refused out loud", async () => {
    const { fields, refusedCategories } = await absorbChildcareCaregiverFields("I do infants and overnights", {}, {
      parse: parseOf({ childcareAgeBands: ["infant", "toddler"], childcareServices: ["overnight_care", "babysitting"] }),
    });
    expect(fields.childcareAgeBands).toEqual(["toddler"]);
    expect(fields.childcareServices).toEqual(["babysitting"]);
    expect(refusedCategories.sort()).toEqual(["infant_care", "overnight_care"]);
  });

  it("never overwrites an already-collected field (only ever adds)", async () => {
    const { fields } = await absorbChildcareCaregiverFields("ana", { name: "Ana", hourlyRate: 30 }, {
      parse: parseOf({ name: "WRONG", hourlyRate: 999, city: "San Jose" }),
    });
    expect(fields).toEqual({ city: "San Jose" });
  });

  it("adultAgeAttested:false is preserved (a refusal must be visible)", async () => {
    const { fields } = await absorbChildcareCaregiverFields("I'm 16", { adultAgeAttested: undefined }, {
      parse: parseOf({ adultAgeAttested: false }),
    });
    expect(fields.adultAgeAttested).toBe(false);
  });

  it("a model failure or garbage output yields {} (the scripted question still goes out)", async () => {
    for (const raw of ["__parse_error__", "", "not json at all", "{oops"]) {
      const { fields, refusedCategories } = await absorbChildcareCaregiverFields("hi", {}, {
        parse: vi.fn(async () => raw),
      });
      expect(fields).toEqual({});
      expect(refusedCategories).toEqual([]);
    }
    const thrown = await absorbChildcareCaregiverFields("hi", {}, {
      parse: vi.fn(async () => { throw new Error("model down"); }),
    });
    expect(thrown.fields).toEqual({});
  });

  it("rejects a non-childcare jobType and a malformed email", async () => {
    const { fields } = await absorbChildcareCaregiverFields("x", {}, {
      parse: parseOf({ jobType: "weekends only", email: "not-an-email" }),
    });
    expect(fields).toEqual({});
  });
});

describe("classifyExplicitYesNo (money/consent = explicit binary)", () => {
  it("accepts clear affirmatives and refusals", () => {
    for (const yes of ["yes", "Yes!", "yep", "sure", "go ahead", "start it", "I consent", "ok"]) {
      expect(classifyExplicitYesNo(yes)).toBe("yes");
    }
    for (const no of ["no", "nope", "not now", "no thanks", "rather not"]) {
      expect(classifyExplicitYesNo(no)).toBe("no");
    }
  });
  it("is unclear on anything ambiguous (never guesses consent)", () => {
    for (const other of ["", "what does it cost?", "hmm", "maybe later on?"]) {
      expect(classifyExplicitYesNo(other)).toBe("unclear");
    }
  });
});
