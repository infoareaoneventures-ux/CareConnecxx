import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// Minimal loads for the two flow modules (pure resolver functions under test).
vi.mock("firebase-functions/v1", () => {
  const fn: any = new Proxy(() => fn, { get: () => fn, apply: () => fn });
  return { __esModule: true, default: fn, config: () => ({}), https: fn, pubsub: fn, firestore: fn, logger: fn, region: () => fn };
});
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default:   { firestore: () => ({ collection: () => ({ doc: () => ({}) }) }) },
  firestore: Object.assign(() => ({ collection: () => ({ doc: () => ({}) }) }), { FieldValue: { delete: () => ({}) } }),
}));
vi.mock("../linq/client", () => ({ sendMessage: vi.fn(), signalThinking: vi.fn(), AgentSession: {} }));
vi.mock("./buildJobPost", () => ({ buildAndSaveJobPost: vi.fn() }));

import { resolveJobStep } from "./jobPostingFlow";

// U13: job-posting's multi-step sequencing gets the same data-driven dispatch
// as U12 (dark behind its own CONVERGENCE_FLIPPED flow key). This pins the
// resolver's field-schema contract / branch logic so the dark path can't
// silently drift from the legacy machine's progression. (modifyScheduleFlow's
// equivalent resolver was removed 2026-09-13 along with the rest of that
// module — see AGENT_NATIVE_EXCLUSIONS.md.)
describe("jobPostingFlow.resolveJobStep (U13 — linear)", () => {
  it("walks the field order, then hands off to the confirm step", () => {
    // 2026-09-07: reordered to full parity with the website's own wizard —
    // PostJobFlow.tsx renders Step1Schedule.tsx BEFORE Step2WhoWhere.tsx
    // (confirmed by component order + the wizard's "Step 2 of 6" label on the
    // who/where screen), so: frequency/start/days/time FIRST, THEN
    // Step2WhoWhere.tsx (recipients, caregivers needed, location), THEN
    // Step3CareNeeds.tsx → Step4Rate.tsx → Step5Describe.tsx — see
    // jobPostingFlow.ts's JP_STEP_ORDER comment. jobCareLevel and
    // petsInHome/smokingHousehold are no longer in the field order at all:
    // care level has no site input ever (derived automatically), and
    // pets/smoking are now collected as part of the location step
    // (jp_ask_location_environment, a conditional sub-step deliberately
    // excluded from this linear resolver).
    expect(resolveJobStep({})).toBe("jp_ask_frequency");
    expect(resolveJobStep({ jobFrequency: "part-time" })).toBe("jp_ask_start");
    expect(resolveJobStep({ jobFrequency: "part-time", jobStartDate: "ASAP" })).toBe("jp_ask_days");
    const scheduled = { jobFrequency: "part-time", jobStartDate: "ASAP", jobDays: ["Mon"], jobTimeOfDay: "morning" };
    expect(resolveJobStep(scheduled)).toBe("jp_ask_recipients");

    const recipients = [{ firstName: "Rosie", lastName: "", relationship: "Parent", isSelf: false }];
    expect(resolveJobStep({ ...scheduled, careRecipients: recipients })).toBe("jp_ask_caregivers_needed");
    expect(resolveJobStep({ ...scheduled, careRecipients: recipients, caregiversNeeded: 1 })).toBe("jp_ask_location");

    const mid = { ...scheduled, careRecipients: recipients, caregiversNeeded: 1, streetAddress: "123 Main St" };
    expect(resolveJobStep(mid)).toBe("jp_ask_care_needs");
    expect(resolveJobStep({ ...mid, jobCareNeeds: ["bathing"] })).toBe("jp_ask_rate");
    // jp_ask_pay_method was removed from the field order (cash/Venmo/Zelle
    // removed platform-wide, 2026-08-23) — rate now hands off straight to
    // description. jobTitle isn't in the field order at all (2026-09-07,
    // Hamse's call): it's silently filled with the site's own default
    // ("Senior care in {city}", defaultJobTitle in jobPostContract.ts) the
    // moment the address is known, never asked as its own question.
    expect(resolveJobStep({ ...mid, jobCareNeeds: ["bathing"], jobHourlyRate: 25 })).toBe("jp_ask_description");
    const full = { ...mid, jobCareNeeds: ["bathing"], jobHourlyRate: 25, jobDescription: "Daytime care" };
    expect(resolveJobStep(full)).toBe("jp_confirm_post");
  });
});
