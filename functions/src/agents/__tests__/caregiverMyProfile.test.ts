import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// The caregiver's own My Profile page (CaregiverProfile.tsx) over text: the
// page's reads, its seven sections in order, and the keywords = its Edit buttons.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  reviews: [] as any[],
  sent: [] as string[],
  started: [] as string[],
  availability: vi.fn(async () => {}),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async () => {}),
      }),
      where: () => ({ get: vi.fn(async () => ({ docs: hoisted.reviews.map((r, i) => ({ id: `r${i}`, data: () => r })) })) }),
    }),
  }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../caregiverMatchScoring", () => ({ hasValidTransportDocs: (p: any) => p?.documents?.driversLicense?.status === "approved" }));
vi.mock("../caregiverProfileHandler", () => ({ startProfileFlow: vi.fn(async (field: string) => { hoisted.started.push(field); }) }));
vi.mock("../availabilityHandler", () => ({ handleAvailabilityUpdate: (...a: any[]) => (hoisted.availability as any)(...a) }));

import { loadMyProfilePage, myProfileText, handleMyProfileKeyword, LANGUAGE_OPTIONS, JOB_TYPE_OPTIONS, MAX_CLIENTS_OPTIONS, TRAVEL_OPTIONS } from "../caregiverMyProfile";

const RECORD = {
  name: "Mahad", verified: true, photo: "https://x/p.jpg", city: "san jose", state: "CA", hourlyRate: 25, rateFor2Seniors: 30,
  skills: ["Companionship", "Transportation", "Medication Reminders"], services: ["Companionship", "Transportation", "Medication Reminders"],
  documents: { driversLicense: { status: "approved" }, insurance: { status: "approved" }, registration: { status: "approved" } },
  bio: "I'm a great care provider and happy to help anyone", languages: ["English"], yearsExperience: "3-5 years", maxClients: "1",
  jobTypes: ["occasional"], serviceRadius: 25,
  weeklyAvailability: { monday: [{ start: "06:00", end: "12:00" }, { start: "12:00", end: "18:00" }], tuesday: [{ start: "06:00", end: "12:00" }] },
};

beforeEach(() => {
  hoisted.docs.clear(); hoisted.reviews.length = 0; hoisted.sent.length = 0; hoisted.started.length = 0; hoisted.availability.mockClear();
  hoisted.docs.set("users/cg1", { email: "x@y.com" });
  hoisted.docs.set("caregivers/cg1", RECORD);
});

describe("the page's option lists are the site's (byte parity)", () => {
  const site = fs.readFileSync(path.resolve(__dirname, "../../../../components/CaregiverProfile.tsx"), "utf8");
  const constants = fs.readFileSync(path.resolve(__dirname, "../../../../components/caregiver/signup/constants.ts"), "utf8");
  it("LANGUAGES, JOB_TYPES ids, MAX_CLIENTS_OPTIONS, the travel pills", () => {
    const langs = site.match(/const LANGUAGES = \[([^\]]*)\]/)![1].match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));
    expect(langs).toEqual([...LANGUAGE_OPTIONS]);
    for (const j of JOB_TYPE_OPTIONS) expect(constants).toContain(`{ id: '${j.id}', label: '${j.label}'`);
    expect(constants).toContain(`export const MAX_CLIENTS_OPTIONS = [${MAX_CLIENTS_OPTIONS.map((o) => `'${o}'`).join(", ")}] as const;`);
    expect(site).toContain(`{[${TRAVEL_OPTIONS.map((o) => `'${o}'`).join(", ")}].map(r => (`);
  });
});

