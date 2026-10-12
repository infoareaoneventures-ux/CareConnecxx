import { describe, it, expect } from "vitest";
import { isCareProviderRole } from "./roleParam";

// /start?role=care-provider is the site's link since 2026-10-12; the legacy value
// and every spelling of the new one resolve to the server's "caregiver" role.
describe("isCareProviderRole", () => {
  it.each(["caregiver", "care-provider", "care_provider", "careprovider", "care provider", " Care-Provider "])("%j → caregiver", (v) => {
    expect(isCareProviderRole(v)).toBe(true);
  });
  it.each(["client", "", undefined, null, 42, "provider", "care"])("%j → not a care provider", (v) => {
    expect(isCareProviderRole(v)).toBe(false);
  });
});
