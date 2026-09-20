// Evia's per-step draft mirror: only answered fields, in the wizard's names, never a placeholder.
import { describe, it, expect } from "vitest";
import { buildClientDraftMirror, mapJobPostingsDocToOnboardingData } from "../clientJobPostingContract";

describe("buildClientDraftMirror", () => {
  it("writes only what the family answered, in the wizard's field names", () => {
    const out = buildClientDraftMirror("u1", "+1", { seniorName: "Samira M", relationship: "parent", careNeeds: ["Bathing"] });
    expect(out).toEqual({ careRecipientFirstName: "Samira", careRecipientLastName: "M", relationship: "parent", careNeeds: ["Bathing"] });
    // Nothing defaulted: no startDate "today", no adultsCount, no ongoing:false, no status.
    expect(out).not.toHaveProperty("startDate");
    expect(out).not.toHaveProperty("adultsCount");
    expect(out).not.toHaveProperty("ongoing");
    expect(out).not.toHaveProperty("status");
  });

  it("maps the emergency contact, rate and schedule when present", () => {
    const out = buildClientDraftMirror("u1", "+1", {
      emergencyContactName: "Imran Mohammed", emergencyContactPhone: "4085551234", rate: 25, startDate: "2026-09-22", selectedDays: ["MON", "WED"], timeOfDay: "morning",
    });
    expect(out).toMatchObject({ emergencyFirstName: "Imran", emergencyLastName: "Mohammed", emergencyPhone: "4085551234", rate: 25, rateFlexible: false, startDate: "2026-09-22", selectedDays: ["MON", "WED"], timeOfDay: ["morning"] });
  });

  it("round-trips back into Evia's own field names through the existing reader", () => {
    const draft = buildClientDraftMirror("u1", "+1", { seniorName: "Samira M", relationship: "parent", careNeeds: ["Bathing"], emergencyContactName: "Imran Mohammed", emergencyContactPhone: "4085551234" });
    const back = mapJobPostingsDocToOnboardingData({ ...draft, clientId: "u1" });
    expect(back).toMatchObject({ seniorName: "Samira M", relationship: "parent", careNeeds: ["Bathing"], emergencyContactName: "Imran Mohammed", emergencyContactPhone: "4085551234" });
  });

  it("empty answers produce an empty mirror (no write)", () => {
    expect(buildClientDraftMirror("u1", "+1", {})).toEqual({});
    expect(buildClientDraftMirror("u1", "+1", { firstName: "Hamse" })).toEqual({});
  });
});
