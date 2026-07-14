import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateToken, verifyToken } from "./tokenService";

describe("tokenService signature verification", () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-with-enough-entropy";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it("verifies a valid token", () => {
    const token = generateToken({ phone: "+15555550100", task: "photo_upload" });
    expect(verifyToken(token)).toMatchObject({ phone: "+15555550100", task: "photo_upload" });
  });

  it("rejects a same-length tampered signature", () => {
    const token = generateToken({ phone: "+15555550100", task: "photo_upload" });
    const parts = token.split(".");
    const last = parts[2].at(-1) === "a" ? "b" : "a";
    parts[2] = `${parts[2].slice(0, -1)}${last}`;
    expect(verifyToken(parts.join("."))).toBeNull();
  });

  it("rejects a signature length mismatch without throwing", () => {
    const token = generateToken({ phone: "+15555550100", task: "photo_upload" });
    const parts = token.split(".");
    parts[2] = parts[2].slice(1);
    expect(() => verifyToken(parts.join("."))).not.toThrow();
    expect(verifyToken(parts.join("."))).toBeNull();
  });
});
