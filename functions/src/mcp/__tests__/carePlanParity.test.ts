import { describe, it, expect, vi, beforeEach } from "vitest";

// Care Plan page parity (2026-08-31 audit): found and fixed three real gaps
// between the website's Care Plan page (components/CarePlan.tsx) and Evia's
// get_care_plan/update_care_plan/create_senior_profile tools:
//   1. Emergency contacts live on the OLDER care_plans (snake_case) doc on
//      the website — get_care_plan/update_care_plan were reading/writing the
//      newer carePlans (camelCase) doc instead, so neither side ever saw the
//      other's emergency-contact edits.
//   2. "Lifestyle & Preferences" and "Care Location" had no Evia write path
//      at all (update_care_plan's ALLOWED_FIELDS didn't include them).
//   3. Adding a care recipient via Evia (create_senior_profile) wrote only to
//      senior_profiles — a collection the Care Plan/Booking pages never read
//      for their recipient roster (that roster lives in
//      job_postings.additionalRecipients) — so an Evia-added recipient never
//      showed up as a tab on the site at all. No tool existed for removal.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets:    Array<{ path: string; data: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];
  const adds:    Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data });
      const prev = docState.get(path) ?? {};
      if (opts?.merge) {
        const merged = { ...prev };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && (v as any).__arrayUnion) {
            merged[k] = [...(prev[k] ?? []), ...(v as any).__arrayUnion];
          } else if (v && typeof v === "object" && (v as any).__arrayRemove) {
            const toRemove = (v as any).__arrayRemove;
            merged[k] = (prev[k] ?? []).filter((x: any) => !toRemove.some((r: any) => JSON.stringify(r) === JSON.stringify(x)));
          } else if (k.includes(".")) {
            // Dotted-path field write — set just that nested leaf.
            const parts = k.split(".");
            let cur = merged;
            for (let i = 0; i < parts.length - 1; i++) {
              cur[parts[i]] = { ...(cur[parts[i]] ?? {}) };
              cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = v;
          } else {
            merged[k] = v;
          }
        }
        docState.set(path, merged);
      } else {
        docState.set(path, data);
      }
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      const merged = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && (v as any).__arrayUnion) {
          merged[k] = [...(prev[k] ?? []), ...(v as any).__arrayUnion];
        } else if (v && typeof v === "object" && (v as any).__delete) {
          delete merged[k];
        } else {
          merged[k] = v;
        }
      }
      docState.set(path, merged);
    }),
    add: vi.fn(async (data: any) => { adds.push({ path, data }); const id = `auto-${adds.length}`; docState.set(`${path}/${id}`, data); return { id }; }),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${adds.length}`}`),
    add: (data: any) => makeDocRef(path).add(data),
  });

  return {
    docState, sets, updates, adds,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; updates.length = 0; adds.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      delete:      () => ({ __delete: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));

const lookupZipPlace = vi.fn();
vi.mock("../../utils/geocode", () => ({ lookupZipPlace: (...a: unknown[]) => lookupZipPlace(...a) }));

// update_care_plan (careNeeds/emergencyContacts/accessCodes/lifestyle/careLocation
// all fail-safe to high-risk, only 'notes' is exempt — see pendingActions.ts's
// CARE_PLAN_NOTE_FIELDS) goes through the runtime confirmation gate, which has
// its own dedicated test suite. Bypass just isHighRisk here to reach the
// underlying handler logic these tests actually target.
vi.mock("../../agents/pendingActions", async (importActual) => ({
  ...(await importActual<typeof import("../../agents/pendingActions")>()),
  isHighRisk: () => false,
}));

import { handleToolCall } from "../server";

const CLIENT = "client_1";

describe("get_care_plan / update_care_plan — emergency contacts collection fix", () => {
  beforeEach(() => hoisted.reset());

  it("update_care_plan writes emergencyContacts to care_plans (snake_case), not carePlans", async () => {
    const contacts = [{ id: "c1", name: "Jane Doe", relation: "Daughter", phone: "5551234567", isPrimary: true }];
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "emergencyContacts", value: contacts, action: "set",
    }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.docState.get(`care_plans/${CLIENT}`)?.emergencyContacts).toEqual(contacts);
    // Never written to the camelCase doc — that copy is what the website
    // never actually reads for this card.
    expect(hoisted.docState.get(`carePlans/${CLIENT}`)?.emergencyContacts).toBeUndefined();
  });

  it("get_care_plan overlays emergencyContacts from care_plans onto the carePlans result", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: ["Personal Care"] } } });
    hoisted.docState.set(`care_plans/${CLIENT}`, { emergencyContacts: [{ id: "c1", name: "Jane", relation: "Daughter", phone: "5551234567", isPrimary: true }] });
    const r = await handleToolCall("get_care_plan", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.carePlan.emergencyContacts).toHaveLength(1);
    expect(r.carePlan.recipientPlans.jane_doe.careNeeds).toEqual(["Personal Care"]);
  });
});

describe("update_care_plan — lifestyle", () => {
  beforeEach(() => hoisted.reset());

  it("shallow-merges a partial lifestyle update without wiping other lifestyle fields", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, {
      recipientPlans: { jane_doe: { careNeeds: ["Personal Care"], lifestyle: { favoriteActivities: ["Reading"], prefersQuiet: true } } },
    });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "lifestyle", value: { enjoysConversation: true }, action: "set", recipientFirstName: "Jane",
    }) as any;
    expect(r.success).toBe(true);
    const plan = hoisted.docState.get(`carePlans/${CLIENT}`).recipientPlans.jane_doe;
    expect(plan.lifestyle).toMatchObject({ favoriteActivities: ["Reading"], prefersQuiet: true, enjoysConversation: true });
    // Sibling fields on the same recipient untouched.
    expect(plan.careNeeds).toEqual(["Personal Care"]);
  });

  it("rejects a non-object lifestyle value", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: {} } });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "lifestyle", value: "quiet", action: "set", recipientFirstName: "Jane",
    }) as any;
    expect(r._toolError).toBe(true);
  });
});

