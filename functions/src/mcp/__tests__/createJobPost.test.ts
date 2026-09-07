import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-30: create_job_post ("New Request" on the Care Requests page) only
// ever collected a free-text `city` — no zip, no street address, no end date —
// unlike every other client-facing location field this session (onboarding,
// bookings), which requires a zip and auto-derives city/state from it so the
// model is never trusted to extract a city from free text.
//
// 2026-09-07: full parity pass against the website's own 6-step wizard
// (PostJobFlow.tsx) — the tool had no way to collect a title or description
// at all (the website requires both: title 10-80 chars, description 50-2500
// chars), no way to represent a flexible/negotiable rate, no way to pass
// care-need sub-task detail, and only synced an existing (already-on-file)
// recipient's care plan when a NEW recipient also happened to be named in the
// same call — an existing-only recipient's Notes/care needs never got this
// job post's details at all.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      const prev = docState.get(path) ?? {};
      const merged = { ...prev, ...data };
      for (const k of Object.keys(data)) {
        if (data[k] && data[k].__arrayUnion) {
          merged[k] = [...(prev[k] ?? []), ...data[k].__arrayUnion];
        }
      }
      docState.set(path, opts?.merge ? merged : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      const next = { ...prev };
      for (const [dotKey, value] of Object.entries(data)) {
        const parts = dotKey.split(".");
        let cur = next;
        for (let i = 0; i < parts.length - 1; i++) {
          cur[parts[i]] = cur[parts[i]] ?? {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
      }
      docState.set(path, next);
    }),
  });
  const makeCollRef = (path: string): any => ({ doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`) });

  return {
    docState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { arrayUnion: (...v: any[]) => ({ __arrayUnion: v }) },
  }),
}));

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

const lookupZipPlace = vi.fn();
vi.mock("../../utils/geocode", () => ({ lookupZipPlace: (...a: unknown[]) => lookupZipPlace(...a) }));

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const TITLE = "Senior care in Austin"; // 22 chars — within 10-80
const NOTES = "Mom needs help with bathing, medication reminders, and light housekeeping most weekday afternoons."; // >50 chars

describe("create_job_post", () => {
  beforeEach(() => { hoisted.reset(); lookupZipPlace.mockReset(); });

  it("requires a zip code — no longer accepts a bare city", async () => {
    const r = await handleToolCall("create_job_post", { clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25 }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("requires a title, 10-80 characters", async () => {
    const short = await handleToolCall("create_job_post", { clientId: CLIENT, notes: NOTES, careTypes: ["companionship"], zipCode: "78701", title: "Short" }) as any;
    expect(short._toolError).toBe(true);
    expect(short.code).toBe("INVALID_INPUT");

    const missing = await handleToolCall("create_job_post", { clientId: CLIENT, notes: NOTES, careTypes: ["companionship"], zipCode: "78701" }) as any;
    expect(missing._toolError).toBe(true);
  });

  it("requires notes (the job description), 50-2500 characters", async () => {
    const short = await handleToolCall("create_job_post", { clientId: CLIENT, title: TITLE, careTypes: ["companionship"], zipCode: "78701", notes: "Too short" }) as any;
    expect(short._toolError).toBe(true);
    expect(short.code).toBe("INVALID_INPUT");

    const missing = await handleToolCall("create_job_post", { clientId: CLIENT, title: TITLE, careTypes: ["companionship"], zipCode: "78701" }) as any;
    expect(missing._toolError).toBe(true);
  });

  it("derives city/state/lat/lng from the zip, not from free text, and writes the given title/notes", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX", lat: 30.27, lng: -97.74 });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
    }) as any;
    expect(r.success).toBe(true);
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc).toMatchObject({ city: "Austin", state: "TX", zipCode: "78701", lat: 30.27, lng: -97.74 });
    expect(doc.title).toBe(TITLE);
    expect(doc.description).toBe(NOTES);
  });

  it("omitting hourlyRate produces a flexible-rate post, same as the website's 'rate flexible' toggle", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], zipCode: "78701",
    }) as any;
    expect(r.success).toBe(true);
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc.rateFlexible).toBe(true);
    expect(doc.rate).toBe(0);
  });

  it("writes endDate, but NOT streetAddress, to job_posts — matches PostJobFlow.tsx, which never sends streetAddress in this payload either", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX", lat: 30.27, lng: -97.74 });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
      streetAddress: "123 Main St", startDate: "2026-09-01", endDate: "2026-09-30",
    }) as any;
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc.endDate).toBe("2026-09-30");
    expect(doc.streetAddress).toBeUndefined();
  });

  it("writes minHoursPerWeek, screeningQuestions, and recipientsCount when given", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX", lat: 30.27, lng: -97.74 });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
      minHoursPerWeek: 20, screeningQuestions: ["Do you drive?"], caregiversNeeded: 2,
      careRecipients: [{ firstName: "Rosie", relationship: "mother" }],
    }) as any;
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc.minHoursPerWeek).toBe(20);
    expect(doc.screeningQuestions).toEqual(["Do you drive?"]);
    expect(doc.recipientsCount).toBe(1);
    expect(doc.caregiversNeeded).toBe(2);
  });

  // 2026-09-07: matches PostJobFlow.tsx's "How many caregivers do you need?"
  // stepper exactly — always set, defaults to 1, clamped 1-4.
  it("defaults caregiversNeeded to 1 when not given", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
    const r1 = await handleToolCall("create_job_post", {
      clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
    }) as any;
    expect(hoisted.sets.find(s => s.path === `job_posts/${r1.jobId}`)?.data.caregiversNeeded).toBe(1);
  });

  it("clamps caregiversNeeded to the 1-4 range", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
    const r2 = await handleToolCall("create_job_post", {
      clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
      caregiversNeeded: 9,
    }) as any;
    expect(hoisted.sets.find(s => s.path === `job_posts/${r2.jobId}`)?.data.caregiversNeeded).toBe(4);
  });

  // 2026-08-30: PostJobFlow.tsx also mirrors recipients into job_postings and
  // per-recipient care needs/notes/location into carePlans — Evia's tool
  // silently skipped this entirely. This locks in the verbatim port.
  describe("recipient mirror (job_postings + carePlans, matches PostJobFlow.tsx)", () => {
    it("sets the primary recipient on job_postings when none exists yet", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe", relationship: "mother" }],
      });
      const jp = hoisted.docState.get(`job_postings/${CLIENT}`);
      expect(jp).toMatchObject({ careRecipientFirstName: "Rosie", careRecipientLastName: "Doe", relationship: "mother" });
    });

    it("adds a second recipient via additionalRecipients instead of overwriting the primary", async () => {
      hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Rosie", careRecipientLastName: "Doe" });
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe" }, { firstName: "Hank", relationship: "father" }],
      });
      const jp = hoisted.docState.get(`job_postings/${CLIENT}`);
      expect(jp.additionalRecipients).toEqual([{ firstName: "Hank", lastName: "", relationship: "father", age: "" }]);
    });

    it("writes each recipient's careNeeds/notes to carePlans.recipientPlans keyed by name", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["mobility", "companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe" }],
      });
      const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
      expect(cp.recipientPlans.rosie_doe.careNeeds).toEqual(["mobility", "companionship"]);
      expect(cp.recipientPlans.rosie_doe.notes).toBe(NOTES);
    });

    // 2026-09-07: sub-task detail (e.g. "Ambulation"/"Transfer Assist" under
    // "Mobility Assistance") — the site's Step 3 checkboxes — had no way to
    // reach carePlans at all before this.
    it("writes careNeedDetails (sub-tasks) to carePlans.recipientPlans", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["Mobility Assistance"], hourlyRate: 25, zipCode: "78701",
        careNeedDetails: { "Mobility Assistance": ["Ambulation", "Transfer Assist"] },
        careRecipients: [{ firstName: "Rosie" }],
      });
      const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
      expect(cp.recipientPlans.rosie_noname.careNeedDetails).toEqual({ "Mobility Assistance": ["Ambulation", "Transfer Assist"] });
    });

    it("mirrors streetAddress into carePlans.locationPool and the recipient's location, never into job_posts", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        streetAddress: "123 Main St", careRecipients: [{ firstName: "Rosie" }],
      });
      const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
      expect(cp.locationPool).toEqual([{ street: "123 Main St", city: "Austin", state: "TX", zipCode: "78701", petsInHome: false, smokingHousehold: false }]);
      expect(cp.recipientPlans.rosie_noname.locations).toEqual([{ street: "123 Main St", city: "Austin", state: "TX", zipCode: "78701", petsInHome: false, smokingHousehold: false }]);
    });

    it("does not touch job_postings/carePlans at all when no careRecipients are given", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", { clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701" });
      expect(hoisted.docState.has(`job_postings/${CLIENT}`)).toBe(false);
      expect(hoisted.docState.has(`carePlans/${CLIENT}`)).toBe(false);
    });

    // 2026-09-07: the real gap this session found — an EXISTING (already on
    // file) recipient's care plan never got this job post's details unless a
    // brand-new recipient also happened to be named in the same call. The
    // tool's guidance now tells the model to always include every recipient
    // this job covers, new or existing — mirrorJobPostRecipientsToWeb already
    // safely no-ops the roster duplicate while still syncing the care plan.
    it("syncs an EXISTING recipient's care plan (notes/careNeeds) without creating a roster duplicate", async () => {
      hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Rosie", careRecipientLastName: "Doe" });
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, title: TITLE, notes: NOTES, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe" }],
      });
      const jp = hoisted.docState.get(`job_postings/${CLIENT}`);
      expect(jp.additionalRecipients).toBeUndefined(); // no duplicate — still just the primary
      const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
      expect(cp.recipientPlans.rosie_doe.notes).toBe(NOTES);
      expect(cp.recipientPlans.rosie_doe.careNeeds).toEqual(["companionship"]);
    });
  });
});
