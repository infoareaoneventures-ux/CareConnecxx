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

import { injectProfileMeta, buildProfileMeta } from "./caregiverProfileMeta";

const INDEX_HTML = `<!doctype html><html><head>
    <title>Senior Care San Jose &amp; Santa Clara County | Evia</title>
    <meta name="description" content="Generic SEO description" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Senior Care San Jose & Santa Clara County | Evia" />
    <meta property="og:description" content="Find affordable senior care." />
    <meta property="og:image" content="https://www.eviacares.com/icon-512.png" />
    <meta property="og:url" content="https://www.eviacares.com/" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Senior Care | Evia" />
    <meta name="twitter:description" content="Find affordable senior care." />
    <meta name="twitter:image" content="https://www.eviacares.com/icon-512.png" />
  </head><body><div id="root"></div></body></html>`;

describe("buildProfileMeta", () => {
  it("builds title, description, image, and canonical /p/ url from a caregiver doc", () => {
    const meta = buildProfileMeta("cg123", {
      name: "Maria Gonzalez",
      city: "San Jose",
      state: "CA",
      hourlyRate: 28,
      yearsExperience: 5,
      specialties: ["Dementia care", "Mobility support", "Meal prep", "Extra"],
      backgroundCheckStatus: "clear",
      profilePhoto: "https://storage.googleapis.com/x/maria.jpg",
    });
    expect(meta.title).toBe("Maria Gonzalez — Caregiver on Evia");
    expect(meta.description).toContain("Background-checked caregiver in San Jose, CA");
    expect(meta.description).toContain("$28/hr");
    expect(meta.description).toContain("5 years experience");
    expect(meta.description).toContain("Dementia care, Mobility support, Meal prep");
    expect(meta.description).not.toContain("Extra");
    expect(meta.image).toBe("https://storage.googleapis.com/x/maria.jpg");
    expect(meta.url).toMatch(/\/p\/cg123$/);
  });

  it("falls back to the site icon when no photo, and skips empty fields", () => {
    const meta = buildProfileMeta("cg9", { name: "Sam Lee" });
    expect(meta.image).toMatch(/icon-512\.png$/);
    expect(meta.description).toBe("Caregiver. View their profile and book on Evia.");
  });

  it("prefers photoURL when profilePhoto is absent and rejects non-http photos", () => {
    const meta = buildProfileMeta("cg9", {
      name: "Sam Lee",
      photo: "data:image/png;base64,xxx",
      photoURL: "https://cdn.example.com/sam.jpg",
    });
    expect(meta.image).toBe("https://cdn.example.com/sam.jpg");
  });
});

describe("injectProfileMeta", () => {
  const meta = {
    title:       'Maria "G" & Co — Caregiver on Evia',
    description: "Background-checked caregiver in San Jose · $28/hr",
    image:       "https://cdn.example.com/maria.jpg",
    url:         "https://www.eviacares.com/p/cg123",
  };

  it("swaps title, og:*, twitter:*, and description tags", () => {
    const out = injectProfileMeta(INDEX_HTML, meta);
    expect(out).toContain("<title>Maria &quot;G&quot; &amp; Co — Caregiver on Evia</title>");
    expect(out).toContain('property="og:title" content="Maria &quot;G&quot; &amp; Co — Caregiver on Evia"');
    expect(out).toContain('property="og:description" content="Background-checked caregiver in San Jose · $28/hr"');
    expect(out).toContain('property="og:image" content="https://cdn.example.com/maria.jpg"');
    expect(out).toContain('property="og:url" content="https://www.eviacares.com/p/cg123"');
    expect(out).toContain('property="og:type" content="profile"');
    expect(out).toContain('name="twitter:title" content="Maria &quot;G&quot; &amp; Co — Caregiver on Evia"');
    expect(out).toContain('name="twitter:image" content="https://cdn.example.com/maria.jpg"');
    // No stale marketing values remain in the swapped tags
    expect(out).not.toContain('og:title" content="Senior Care');
    expect(out).not.toContain("Generic SEO description");
  });

  it("appends missing tags before </head> instead of dropping them", () => {
    const minimal = `<html><head><title>Evia</title></head><body></body></html>`;
    const out = injectProfileMeta(minimal, meta);
    expect(out).toContain('property="og:title"');
    expect(out).toContain('name="twitter:image"');
    expect(out.indexOf('og:title')).toBeLessThan(out.indexOf("</head>"));
  });

  it("escapes HTML so a hostile name cannot break out of the attribute", () => {
    const out = injectProfileMeta(INDEX_HTML, {
      ...meta,
      title: `"><script>alert(1)</script>`,
    });
    expect(out).not.toContain("<script>alert(1)</script>");
  });
});
