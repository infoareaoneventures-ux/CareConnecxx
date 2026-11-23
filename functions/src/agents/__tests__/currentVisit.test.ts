import { describe, it, expect, vi } from "vitest";
vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({}) }, firestore: Object.assign(() => ({}), { FieldValue: {} }) }));
import { buildCurrentVisitFacts } from "../currentVisit";

const live = {
  status: "in-progress", date: "2026-11-23", startTime: "09:00", endTime: "13:00", caregiverName: "Imran Mohammed", clientName: "Usman",
  timeZone: "America/Los_Angeles",
  startedAt: { toMillis: () => Date.parse("2026-11-23T17:05:00Z") }, // 9:05 AM Pacific
  careRecipients: [{ name: "Henry x", relationship: "parent", careNeeds: ["Personal Care", "Companionship", "Meal Preparation"] }],
  tasksCompleted: ["0_Personal Care", "0_Companionship"],
  notesLog: [{ text: "He ate well", by: "caregiver" }],
};

describe("current visit — the answer comes from the record, not from a model re-reading JSON", () => {
  it("answers 'when does the shift end / how many tasks' in one backed sentence (family view)", () => {
    const f = buildCurrentVisitFacts([{ id: "s1", data: live }], null, "family");
    expect(f.sentence).toContain("Imran Mohammed's visit is in progress");
    expect(f.sentence).toContain("scheduled 9:00 AM–1:00 PM");
    expect(f.sentence).toContain("started at 9:05 AM");
    expect(f.sentence).toContain("2 of 3 tasks done (Personal Care, Companionship)");
    expect(f.sentence).toContain("Still to do: Meal Preparation");
    expect(f.inProgress[0].notes).toEqual(["He ate well"]);
  });

  it("speaks to the care provider about the family (care provider view)", () => {
    const f = buildCurrentVisitFacts([{ id: "s1", data: live }], null, "caregiver");
    expect(f.sentence).toContain("Your visit with Usman is in progress");
  });

  it("says plainly when nothing is in progress, and names the next visit", () => {
    const next = { id: "s2", data: { status: "scheduled", date: "2026-11-24", startTime: "11:00", endTime: "13:00", caregiverName: "Imran Mohammed", timeZone: "America/Los_Angeles" } };
    const f = buildCurrentVisitFacts([], next, "family");
    expect(f.sentence).toMatch(/^No visit is in progress right now\. Imran Mohammed's visit is on Tuesday, /);
    expect(f.sentence).toContain("11:00 AM–1:00 PM");
    expect(f.inProgress).toEqual([]);
  });

  it("never invents an end time the visit doesn't have", () => {
    const f = buildCurrentVisitFacts([{ id: "s3", data: { ...live, endTime: "", careRecipients: [], tasksCompleted: [] } }], null, "family");
    expect(f.sentence).toContain("no end time on the visit");
    expect(f.sentence).not.toContain("1:00 PM");
    expect(f.sentence).not.toContain("–");
  });

  it("nothing in progress and nothing scheduled", () => {
    expect(buildCurrentVisitFacts([], null, "family").sentence).toBe("No visit is in progress right now, and nothing else is scheduled.");
  });
});
