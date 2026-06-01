import { describe, it, expect } from "vitest";
import { extractMediaPart } from "./mediaIntake";

describe("mediaIntake.extractMediaPart", () => {
  it("detects an image by type with a direct url", () => {
    const m = extractMediaPart([
      { type: "image", url: "https://cdn.linqapp.com/x.jpg", content_type: "image/jpeg" },
    ]);
    expect(m).toMatchObject({ kind: "image", url: "https://cdn.linqapp.com/x.jpg" });
  });

  it("detects an image delivered as type:media via content_type", () => {
    const m = extractMediaPart([
      { type: "media", media_url: "https://cdn.linqapp.com/y", content_type: "image/png" },
    ]);
    expect(m).toMatchObject({ kind: "image", url: "https://cdn.linqapp.com/y" });
  });

  it("detects a PDF document by content_type", () => {
    const m = extractMediaPart([
      { type: "media", url: "https://cdn.linqapp.com/cna", content_type: "application/pdf" },
    ]);
    expect(m).toMatchObject({ kind: "document" });
  });

  it("detects a document by filename extension when content_type is missing", () => {
    const m = extractMediaPart([
      { type: "file", url: "https://cdn.linqapp.com/a", filename: "cpr-card.pdf" },
    ]);
    expect(m).toMatchObject({ kind: "document", filename: "cpr-card.pdf" });
  });

  it("resolves a nested attachment object with an attachment_id", () => {
    const m = extractMediaPart([
      { type: "media", attachment: { id: "att_123", content_type: "image/heic" } },
    ]);
    expect(m).toMatchObject({ kind: "image", attachment_id: "att_123" });
  });

  it("ignores audio / voice-memo parts (owned by the voice path)", () => {
    expect(extractMediaPart([
      { type: "media", url: "https://x/a.m4a", content_type: "audio/m4a" },
    ])).toBeNull();
    expect(extractMediaPart([{ type: "voice_memo", url: "https://x/a" }])).toBeNull();
  });

  it("ignores location, sticker, and text parts", () => {
    expect(extractMediaPart([{ type: "location", latitude: 1, longitude: 2 }])).toBeNull();
    expect(extractMediaPart([{ type: "sticker", url: "https://x/s.png" }])).toBeNull();
    expect(extractMediaPart([{ type: "text", value: "hello" }])).toBeNull();
  });

  it("returns null when a media-typed part has neither url nor attachment_id", () => {
    expect(extractMediaPart([{ type: "image", content_type: "image/jpeg" }])).toBeNull();
  });

  it("returns null for an empty parts array", () => {
    expect(extractMediaPart([])).toBeNull();
  });
});
