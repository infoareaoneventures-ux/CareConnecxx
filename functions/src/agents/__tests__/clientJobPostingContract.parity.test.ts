import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildJobPostingsDoc,
  buildCarePlanLocationEntry,
  upsertCarePlanLocationPool,
  buildSeniorProfileWizardFields,
  mapCareFrequencyToWizardValue,
  mapTimeOfDayToWizardValues,
  parseRate,
  normalizeStartDateToISO,
  formatWizardPhone,
  mapJobPostingsDocToOnboardingData,
  mapUsersDocToOnboardingData,
} from "../clientJobPostingContract";
import { businessTodayStr } from "../../utils/scheduledTime";

// Guards the fix from docs/plans (session: make Evia write job_postings/carePlans
// in the same shape as the web wizard). We can't literally invoke the browser's
// createJobPosting (services/api.ts) from a backend test without deep-mocking
// the Firebase client SDK it depends on, which nothing in this repo does today
// (no test imports services/api.ts) — so this test instead pins the EXACT
// field list documented directly from reading services/api.ts's WizardForm/
// createJobPosting source this session, and asserts every one of those fields
// is a key clientJobPostingContract.ts's builder actually produces. If the
// wizard's field set ever changes, update WIZARD_JOB_POSTINGS_FIELDS here to
// match (re-reading services/api.ts), which will fail this test until the
// backend builder is updated too — that's the point.

// Every field WizardForm (ClientJobPostingWizard.tsx) collects, that
// createJobPosting (services/api.ts) writes onto job_postings/{uid}.
// Excludes `neighborhood` — declared in WizardForm's type/initial state but
// never actually collected by any step in the wizard's UI (verified by
// grepping ClientJobPostingWizard.tsx: only 2 matches, the type decl and the
// initial state — no input anywhere sets it).
const WIZARD_JOB_POSTINGS_FIELDS = [
  "careFrequency",
  "street", "zipCode", "city", "state",
  "startDate", "endDate", "ongoing", "daysFlexible", "selectedDays", "timeOfDay",
  // Renamed from "photoURL" (Hamse, 2026-08-23): the signup photo is the
  // ACCOUNT HOLDER's own photo (mirrored to users/{uid} by the caller), and
  // only lands on this recipient-facing field when relationship is "myself"
  // — see the dedicated describe block below.
  "careRecipientPhotoURL",
  "careRecipientFirstName", "careRecipientLastName", "careRecipientAge",
  "adultsCount", "caregiversNeeded", "additionalRecipients",
  "relationship",
  "emergencyFirstName", "emergencyLastName", "emergencyPhone", "emergencyRelationship",
  "careNeeds", "petsInHome", "smokingHousehold",
  "rate", "rateFlexible", "paymentMethod",
  "jobDescription",
  "clientId", "status",
] as const;

