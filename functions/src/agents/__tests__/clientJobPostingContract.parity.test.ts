import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildJobPostingsDoc,
  buildCarePlanLocationEntry,
  mapCareFrequencyToWizardValue,
  mapTimeOfDayToWizardValues,
  parseRate,
} from "../clientJobPostingContract";

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
      startDate: "2026-09-01", selectedDays: ["MON", "WED", "FRI"], timeOfDay: "morning",
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

  it("rate is a number with a separate rateFlexible flag, never the string 'flexible' — matches the wizard's number|undefined type", () => {
    expect(parseRate(26)).toEqual({ rate: 26, rateFlexible: false });
    expect(parseRate("flexible")).toEqual({ rateFlexible: true });
    expect(parseRate("flexible").rate).toBeUndefined();
    expect(parseRate(undefined)).toEqual({ rateFlexible: false });
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

  it("carePlans location entry carries the union of fields either channel needs (street/state AND pets/smoking together)", () => {
    const entry = buildCarePlanLocationEntry({
      street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111",
      petsInHome: true, smokingHousehold: false,
    });
    expect(entry).toMatchObject({
      street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95111",
      petsInHome: true, smokingHousehold: false, primary: true,
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
