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
import { resolveScheduleStep } from "./modifyScheduleFlow";

// U13: the two flows that have multi-step sequencing get the same data-driven
// dispatch as U12 (dark behind their own CONVERGENCE_FLIPPED flow keys). These
// pin the resolvers' field-schema contract / branch logic so the dark path can't
// silently drift from the legacy machine's progression.
describe("jobPostingFlow.resolveJobStep (U13 — linear)", () => {
  it("walks the field order, then hands off to the confirm step", () => {
    expect(resolveJobStep({})).toBe("jp_ask_start");
    expect(resolveJobStep({ jobStartDate: "ASAP" })).toBe("jp_ask_frequency");
    expect(resolveJobStep({ jobStartDate: "ASAP", jobFrequency: "part-time" })).toBe("jp_ask_days");
    const mid = { jobStartDate: "ASAP", jobFrequency: "part-time", jobDays: ["Mon"], jobTimeOfDay: "morning", jobCareNeeds: ["bathing"], jobCareLevel: "moderate" };
    expect(resolveJobStep(mid)).toBe("jp_ask_environment");
    // petsInHome:false must count as collected (boolean), not re-ask.
    expect(resolveJobStep({ ...mid, petsInHome: false })).toBe("jp_ask_rate");
    const full = { ...mid, petsInHome: false, jobHourlyRate: 25, jobPaymentMethod: "credit", jobDescription: "Daytime care" };
    expect(resolveJobStep(full)).toBe("jp_confirm_post");
  });
});

describe("modifyScheduleFlow.resolveScheduleStep (U13 — conditional)", () => {
  it("asks what to change first", () => {
    expect(resolveScheduleStep({})).toBe("ms_ask_what");
  });
  it("days_only: days then straight to confirm (no times)", () => {
    expect(resolveScheduleStep({ changeWhat: "days_only" })).toBe("ms_ask_days");
    expect(resolveScheduleStep({ changeWhat: "days_only", newDays: ["Tuesday"] })).toBe("ms_confirm");
  });
  it("times_only: skips days, asks times, then confirm", () => {
    expect(resolveScheduleStep({ changeWhat: "times_only" })).toBe("ms_ask_times");
    expect(resolveScheduleStep({ changeWhat: "times_only", newStartTime: "09:00" })).toBe("ms_confirm");
  });
  it("both: days, then times, then confirm", () => {
    expect(resolveScheduleStep({ changeWhat: "both" })).toBe("ms_ask_days");
    expect(resolveScheduleStep({ changeWhat: "both", newDays: ["Tuesday"] })).toBe("ms_ask_times");
    expect(resolveScheduleStep({ changeWhat: "both", newDays: ["Tuesday"], newStartTime: "09:00" })).toBe("ms_confirm");
  });
});
