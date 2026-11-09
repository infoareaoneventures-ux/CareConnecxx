import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { verifySignature, signatureCandidates, webhookSecretsFromEnv } from "../webhookSignature";

const body = Buffer.from(JSON.stringify({ event_type: "message.delivered", data: { id: "m1" } }));
const ts = "1762700000";
const sign = (secret: string, enc: "hex" | "base64" | "base64url" = "hex") =>
  crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.concat([Buffer.from(`${ts}.`), body])).digest(enc);

describe("verifySignature", () => {
  it("accepts a valid signature in hex, base64 and base64url", () => {
    for (const enc of ["hex", "base64", "base64url"] as const) {
      expect(verifySignature(body, ts, sign("s3cret", enc), "s3cret")).toBe(true);
    }
  });

  it("rejects a wrong secret, a tampered body and a different timestamp", () => {
    expect(verifySignature(body, ts, sign("s3cret"), "other")).toBe(false);
    expect(verifySignature(Buffer.from("{}"), ts, sign("s3cret"), "s3cret")).toBe(false);
    expect(verifySignature(body, "1762700001", sign("s3cret"), "s3cret")).toBe(false);
  });

  it("accepts a scheme prefix on the header (sha256=…, v1=…) and a comma-separated list", () => {
    const sig = sign("s3cret");
    expect(verifySignature(body, ts, `sha256=${sig}`, "s3cret")).toBe(true);
    expect(verifySignature(body, ts, `v1=${sig}`, "s3cret")).toBe(true);
    expect(verifySignature(body, ts, `v1=deadbeef,v1=${sig}`, "s3cret")).toBe(true);
  });

  it("accepts a signature made with ANY configured secret (a separate subscription's own secret) — and only those", () => {
    const delivery = sign("delivery-secret");
    expect(verifySignature(body, ts, delivery, ["primary-secret", "delivery-secret"])).toBe(true);
    expect(verifySignature(body, ts, delivery, ["primary-secret"])).toBe(false);
  });

  it("fails closed: no secret, an empty header, or an empty prefix never verifies", () => {
    expect(verifySignature(body, ts, sign("s3cret"), [])).toBe(false);
    expect(verifySignature(body, ts, sign("s3cret"), "")).toBe(false);
    expect(verifySignature(body, ts, "", "s3cret")).toBe(false);
    expect(verifySignature(body, ts, "sha256=", "s3cret")).toBe(false);
  });
});

describe("signatureCandidates / webhookSecretsFromEnv", () => {
  it("strips prefixes and splits lists", () => {
    expect(signatureCandidates("abc")).toEqual(["abc"]);
    expect(signatureCandidates("sha256=abc")).toEqual(["abc"]);
    expect(signatureCandidates("v1=abc, v1=def")).toEqual(["abc", "def"]);
  });

  it("collects the primary secret first, then the extras, without duplicates or blanks", () => {
    expect(webhookSecretsFromEnv({ LINQ_WEBHOOK_SECRET: "a", LINQ_WEBHOOK_SECRET_2: "b", LINQ_WEBHOOK_SECRETS: "c, a ,," } as NodeJS.ProcessEnv)).toEqual(["a", "b", "c"]);
    expect(webhookSecretsFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
