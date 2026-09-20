import { describe, it, expect } from "vitest";
import { buildOnboardingDirective } from "../onboardingDirective";
import { buildCaregiverOnboardingDirective, CAREGIVER_FIELD_LABEL } from "../caregiverOnboardingDirective";
import { CAREGIVER_REQUIRED_FIELDS } from "../onboardingContract";
import { FALLBACK_RANGE } from "../../utils/marketRateRange";
import { caregiverAnnualDisplay } from "../../config/pricing";

// Mirrors onboardingDirective.test.ts for the caregiver role: same tone
// contract, same tool mechanics, plus the caregiver-specific gate-handoff
// block (photo -> documents -> MVR consent -> membership -> Checkr -> Stripe
// Connect must be described as NOT the loop's to run).

const BANNED = [
  "i'm here to help",
  "how can i help you today",
  "specific questions or concerns",
  "ai assistant",
  "ai care assistant",
];

describe("buildCaregiverOnboardingDirective", () => {
  it("is what buildOnboardingDirective returns for the caregiver role (runner selection)", () => {
    const data = { name: "Maria" };
    expect(buildOnboardingDirective("caregiver", data)).toBe(buildCaregiverOnboardingDirective(data));
  });

  it("labels every required caregiver field (contract completeness)", () => {
    for (const f of CAREGIVER_REQUIRED_FIELDS) {
      expect(CAREGIVER_FIELD_LABEL[f], `missing label for required field '${f}'`).toBeTruthy();
    }
  });

  it("mid-collection lists only the unfilled fields and instructs save_onboarding_field", () => {
    const d = buildCaregiverOnboardingDirective({ name: "Maria", city: "San Jose" });
    expect(d).toContain("save_onboarding_field");
    expect(d).toContain("years of caregiving experience");
    expect(d).toContain("hourly rate");
    expect(d).toContain("email address");
    // name + city are known -> shown as known, not still-needed
    expect(d).toMatch(/already have it[\s\S]*caregiver's own name|caregiver's own name[\s\S]*already have it/i);
    // never the client checklist
    expect(d).not.toContain("the senior's age");
    expect(d).not.toContain("how many days a week care is needed");
  });

  it("with everything collected instructs complete_collection, no link promises", () => {
    const d = buildCaregiverOnboardingDirective({
      name: "Maria", city: "San Jose", yearsExperience: 6, specialties: ["dementia"],
      availability: { days: ["Monday"], hours: "9am-5pm" }, jobType: "part_time",
      hourlyRate: 25, email: "maria@example.com", bio: "I treat every client like family.",
    });
    expect(d).toContain("complete_collection");
    expect(d).toContain("all required fields collected");
    expect(d.toLowerCase()).toContain("do not send or mention any link");
  });

  it("hands off the deterministic gates in the scripted order and forbids running them", () => {
    const d = buildCaregiverOnboardingDirective({});
    const lower = d.toLowerCase();
    // the gates, in the scripted flow's order
    const order = [
      "profile photo upload",
      "certification documents",
      "motor vehicle record",
      "membership activation",
      "checkr background check",
      "payout-account setup",
    ];
    let last = -1;
    for (const gate of order) {
      const idx = lower.indexOf(gate);
      expect(idx, `gate '${gate}' missing from handoff block`).toBeGreaterThan(-1);
      expect(idx, `gate '${gate}' out of order`).toBeGreaterThan(last);
      last = idx;
    }
    // and the loop must never attempt them
    expect(lower).toContain("you must never generate");
    expect(lower).toContain("describe those links yourself");
    expect(lower).toContain("never collect payment/card/ssn/license details in chat");
    expect(lower).toContain("never predict background-check timing");
  });

  it("never re-greets / never re-introduces (the double-Hi fix)", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("never greet again");
    expect(d).toContain("never re-introduce");
  });

  it("offers the voice-memo option once, never repeated", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("voice memo");
    expect(d).toContain("once per conversation");
    expect(d).toContain("never repeat it");
  });

  it("handles the story front-load: extract everything, save each field, skip ahead", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("their story");
    expect(d).toContain("yearsexperience");
    expect(d).toContain("certifications");
    expect(d).toContain("don't re-ask anything the story already answered");
  });

  it("answers money/trust questions honestly then keeps collecting", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("money / trust questions");
    expect(d).toContain("they set their own rate");
    expect(d).toContain("background check is required for all caregivers");
    expect(d).toContain("never dodge, never oversell");
  });

  it("contains no chatbot phrasing except inside a 'never say' prohibition", () => {
    const lines = buildCaregiverOnboardingDirective({}).toLowerCase().split("\n");
    for (const phrase of BANNED) {
      for (const line of lines) {
        if (line.includes(phrase)) expect(line).toContain("never");
      }
    }
  });

  it("instructs one-question-at-a-time, no forms", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("one question per message");
    expect(d).toContain("never send a numbered list");
  });

  it("asks the optional profile-parity extras once, combined, without holding up signup (2g)", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("profile extras");
    expect(d).toContain("gender");
    expect(d).toContain("languages");
    expect(d).toContain("drive");
    expect(d).toContain("optional");
    // one combined question, never a form
    expect(d).toContain("one short, casual question");
  });

  it("surfaces concrete care services in the ask and sweeps the rest once", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("care services");
    // a few concrete menu items named so the caregiver knows what counts
    expect(d).toContain("companionship");
    expect(d).toContain("medication reminders");
    expect(d).toContain("transportation");
    // one sweep, not a recited list
    expect(d).toContain("sweep the rest once");
    expect(d).toContain("never read all eight back like a form");
  });

  it("asks availability in the webapp's parts-of-day vocabulary and echoes what it saved", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("mornings, afternoons, evenings, or overnights");
    expect(d).toContain("echo what you saved");
    expect(d).toContain("reflect back");
  });

  it("captures every job type named (webapp jobTypes parity)", () => {
    const d = buildCaregiverOnboardingDirective({}).toLowerCase();
    expect(d).toContain("job type");
    expect(d).toContain("jobtypes");
  });

  it("user-facing brand is Evia (never Cara) in the directive prose", () => {
    const d = buildCaregiverOnboardingDirective({});
    expect(d).not.toMatch(/\bCara\b/);
  });

  it("default rate-range hint derives from marketRateRange's FALLBACK_RANGE (U5, no re-typed literal)", () => {
    const d = buildCaregiverOnboardingDirective({});
    expect(d).toContain(`$${FALLBACK_RANGE.min}–${FALLBACK_RANGE.max}/hr`);
  });

  it("membership price in the money/trust line comes from config/pricing (R7)", () => {
    const d = buildCaregiverOnboardingDirective({});
    expect(d).toContain(`membership is ${caregiverAnnualDisplay()}`);
  });
});

describe("buildCaregiverOnboardingDirective — fields captured from the current message", () => {
  it("names the just-answered field and forbids re-filing the same text elsewhere", () => {
    const d = buildCaregiverOnboardingDirective({ name: "Hamse" }, "$18–$28/hr", ["name"]);
    expect(d).toContain("Their LAST message answered: " + CAREGIVER_FIELD_LABEL.name);
    expect(d).toContain("Do NOT save its text into any other field");
  });
  it("says nothing extra when nothing was captured this turn", () => {
    const d = buildCaregiverOnboardingDirective({ name: "Hamse" }, "$18–$28/hr", []);
    expect(d).not.toContain("Their LAST message answered");
  });
  it("routes through buildOnboardingDirective for the caregiver role", () => {
    const d = buildOnboardingDirective("caregiver", { name: "Hamse" }, "$18–$28/hr", ["name"]);
    expect(d).toContain("Their LAST message answered");
  });
});
