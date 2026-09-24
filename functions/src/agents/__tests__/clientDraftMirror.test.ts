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
    // emergencyPhone lands in the wizard's own (555) 000-0000 shape; startDate stays ISO (clamped to today if past).
    expect(out).toMatchObject({ emergencyFirstName: "Imran", emergencyLastName: "Mohammed", emergencyPhone: "(408) 555-1234", rate: 25, rateFlexible: false, selectedDays: ["MON", "WED"], timeOfDay: ["morning"] });
    expect(out.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("a 'flexible' rate is never mirrored as a rate (the wizard has no such option) and a short phone is dropped", () => {
    const out = buildClientDraftMirror("u1", "+1", { rate: "flexible", emergencyContactPhone: "1234" });
    expect(out).not.toHaveProperty("rate");
    expect(out).not.toHaveProperty("emergencyPhone");
    expect(out.rateFlexible).toBe(false);
  });

  it("round-trips back into Evia's own field names through the existing reader", () => {
    const draft = buildClientDraftMirror("u1", "+1", { seniorName: "Samira M", relationship: "parent", careNeeds: ["Bathing"], emergencyContactName: "Imran Mohammed", emergencyContactPhone: "4085551234" });
    const back = mapJobPostingsDocToOnboardingData({ ...draft, clientId: "u1" });
    expect(back).toMatchObject({ seniorName: "Samira M", relationship: "parent", careNeeds: ["Bathing"], emergencyContactName: "Imran Mohammed", emergencyContactPhone: "(408) 555-1234" });
  });

  it("empty answers produce an empty mirror (no write)", () => {
    expect(buildClientDraftMirror("u1", "+1", {})).toEqual({});
    expect(buildClientDraftMirror("u1", "+1", { firstName: "Hamse" })).toEqual({});
  });
});

describe("buildClientDraftMirror — wizard home address + care-need details (2026-09-20)", () => {
  it("fills the wizard's own home-address draft fields from Evia's home* fields", () => {
    const out = buildClientDraftMirror("u1", "+1", { homeStreet: "4746 Campbell Ave", homeZipCode: "95130", homeCity: "San Jose", homeState: "CA", sameAsHomeAddress: true, street: "4746 Campbell Ave", zipCode: "95130", city: "San Jose", state: "CA" });
    expect(out._homeAddress).toEqual({ street: "4746 Campbell Ave", zipCode: "95130", city: "San Jose", state: "CA" });
    expect(out._customAddressOpen).toBe(false);
  });
  it("same-as-home with only the care address known still fills the home step; a different care address opens the custom section", () => {
    expect(buildClientDraftMirror("u1", "+1", { sameAsHomeAddress: true, street: "1 Main St", zipCode: "95130" })._homeAddress).toEqual({ street: "1 Main St", zipCode: "95130", city: "", state: "" });
    expect(buildClientDraftMirror("u1", "+1", { sameAsHomeAddress: false, street: "1 Main St" })._customAddressOpen).toBe(true);
    expect(buildClientDraftMirror("u1", "+1", { street: "1 Main St" })).not.toHaveProperty("_homeAddress");
  });
  it("carries careNeedDetails and reads the wizard's home address back into Evia's fields", () => {
    const out = buildClientDraftMirror("u1", "+1", { careNeeds: ["Personal Care"], careNeedDetails: { "Personal Care": ["Bathing"] } });
    expect(out.careNeedDetails).toEqual({ "Personal Care": ["Bathing"] });
    const back = mapJobPostingsDocToOnboardingData({ clientId: "u1", _homeAddress: { street: "9 Elm", zipCode: "95134", city: "San Jose", state: "CA" }, _customAddressOpen: false, careNeedDetails: { "Personal Care": ["Bathing"] } });
    expect(back).toMatchObject({ homeStreet: "9 Elm", homeZipCode: "95134", homeCity: "San Jose", homeState: "CA", sameAsHomeAddress: true, careNeedDetails: { "Personal Care": ["Bathing"] } });
  });
});
