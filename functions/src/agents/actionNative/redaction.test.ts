import { describe, expect, it } from "vitest";
import { redactSensitiveFields, safePreview } from "./redaction";

describe("actionNative redaction", () => {
  it("redacts sensitive keys recursively without changing safe values", () => {
    const got = redactSensitiveFields({
      clientId: "c1",
      authorization: "Bearer secret",
      nested: {
        api_key: "sk_live_123",
        note: "safe",
      },
      list: [{ refreshToken: "refresh" }],
    });

    expect(got).toEqual({
      clientId: "c1",
      authorization: "[REDACTED]",
      nested: {
        api_key: "[REDACTED]",
        note: "safe",
      },
      list: [{ refreshToken: "[REDACTED]" }],
    });
  });

  it("handles cycles and bounded previews", () => {
    const value: Record<string, unknown> = { token: "secret" };
    value.self = value;

    const preview = safePreview(value, 80);

    expect(preview).toContain("[REDACTED]");
    expect(preview).toContain("[Circular]");
    expect(preview.length).toBeLessThanOrEqual(83);
  });
});
