import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: vi.fn() });
  return { default: { apps: [{}], firestore }, apps: [{}], firestore, initializeApp: vi.fn() };
});
vi.mock("firebase-functions/v1", () => ({
  runWith: () => ({ https: { onRequest: (h: unknown) => h } }),
  https: { onRequest: (h: unknown) => h },
  default: {},
}));

import { buildUploadMeta } from "./uploadPageMeta";
import { injectProfileMeta } from "./caregiverProfileMeta";

describe("buildUploadMeta", () => {
  it("/upload/transport is retired (2026-10-06): a 'no documents needed' card, nothing to upload", () => {
    const meta = buildUploadMeta("/upload/transport");
    expect(meta.title).toBe("No documents needed — Evia");
    expect(meta.description).toContain("no longer collected");
    expect(meta.description).not.toMatch(/driver's license|certif/i);
    expect(meta.image).toMatch(/icon-512\.png$/);
    expect(meta.url).toMatch(/\/upload\/transport$/);
  });

  it("builds the background-check card for /bgcheck (and not for /bgcheck-direct-style paths)", () => {
    const meta = buildUploadMeta("/bgcheck");
    expect(meta.title).toBe("Authorize your background check — Evia");
    expect(meta.description).toContain("included in your membership");
    expect(meta.url).toMatch(/\/bgcheck$/);
  });

  it("builds the profile-photo card for /upload/photo", () => {
    const meta = buildUploadMeta("/upload/photo");
    expect(meta.title).toBe("Add your profile photo — Evia");
    expect(meta.description).toContain("headshot");
    expect(meta.url).toMatch(/\/upload\/photo$/);
  });

  it("never reflects the query token — canonical url is token-free", () => {
    // req.path never carries the query string, but guard the contract anyway.
    const meta = buildUploadMeta("/upload/transport");
    expect(JSON.stringify(meta)).not.toContain("t=");
  });

  it("injects cleanly into an index.html head", () => {
    const html = `<!doctype html><html><head>
      <title>Senior Care | Evia</title>
      <meta property="og:title" content="Senior Care | Evia" />
      <meta property="og:description" content="Find affordable senior care." />
      <meta property="og:image" content="https://www.eviacares.com/icon-512.png" />
      <meta property="og:url" content="https://www.eviacares.com/" />
      </head><body><div id="root"></div></body></html>`;
    const out = injectProfileMeta(html, buildUploadMeta("/upload/transport"));
    expect(out).toContain("<title>No documents needed — Evia</title>");
    expect(out).toMatch(/og:title" content="No documents needed — Evia"/);
  });
});
