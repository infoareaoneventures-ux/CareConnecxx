import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-30: create_job_post ("New Request" on the Care Requests page) only
// ever collected a free-text `city` — no zip, no street address, no end date —
// unlike every other client-facing location field this session (onboarding,
// bookings), which requires a zip and auto-derives city/state from it so the
// model is never trusted to extract a city from free text.

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

describe("create_job_post", () => {
  beforeEach(() => { hoisted.reset(); lookupZipPlace.mockReset(); });

  it("requires a zip code — no longer accepts a bare city", async () => {
    const r = await handleToolCall("create_job_post", { clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25 }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("derives city/state/lat/lng from the zip, not from free text", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX", lat: 30.27, lng: -97.74 });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
    }) as any;
    expect(r.success).toBe(true);
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc).toMatchObject({ city: "Austin", state: "TX", zipCode: "78701", lat: 30.27, lng: -97.74 });
    expect(doc.title).toContain("Austin");
  });

  it("writes endDate, but NOT streetAddress, to job_posts — matches PostJobFlow.tsx, which never sends streetAddress in this payload either", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX", lat: 30.27, lng: -97.74 });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
      streetAddress: "123 Main St", startDate: "2026-09-01", endDate: "2026-09-30",
    }) as any;
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc.endDate).toBe("2026-09-30");
    expect(doc.streetAddress).toBeUndefined();
  });

  it("writes minHoursPerWeek, screeningQuestions, and recipientsCount when given", async () => {
    lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX", lat: 30.27, lng: -97.74 });
    const r = await handleToolCall("create_job_post", {
      clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
      minHoursPerWeek: 20, screeningQuestions: ["Do you drive?"],
      careRecipients: [{ firstName: "Rosie", relationship: "mother" }],
    }) as any;
    const doc = hoisted.sets.find(s => s.path === `job_posts/${r.jobId}`)?.data;
    expect(doc.minHoursPerWeek).toBe(20);
    expect(doc.screeningQuestions).toEqual(["Do you drive?"]);
    expect(doc.recipientsCount).toBe(1);
  });

  // 2026-08-30: PostJobFlow.tsx also mirrors recipients into job_postings and
  // per-recipient care needs/notes/location into carePlans — Evia's tool
  // silently skipped this entirely. This locks in the verbatim port.
  describe("recipient mirror (job_postings + carePlans, matches PostJobFlow.tsx)", () => {
    it("sets the primary recipient on job_postings when none exists yet", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe", relationship: "mother" }],
      });
      const jp = hoisted.docState.get(`job_postings/${CLIENT}`);
      expect(jp).toMatchObject({ careRecipientFirstName: "Rosie", careRecipientLastName: "Doe", relationship: "mother" });
    });

    it("adds a second recipient via additionalRecipients instead of overwriting the primary", async () => {
      hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Rosie", careRecipientLastName: "Doe" });
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe" }, { firstName: "Hank", relationship: "father" }],
      });
      const jp = hoisted.docState.get(`job_postings/${CLIENT}`);
      expect(jp.additionalRecipients).toEqual([{ firstName: "Hank", lastName: "", relationship: "father", age: "" }]);
    });

    it("writes each recipient's careNeeds/notes to carePlans.recipientPlans keyed by name", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, careTypes: ["mobility", "companionship"], hourlyRate: 25, zipCode: "78701",
        careRecipients: [{ firstName: "Rosie", lastName: "Doe" }],
      });
      const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
      expect(cp.recipientPlans.rosie_doe.careNeeds).toEqual(["mobility", "companionship"]);
    });

    it("mirrors streetAddress into carePlans.locationPool and the recipient's location, never into job_posts", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", {
        clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701",
        streetAddress: "123 Main St", careRecipients: [{ firstName: "Rosie" }],
      });
      const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
      expect(cp.locationPool).toEqual([{ street: "123 Main St", city: "Austin", state: "TX", zipCode: "78701", petsInHome: false, smokingHousehold: false }]);
      expect(cp.recipientPlans.rosie_noname.locations).toEqual([{ street: "123 Main St", city: "Austin", state: "TX", zipCode: "78701", petsInHome: false, smokingHousehold: false }]);
    });

    it("does not touch job_postings/carePlans at all when no careRecipients are given", async () => {
      lookupZipPlace.mockResolvedValue({ city: "Austin", state: "TX" });
      await handleToolCall("create_job_post", { clientId: CLIENT, careTypes: ["companionship"], hourlyRate: 25, zipCode: "78701" });
      expect(hoisted.docState.has(`job_postings/${CLIENT}`)).toBe(false);
      expect(hoisted.docState.has(`carePlans/${CLIENT}`)).toBe(false);
    });
  });
});