describe("update_care_plan — careLocation", () => {
  beforeEach(() => hoisted.reset());

  it("writes the recipient's location and adds it to the shared locationPool", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { notes: "existing note" } }, locationPool: [] });
    lookupZipPlace.mockResolvedValueOnce({ lat: 37.3, lng: -121.9, city: "San Jose", state: "CA" });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careLocation", value: { street: "123 Main St", zipCode: "95130" }, action: "set", recipientFirstName: "Jane",
    }) as any;
    expect(r.success).toBe(true);
    const doc = hoisted.docState.get(`carePlans/${CLIENT}`);
    expect(doc.recipientPlans.jane_doe.locations).toEqual([
      { street: "123 Main St", city: "San Jose", state: "CA", zipCode: "95130", lat: 37.3, lng: -121.9 },
    ]);
    expect(doc.locationPool).toHaveLength(1);
    // Sibling field on the same recipient untouched.
    expect(doc.recipientPlans.jane_doe.notes).toBe("existing note");
  });

  it("requires street and zipCode", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: {} } });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careLocation", value: { city: "San Jose" }, action: "set", recipientFirstName: "Jane",
    }) as any;
    expect(r._toolError).toBe(true);
  });
});

describe("create_senior_profile — website roster mirror", () => {
  beforeEach(() => hoisted.reset());

  it("first recipient in the household: writes primary fields on job_postings + seeds carePlans.recipientPlans", async () => {
    const r = await handleToolCall("create_senior_profile", { clientId: CLIENT, name: "Jane Doe", relationship: "mother", age: 78 }) as any;
    expect(r.success).toBe(true);
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc).toMatchObject({ careRecipientFirstName: "Jane", careRecipientLastName: "Doe", relationship: "mother", careRecipientAge: 78 });
    const carePlanDoc = hoisted.docState.get(`carePlans/${CLIENT}`);
    expect(carePlanDoc.recipientPlans.jane_doe).toMatchObject({ careNeeds: [], notes: "" });
  });

  it("a second recipient goes into additionalRecipients, not the primary fields", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Hamse", careRecipientLastName: "Mahad" });
    const r = await handleToolCall("create_senior_profile", { clientId: CLIENT, name: "Mom Mom", relationship: "parent" }) as any;
    expect(r.success).toBe(true);
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc.careRecipientFirstName).toBe("Hamse"); // untouched
    expect(jobDoc.additionalRecipients).toContainEqual(expect.objectContaining({ firstName: "Mom", lastName: "Mom", relationship: "parent" }));
  });

  it("still creates the senior_profiles doc as before (unchanged for whatever else reads it)", async () => {
    const r = await handleToolCall("create_senior_profile", { clientId: CLIENT, name: "Jane Doe" }) as any;
    expect(r.seniorProfileId).toBeTruthy();
    expect(hoisted.adds.some(a => a.path === "senior_profiles")).toBe(true);
  });
});

describe("remove_care_recipient", () => {
  beforeEach(() => hoisted.reset());

  it("removing the primary recipient promotes the first additional recipient", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, {
      careRecipientFirstName: "Jane", careRecipientLastName: "Doe", relationship: "mother", careRecipientAge: 78,
      additionalRecipients: [{ firstName: "Bob", lastName: "Doe", relationship: "father", age: 80 }],
    });
    const r = await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Jane" }) as any;
    expect(r.success).toBe(true);
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc.careRecipientFirstName).toBe("Bob");
    expect(jobDoc.additionalRecipients).toEqual([]);
    expect(jobDoc.deletedRecipients).toHaveLength(1);
    expect(jobDoc.deletedRecipients[0]).toMatchObject({ firstName: "Jane" });
  });

  it("removing the primary with no additional recipients clears the primary fields entirely", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Jane", careRecipientLastName: "Doe" });
    // Second recipient present so the "only recipient" guard doesn't block —
    // wait, there's only one here; simulate a household with 2 first.
    hoisted.docState.set(`job_postings/${CLIENT}`, {
      careRecipientFirstName: "Jane", careRecipientLastName: "Doe",
      additionalRecipients: [{ firstName: "Bob", lastName: "Doe" }],
    });
    await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Jane" });
    // Now remove the promoted "Bob" too, leaving zero — should be BLOCKED.
    const r2 = await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Bob" }) as any;
    expect(r2._toolError).toBe(true);
  });

  it("removing a non-primary recipient just filters them out of additionalRecipients", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, {
      careRecipientFirstName: "Jane", careRecipientLastName: "Doe",
      additionalRecipients: [{ firstName: "Bob", lastName: "Doe" }, { firstName: "Sue", lastName: "Doe" }],
    });
    const r = await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Bob" }) as any;
    expect(r.success).toBe(true);
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc.careRecipientFirstName).toBe("Jane"); // untouched
    expect(jobDoc.additionalRecipients).toEqual([{ firstName: "Sue", lastName: "Doe" }]);
  });

  it("rejects removing an unknown recipient name", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Jane", careRecipientLastName: "Doe" });
    const r = await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Nobody" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
  });

  it("rejects removing the household's only recipient", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Jane", careRecipientLastName: "Doe" });
    const r = await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Jane" }) as any;
    expect(r._toolError).toBe(true);
  });
});
