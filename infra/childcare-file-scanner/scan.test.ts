import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalResultPayload,
  parseClamVersion,
  processScanRequest,
  signResult,
  validateScanRequest,
  type ScanRequest,
  type ScannerDependencies,
} from "./scan";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const BYTES = Buffer.from("safe fixture");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const IMAGE = `sha256:${"a".repeat(64)}`;
const SECRET = "test-secret-with-sufficient-entropy";

const REQUEST: ScanRequest = {
  schemaVersion: 1,
  operationId: `cfs_${"b".repeat(48)}`,
  fileId: `cf_${"c".repeat(40)}`,
  path: `childcare/hh_1/child_1/photo/cf_${"c".repeat(40)}`,
  objectGeneration: "12345",
  sha256: SHA,
  contentType: "image/jpeg",
  size: BYTES.length,
  attempt: 1,
  deadlineAt: "2026-07-25T12:10:00.000Z",
};

function deps(
  overrides: Partial<ScannerDependencies> = {},
): ScannerDependencies {
  return {
    download: vi.fn(async () => BYTES),
    inspectClamVersion: vi.fn(async () => ({
      engineVersion: "ClamAV 1.4.3",
      signatureVersion: "27888",
      signatureUpdatedAt: "2026-07-25T11:30:00.000Z",
    })),
    scan: vi.fn(async () => ({ verdict: "clean" as const, reasonCode: "clamav_clean" })),
    publish: vi.fn(async () => "message-1"),
    now: () => NOW,
    imageDigest: IMAGE,
    hmacSecret: SECRET,
    ...overrides,
  };
}

describe("validateScanRequest", () => {
  it("accepts the bounded immutable request schema", () => {
    expect(validateScanRequest(REQUEST)).toEqual(REQUEST);
  });

  it("rejects paths outside the quarantine child-file prefix", () => {
    expect(() => validateScanRequest({ ...REQUEST, path: "caregivers/u/doc" })).toThrow(
      "invalid_request_schema",
    );
  });

  it("rejects oversize and out-of-budget attempts", () => {
    expect(() => validateScanRequest({ ...REQUEST, size: 11 * 1024 * 1024 })).toThrow();
    expect(() => validateScanRequest({ ...REQUEST, attempt: 4 })).toThrow();
  });
});

describe("processScanRequest", () => {
  it("publishes a signed clean result bound to generation, checksum, and image", async () => {
    const injected = deps();
    const result = await processScanRequest(REQUEST, injected);
    expect(result).toMatchObject({
      result: "clean",
      reasonCode: "clamav_clean",
      objectGeneration: "12345",
      sha256: SHA,
      imageDigest: IMAGE,
      attempt: 1,
    });
    expect(result.signature).toBe(
      signResult(
        {
          schemaVersion: result.schemaVersion,
          operationId: result.operationId,
          fileId: result.fileId,
          path: result.path,
          objectGeneration: result.objectGeneration,
          sha256: result.sha256,
          result: result.result,
          reasonCode: result.reasonCode,
          engineVersion: result.engineVersion,
          signatureVersion: result.signatureVersion,
          signatureUpdatedAt: result.signatureUpdatedAt,
          imageDigest: result.imageDigest,
          attempt: result.attempt,
          scannedAt: result.scannedAt,
        },
        SECRET,
      ),
    );
    expect(injected.publish).toHaveBeenCalledOnce();
  });

  it.each([
    ["malicious", "malware_detected"],
    ["error", "scanner_engine_error"],
  ] as const)("preserves the %s terminal result without file data", async (verdict, reasonCode) => {
    const result = await processScanRequest(
      REQUEST,
      deps({ scan: vi.fn(async () => ({ verdict, reasonCode })) }),
    );
    expect(result.result).toBe(verdict);
    expect(result.reasonCode).toBe(reasonCode);
    expect(canonicalResultPayload(result)).not.toContain(BYTES.toString());
  });

  it("rejects checksum drift before invoking ClamAV", async () => {
    const injected = deps({ download: vi.fn(async () => Buffer.from("different")) });
    await expect(processScanRequest(REQUEST, injected)).rejects.toThrow("object_size_mismatch");
    expect(injected.scan).not.toHaveBeenCalled();
  });

  it("rejects stale signatures and expired work", async () => {
    await expect(
      processScanRequest(
        REQUEST,
        deps({
          inspectClamVersion: vi.fn(async () => ({
            engineVersion: "ClamAV 1.4.3",
            signatureVersion: "old",
            signatureUpdatedAt: "2026-07-23T11:00:00.000Z",
          })),
        }),
      ),
    ).rejects.toThrow("stale_clamav_signatures");
    await expect(
      processScanRequest(
        { ...REQUEST, deadlineAt: "2026-07-25T11:59:59.000Z" },
        deps(),
      ),
    ).rejects.toThrow("scan_request_expired");
  });
});

describe("parseClamVersion", () => {
  it("extracts engine, signature version, and timestamp", () => {
    expect(parseClamVersion("ClamAV 1.4.3/27888/Fri Jul 25 11:30:00 2026\n")).toMatchObject({
      engineVersion: "ClamAV 1.4.3",
      signatureVersion: "27888",
    });
  });

  it("fails closed on unknown output", () => {
    expect(() => parseClamVersion("not clam")).toThrow("clamav_version_unparseable");
  });
});