describe("clientJobPostingContract — parity with the web wizard's job_postings shape", () => {
  it("buildJobPostingsDoc produces every field name the wizard's createJobPosting writes", () => {
    const doc = buildJobPostingsDoc("uid-1", "+15551234567", {
      careFrequency: "part_time",
      street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111",
      startDate: "2099-09-01", selectedDays: ["MON", "WED", "FRI"], timeOfDay: "morning",
      relationship: "daughter",
      seniorName: "Dorothy Smith", age: 82,
      emergencyContactName: "Jane Doe", emergencyContactPhone: "+15550001111", emergencyContactRelationship: "granddaughter",
      careNeeds: ["companionship", "meal prep"],
      petsInHome: true, smokingHousehold: false,
      rate: 26, paymentMethod: "credit_card",
      jobDescription: "Warm, patient caregiver needed.",
    });

    const keys = new Set(Object.keys(doc));
    const missing = WIZARD_JOB_POSTINGS_FIELDS.filter((f) => !keys.has(f));
    expect(missing, "buildJobPostingsDoc is missing wizard field(s) — schema drifted").toEqual([]);
  });

  it("splits seniorName/emergencyContactName the same way the wizard's separate first/last inputs do", () => {
    const doc = buildJobPostingsDoc("uid-1", "+1", { seniorName: "Dorothy Anne Smith", emergencyContactName: "Jane Doe" });
    expect(doc.careRecipientFirstName).toBe("Dorothy");
    expect(doc.careRecipientLastName).toBe("Anne Smith");
    expect(doc.emergencyFirstName).toBe("Jane");
    expect(doc.emergencyLastName).toBe("Doe");
  });

  it("rate is a number > 0 and rateFlexible is always false — the wizard has NO 'flexible' option at signup", () => {
    expect(parseRate(26)).toEqual({ rate: 26, rateFlexible: false });
    expect(parseRate("26")).toEqual({ rate: 26, rateFlexible: false });
    expect(parseRate("flexible")).toEqual({ rateFlexible: false });
    expect(parseRate("flexible").rate).toBeUndefined();
    expect(parseRate(undefined)).toEqual({ rateFlexible: false });
    expect(buildJobPostingsDoc("uid-1", "+1", { rate: "flexible" }).rateFlexible).toBe(false);
  });

  it("never writes careLevel — the wizard doesn't (WhatsNext.tsx falls back to 'moderate')", () => {
    const doc = buildJobPostingsDoc("uid-1", "+1", { careNeeds: ["Dementia / Memory Care"] }) as unknown as Record<string, unknown>;
    expect(doc).not.toHaveProperty("careLevel");
    expect(doc).not.toHaveProperty("conditions");
  });

  describe("startDate → the wizard's ISO yyyy-mm-dd", () => {
    const today = businessTodayStr();
    it("ASAP / now / soon → today", () => {
      expect(normalizeStartDateToISO("ASAP")).toBe(today);
      expect(normalizeStartDateToISO("asap!")).toBe(today);
      expect(normalizeStartDateToISO("now")).toBe(today);
      expect(normalizeStartDateToISO("soon")).toBe(today);
      expect(normalizeStartDateToISO("right away")).toBe(today);
    });
    it("keeps a future ISO date, clamps a past one to today like the wizard's date input", () => {
      expect(normalizeStartDateToISO("2099-06-01")).toBe("2099-06-01");
      expect(normalizeStartDateToISO("2099-06-01T00:00:00Z")).toBe("2099-06-01");
      expect(normalizeStartDateToISO("2020-01-01")).toBe(today);
    });
    it("returns null for free text (caller resolves via the model, else re-asks)", () => {
      expect(normalizeStartDateToISO("next Monday")).toBeNull();
      expect(normalizeStartDateToISO("")).toBeNull();
      expect(normalizeStartDateToISO(undefined)).toBeNull();
    });
    it("buildJobPostingsDoc always emits ISO (ASAP → today; unparseable → today)", () => {
      expect(buildJobPostingsDoc("uid-1", "+1", { startDate: "ASAP" }).startDate).toBe(today);
      expect(buildJobPostingsDoc("uid-1", "+1", { startDate: "2099-02-03" }).startDate).toBe("2099-02-03");
      expect(buildJobPostingsDoc("uid-1", "+1", {}).startDate).toBe(today);
    });
  });

  describe("emergency phone → the wizard's (555) 000-0000 shape with its >=10-digit check", () => {
    it("formats 10 digits (dropping a leading US country code)", () => {
      expect(formatWizardPhone("4085551234")).toBe("(408) 555-1234");
      expect(formatWizardPhone("+1 408-555-1234")).toBe("(408) 555-1234");
      expect(formatWizardPhone("(408) 555-1234")).toBe("(408) 555-1234");
    });
    it("rejects fewer than 10 digits", () => {
      expect(formatWizardPhone("555-1234")).toBeUndefined();
      expect(formatWizardPhone("")).toBeUndefined();
      expect(formatWizardPhone(undefined)).toBeUndefined();
    });
    it("buildJobPostingsDoc writes the formatted phone", () => {
      expect(buildJobPostingsDoc("uid-1", "+1", { emergencyContactPhone: "4085551234" }).emergencyPhone).toBe("(408) 555-1234");
      expect(buildJobPostingsDoc("uid-1", "+1", { emergencyContactPhone: "1234" }).emergencyPhone).toBeUndefined();
    });
  });

  describe("senior_profiles fields — createJobPosting's profileUpdate, field for field", () => {
    it("splits the name, counts adults, builds 'City, ST' and carries zip/age/relationship; no diagnoses", () => {
      const f = buildSeniorProfileWizardFields({
        seniorName: "Dorothy Anne Smith", city: "San Jose", state: "CA", zipCode: "95111", age: 82, relationship: "self",
        careNeeds: ["Companionship"], selectedDays: ["MON"],
        additionalRecipients: [{ name: "Frank", relationship: "father" }],
      }) as unknown as Record<string, unknown>;
      expect(f).toMatchObject({
        name: "Dorothy Anne Smith", firstName: "Dorothy", lastName: "Anne Smith", adultsCount: 2,
        location: "San Jose, CA", zipCode: "95111", age: 82, relationship: "myself",
        careNeeds: ["Companionship"], needs: ["Companionship"], scheduleNeeded: ["MON"],
      });
      expect(f).not.toHaveProperty("diagnoses");
    });
    it("omits location when city or state is missing (wizard writes it only with both)", () => {
      expect(buildSeniorProfileWizardFields({ city: "San Jose" })).not.toHaveProperty("location");
    });
  });

  it("careFrequency maps Evia's enum onto the wizard's own stored values", () => {
    expect(mapCareFrequencyToWizardValue("occasional")).toBe("specific");
    expect(mapCareFrequencyToWizardValue("part_time")).toBe("part-time");
    expect(mapCareFrequencyToWizardValue("full_time")).toBe("full-time");
  });

  it("timeOfDay uses the wizard's lowercase values, not the capitalized job_posts slot enum", () => {
    expect(mapTimeOfDayToWizardValues("mornings and afternoons")).toEqual(["morning", "afternoon"]);
    expect(mapTimeOfDayToWizardValues(["Morning", "Overnight"])).toEqual(["morning", "overnight"]);
  });

  it("carePlans location entry is createJobPosting's shape (street/city/state/zip/pets/smoking) plus lat/lng — no Evia-only `primary` marker", () => {
    const entry = buildCarePlanLocationEntry({
      street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111",
      petsInHome: true, smokingHousehold: false,
    }, { lat: 37.3, lng: -121.9 });
    expect(entry).toEqual({
      street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111",
      petsInHome: true, smokingHousehold: false, lat: 37.3, lng: -121.9,
    });
    expect(entry).not.toHaveProperty("primary");
  });

  describe("upsertCarePlanLocationPool — createJobPosting's locationPoolUpdate", () => {
    const entry = buildCarePlanLocationEntry({ street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111", petsInHome: true }, { lat: 1, lng: 2 });
    it("appends when no entry matches street+zip, keeping the rest of the pool", () => {
      const pool = upsertCarePlanLocationPool([{ street: "9 Elm", zipCode: "95008", petsInHome: false, smokingHousehold: false }], entry)!;
      expect(pool).toHaveLength(2);
      expect(pool[1]).toEqual({ street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111", petsInHome: true, smokingHousehold: false, lat: 1, lng: 2 });
    });
    it("updates the matching entry in place (case-insensitive street, same zip) instead of duplicating", () => {
      const pool = upsertCarePlanLocationPool([{ street: "123 MAIN st", city: "San Jose", zipCode: "95111", petsInHome: false, smokingHousehold: true }], entry)!;
      expect(pool).toHaveLength(1);
      expect(pool[0]).toEqual({ street: "123 MAIN st", city: "San Jose", zipCode: "95111", petsInHome: true, smokingHousehold: false, lat: 1, lng: 2 });
    });
    it("returns null (pool untouched) when the entry has no street", () => {
      expect(upsertCarePlanLocationPool([{ street: "9 Elm" }], buildCarePlanLocationEntry({ city: "San Jose", zipCode: "95111" }))).toBeNull();
    });
    it("starts a pool from nothing", () => {
      expect(upsertCarePlanLocationPool(undefined, entry)).toHaveLength(1);
    });
  });

  it("careRecipientPhotoURL is set only for self-care (relationship 'myself') — otherwise the recipient's photo is set later via CarePlan", () => {
    const selfDoc = buildJobPostingsDoc("uid-1", "+1", {
      relationship: "self", careRecipientPhotoURL: "https://example.com/photo.jpg",
    });
    expect(selfDoc.careRecipientPhotoURL).toBe("https://example.com/photo.jpg");

    const otherDoc = buildJobPostingsDoc("uid-1", "+1", {
      relationship: "daughter", careRecipientPhotoURL: "https://example.com/photo.jpg",
    });
    expect(otherDoc.careRecipientPhotoURL).toBeUndefined();
  });

  it("sanity check: the excluded field list is still accurate (fails loudly if the wizard starts collecting neighborhood)", () => {
    const wizardSrc = fs.readFileSync(
      path.resolve(__dirname, "../../../../components/client/ClientJobPostingWizard.tsx"),
      "utf8",
    );
    const neighborhoodMatches = wizardSrc.match(/neighborhood/g) ?? [];
    // Only the type declaration + initial state today. A 3rd occurrence means
    // a step now collects it — add "neighborhood" back to
    // WIZARD_JOB_POSTINGS_FIELDS and to clientJobPostingContract.ts.
    expect(neighborhoodMatches.length, "wizard now references 'neighborhood' somewhere new — re-check whether it's collected and update this contract").toBeLessThanOrEqual(2);
  });
});

// Cross-channel sync (2026-09-06): a client who completes some or all of
// setup on the website should never have Evia keep asking about the same
// fields over SMS. These guard the reverse direction — live job_postings/
// users docs mapped back into Evia's onboardingData shape.
describe("clientJobPostingContract — reverse mapping (site → Evia onboardingData)", () => {
  it("maps a fully-completed job_postings doc back to onboardingData field names", () => {
    const doc = buildJobPostingsDoc("uid-1", "+15551234567", {
      careFrequency: "part_time",
      street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111",
      startDate: "2099-09-01", selectedDays: ["MON", "WED", "FRI"], timeOfDay: "morning",
      relationship: "daughter",
      seniorName: "Dorothy Smith", age: 82,
      additionalRecipients: [{ name: "Frank Smith", relationship: "father", age: 85 }],
      emergencyContactName: "Jane Doe", emergencyContactPhone: "+15550001111", emergencyContactRelationship: "granddaughter",
      careNeeds: ["companionship", "meal prep"],
      petsInHome: true, smokingHousehold: false,
      rate: 26, caregiversNeeded: 2,
      jobDescription: "Warm, patient caregiver needed.",
    });

    const back = mapJobPostingsDocToOnboardingData(doc as unknown as Record<string, unknown>);

    expect(back.careFrequency).toBe("part_time");
    expect(back.street).toBe("123 Main St");
    expect(back.zipCode).toBe("95111");
    expect(back.startDate).toBe("2099-09-01");
    expect(back.selectedDays).toEqual(["MON", "WED", "FRI"]);
    expect(back.timeOfDay).toBe("morning");
    expect(back.relationship).toBe("daughter");
    expect(back.seniorName).toBe("Dorothy Smith");
    expect(back.age).toBe("82");
    expect(back.additionalRecipients).toEqual([{ name: "Frank Smith", relationship: "father", age: "85" }]);
    expect(back.emergencyContactName).toBe("Jane Doe");
    expect(back.emergencyContactPhone).toBe("(555) 000-1111"); // the wizard's own stored shape round-trips
    expect(back.emergencyContactRelationship).toBe("granddaughter");
    expect(back.careNeeds).toEqual(["companionship", "meal prep"]);
    expect(back.petsInHome).toBe(true);
    expect(back.smokingHousehold).toBe(false);
    expect(back.rate).toBe(26);
    expect(back.caregiversNeeded).toBe(2);
    expect(back.jobDescription).toBe("Warm, patient caregiver needed.");
  });

  it("maps relationship 'myself' back to Evia's self sentinel; a legacy rateFlexible doc maps back to NO rate (never the string 'flexible')", () => {
    const doc = buildJobPostingsDoc("uid-1", "+1", { relationship: "self", rate: "flexible" });
    const back = mapJobPostingsDocToOnboardingData(doc as unknown as Record<string, unknown>);
    expect(back.relationship).toBe("self");
    expect(back).not.toHaveProperty("rate");
    expect(mapJobPostingsDocToOnboardingData({ rateFlexible: true })).not.toHaveProperty("rate");
  });

  it("returns an empty object for a null/missing doc, never throws", () => {
    expect(mapJobPostingsDocToOnboardingData(null)).toEqual({});
    expect(mapJobPostingsDocToOnboardingData(undefined)).toEqual({});
  });

  it("maps users/{uid}'s own address + email to Evia's home*/email field names", () => {
    const back = mapUsersDocToOnboardingData({
      street: "456 Oak Ave", city: "Austin", state: "TX", zipCode: "78701",
      email: "hamse143@gmail.com",
    });
    expect(back).toEqual({
      homeStreet: "456 Oak Ave", homeCity: "Austin", homeState: "TX", homeZipCode: "78701",
      email: "hamse143@gmail.com",
    });
  });

  it("returns an empty object for a null/missing users doc, never throws", () => {
    expect(mapUsersDocToOnboardingData(null)).toEqual({});
    expect(mapUsersDocToOnboardingData(undefined)).toEqual({});
  });
});
