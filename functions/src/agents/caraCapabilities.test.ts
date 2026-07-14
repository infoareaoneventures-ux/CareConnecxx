import { describe, it, expect } from "vitest";
import { CARA_CAPABILITIES, buildCapabilityMenu } from "./caraCapabilities";

// The menu contract is care-recipe prose (R2/R12 of the human-agent plan):
// featured example prompts in one natural sentence — never a chatbot label
// list. Labels exist for the frontend chips only.
describe("buildCapabilityMenu", () => {
  it("shows every FEATURED client example as prose for a client (en)", () => {
    const menu = buildCapabilityMenu("client", "en");
    for (const entry of CARA_CAPABILITIES.client.filter((e) => e.featured)) {
      expect(menu).toContain(entry.example);
    }
    // none of the caregiver-only examples leak in
    expect(menu).not.toContain("Show me jobs near me");
    expect(menu).not.toContain("Submit my hours");
    // and no chatbot-menu framing
    expect(menu.toLowerCase()).not.toContain("here's what i can help you with");
  });

  it("shows featured caregiver examples for a caregiver and excludes client-only ones", () => {
    const menu = buildCapabilityMenu("caregiver", "en");
    for (const entry of CARA_CAPABILITIES.caregiver.filter((e) => e.featured)) {
      expect(menu).toContain(entry.example);
    }
    expect(menu).not.toContain("Find me a caregiver");
    expect(menu).not.toContain("Explain my latest invoice");
  });

  it("falls back to client capabilities for an unknown/undefined role", () => {
    const unknown = buildCapabilityMenu("admin", "en");
    const undef = buildCapabilityMenu(undefined, "en");
    const client = buildCapabilityMenu("client", "en");
    expect(unknown).toEqual(client);
    expect(undef).toEqual(client);
  });

  it("uses Spanish strings for lang 'es' and English otherwise", () => {
    const es = buildCapabilityMenu("client", "es");
    expect(es).toContain("Puedo coordinar cuidado contigo por aquí");
    for (const entry of CARA_CAPABILITIES.client.filter((e) => e.featured)) {
      expect(es).toContain(entry.exampleEs);
    }
    // any non-es lang falls back to English
    const fr = buildCapabilityMenu("client", "fr");
    expect(fr).toEqual(buildCapabilityMenu("client", "en"));
  });
});
