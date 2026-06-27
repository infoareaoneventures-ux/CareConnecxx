import { describe, it, expect } from "vitest";
import { CARA_CAPABILITIES, buildCapabilityMenu } from "./caraCapabilities";

describe("buildCapabilityMenu", () => {
  it("lists every client capability label for a client (en)", () => {
    const menu = buildCapabilityMenu("client", "en");
    for (const entry of CARA_CAPABILITIES.client) {
      expect(menu).toContain(entry.label);
      expect(menu).toContain(entry.example);
    }
    // none of the caregiver-only labels leak in
    expect(menu).not.toContain("Find work");
    expect(menu).not.toContain("Submit your hours");
  });

  it("lists caregiver capabilities for a caregiver and excludes client-only ones", () => {
    const menu = buildCapabilityMenu("caregiver", "en");
    for (const entry of CARA_CAPABILITIES.caregiver) {
      expect(menu).toContain(entry.label);
    }
    expect(menu).not.toContain("Find a caregiver");
    expect(menu).not.toContain("View billing");
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
    expect(es).toContain("Encontrar un cuidador");
    expect(es).toContain("Esto es lo que puedo hacer por ti");
    // any non-es lang falls back to English
    const fr = buildCapabilityMenu("client", "fr");
    expect(fr).toEqual(buildCapabilityMenu("client", "en"));
  });
});
