import { describe, it, expect, afterEach } from "vitest";
import { isSafeMediaUrl, sniffBufferKind } from "./mediaIntake";

describe("isSafeMediaUrl — SSRF guard", () => {
  afterEach(() => { delete process.env.MEDIA_ALLOWED_HOSTS; });

  it("allows https on known media hosts", () => {
    expect(isSafeMediaUrl("https://cdn.linqapp.com/x.jpg")).toBe(true);
    expect(isSafeMediaUrl("https://my-bucket.s3.amazonaws.com/a.pdf")).toBe(true);
    expect(isSafeMediaUrl("https://storage.googleapis.com/b/c.png")).toBe(true);
  });

  it("blocks non-https schemes", () => {
    expect(isSafeMediaUrl("http://cdn.linqapp.com/x.jpg")).toBe(false);
  });

  it("blocks the cloud metadata IP and other raw IPs (SSRF)", () => {
    expect(isSafeMediaUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeMediaUrl("https://10.0.0.5/internal")).toBe(false);
    expect(isSafeMediaUrl("https://localhost/x")).toBe(false);
  });

  it("blocks non-allowlisted hosts", () => {
    expect(isSafeMediaUrl("https://evil.example.com/x.jpg")).toBe(false);
    // Suffix match must not be foolable by a lookalike host.
    expect(isSafeMediaUrl("https://linqapp.com.evil.com/x")).toBe(false);
  });

  it("honors MEDIA_ALLOWED_HOSTS env extension", () => {
    process.env.MEDIA_ALLOWED_HOSTS = "mycdn.example";
    expect(isSafeMediaUrl("https://files.mycdn.example/x.jpg")).toBe(true);
  });

  it("rejects malformed urls", () => {
    expect(isSafeMediaUrl("not a url")).toBe(false);
  });
});

describe("sniffBufferKind — magic-byte detection", () => {
  it("detects images", () => {
    expect(sniffBufferKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image"); // JPEG
    expect(sniffBufferKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image"); // PNG
  });

  it("detects PDF documents", () => {
    expect(sniffBufferKind(Buffer.from("%PDF-1.7\n%âãÏÓ"))).toBe("document");
  });

  it("flags executables (PE/ELF)", () => {
    expect(sniffBufferKind(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBe("executable"); // MZ
    expect(sniffBufferKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]))).toBe("executable"); // ELF
  });

  it("treats plain text as text", () => {
    expect(sniffBufferKind(Buffer.from("name,role,phone\nJane,RN,5551234567\n"))).toBe("text");
  });

  it("returns unknown for tiny/garbage buffers", () => {
    expect(sniffBufferKind(Buffer.from([0x01, 0x02]))).toBe("unknown");
  });
});
