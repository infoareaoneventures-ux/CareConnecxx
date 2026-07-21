import { afterEach, describe, expect, it } from "vitest";

import {
  intelligencePseudonym,
  tryIntelligencePseudonym,
  __setTelemetryKeyForTests,
  INTELLIGENCE_TELEMETRY_KEY_NAME,
  CURRENT_INTELLIGENCE_TELEMETRY_KEY_VERSION,
} from "./intelligencePseudonym";
import { MEMORY_FINGERPRINT_KEY_NAME } from "../memory/fingerprintKey";

afterEach(() => __setTelemetryKeyForTests(null));

describe("intelligencePseudonym (U0/KTD24/R52)", () => {
  it("is deterministic per (purpose, subject) and stamps the key version", () => {
    __setTelemetryKeyForTests("test-key-material");
    const a = intelligencePseudonym("objective", "user-123");
    const b = intelligencePseudonym("objective", "user-123");
    expect(a.pseudonym).toBe(b.pseudonym);
    expect(a.pseudonym).toMatch(/^[0-9a-f]{64}$/);
    expect(a.keyVersion).toBe(CURRENT_INTELLIGENCE_TELEMETRY_KEY_VERSION);
    expect(a.purpose).toBe("objective");
  });

  it("separates purposes: same subject is unlinkable across purposes", () => {
    __setTelemetryKeyForTests("test-key-material");
    const objective = intelligencePseudonym("objective", "user-123");
    const proactive = intelligencePseudonym("proactive", "user-123");
    expect(objective.pseudonym).not.toBe(proactive.pseudonym);
  });

  it("never contains the raw subject id", () => {
    __setTelemetryKeyForTests("test-key-material");
    const p = intelligencePseudonym("eval_candidate", "+14085551234");
    expect(p.pseudonym).not.toContain("4085551234");
  });

  it("fails closed when the key is unbound — throws, and try-variant returns null", () => {
    __setTelemetryKeyForTests(null);
    delete process.env[INTELLIGENCE_TELEMETRY_KEY_NAME];
    expect(() => intelligencePseudonym("checkpoint", "user-123")).toThrow(/Never fall back to an unhashed identifier/);
    expect(tryIntelligencePseudonym("checkpoint", "user-123")).toBeNull();
  });

  it("uses a dedicated secret — never the memory fingerprint key (KTD24)", () => {
    expect(INTELLIGENCE_TELEMETRY_KEY_NAME).not.toBe(MEMORY_FINGERPRINT_KEY_NAME);
    expect(INTELLIGENCE_TELEMETRY_KEY_NAME).toBe("INTELLIGENCE_TELEMETRY_KEY");
  });
});