describe("loadMyProfilePage + myProfileText — the page's sections in order", () => {
  it("renders every section with the page's words, the label for Medication Reminders, and the Edit keywords", async () => {
    hoisted.reviews.push(
      { clientName: "Basra", rating: 5, comment: "Wonderful with mom", date: "2026-09-30", wouldRecommend: true, categories: { punctuality: 5, professionalism: 4 } },
      { clientName: "Pat", rating: 4, comment: "", date: "2026-09-20", wouldRecommend: false },
    );
    const page = await loadMyProfilePage("cg1");
    expect(page.hasTransportation).toBe(true);
    expect(page.rates).toEqual([{ label: "1 Person", rate: 25 }, { label: "2 People", rate: 30 }]);
    expect(page.reviews.recommendPct).toBe(50);
    const t = myProfileText(page);
    const order = ["My Profile", "Mahad · Background check complete", "4.5 (2 reviews)", "san jose, CA · $25/hr", "Photo: on file (reply PHOTO to change it)",
      "About Mahad", "I'm a great care provider and happy to help anyone", "Languages: English", "Reply BIO to edit your bio, or LANGUAGES",
      "Care Services", "Companionship, Transportation, Medication Reminders Only", "Reply SERVICES",
      "Rates", "1 Person: $25/hr", "2 People: $30/hr", "3-5 years experience · Up to 1 client at once", "Reply RATES",
      "Weekly Availability", "Looking for: Occasional", "Mon", "Reply LOOKING FOR to change the job type, or AVAILABILITY",
      "Location & Travel", "Lives in san jose, CA", "Willing to travel within 25 miles", "Reply TRAVEL",
      "Reviews", "4.5 overall (2 reviews)", "50% of clients would recommend", "Punctuality: 5.0", "Professionalism: 4.0", 'Basra · 5★ · "Wonderful with mom" · 2026-09-30'];
    let at = -1;
    for (const s of order) { const i = t.indexOf(s, at + 1); expect(i, `"${s}" missing or out of order`).toBeGreaterThan(at); at = i; }
    expect(t).not.toContain("3+ People");
  });

  it("empty states read like the page", async () => {
    hoisted.docs.set("caregivers/cg1", { name: "New Care Provider" });
    const t = myProfileText(await loadMyProfilePage("cg1"));
    expect(t).toContain("New Care Provider · Background check pending");
    expect(t).toContain("No reviews yet");
    expect(t).toContain("Photo: none yet (reply PHOTO to add one)");
    expect(t).toContain("Add a bio to introduce yourself to families.");
    expect(t).toContain("Languages: English");
    expect(t).toContain("No services added yet.");
    expect(t).toContain("No rate set yet.");
    expect(t).toContain("Looking for: No job types selected.");
    expect(t).toContain("No availability set yet.");
    expect(t).toContain("Add your address in Account Settings (reply SETTINGS).");
    expect(t).toContain("Willing to travel within 10 miles");
    expect(t).toContain("Reviews from families will appear here after completed jobs.");
  });
});

describe("handleMyProfileKeyword — the page's buttons", () => {
  it("PROFILE texts the page; each Edit keyword starts its flow (services → the skills flow); AVAILABILITY = the Calendar modal flow", async () => {
    expect(await handleMyProfileKeyword("+1", "chat", "cg1", "my profile", {})).toBe("handled");
    expect(hoisted.sent[0]).toContain("My Profile");
    for (const [kw, field] of [["RATES", "rates"], ["BIO", "bio"], ["LANGUAGES", "languages"], ["SERVICES", "skills"], ["LOOKING FOR", "jobtype"], ["TRAVEL", "travel"], ["PHOTO", "photo"]] as const) {
      hoisted.started.length = 0;
      expect(await handleMyProfileKeyword("+1", "chat", "cg1", kw, {})).toBe("handled");
      expect(hoisted.started).toEqual([field]);
    }
    expect(await handleMyProfileKeyword("+1", "chat", "cg1", "availability", {})).toBe("handled");
    expect(hoisted.availability).toHaveBeenCalledTimes(1);
    expect((hoisted.availability.mock.calls[0] as any[])[3]).toMatchObject({ availabilityStep: "start" });
    expect(await handleMyProfileKeyword("+1", "chat", "cg1", "hello there", {})).toBe("passthrough");
  });
});
