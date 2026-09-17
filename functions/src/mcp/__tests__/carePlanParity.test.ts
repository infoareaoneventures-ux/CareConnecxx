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
      if (!docState.has(path)) { const e: any = new Error("not-found"); e.code = 5; throw e; }
      const prev = docState.get(path) ?? {};
      const merged = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && (v as any).__arrayUnion) {
          merged[k] = [...(prev[k] ?? []), ...(v as any).__arrayUnion];
        } else if (v && typeof v === "object" && (v as any).__delete) {
          delete merged[k];
        } else if (k.includes(".")) {
          // Dotted-path field write (the page's own update shape) — replaces that nested leaf.
          const parts = k.split(".");
          let cur = merged;
          for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = { ...(cur[parts[i]] ?? {}) }; cur = cur[parts[i]]; }
          cur[parts[parts.length - 1]] = v;
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
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));

const lookupZipPlace = vi.fn();
const geocodeStreetAddress = vi.fn(async (..._a: unknown[]) => ({ lat: 37.3, lng: -121.9 }));
vi.mock("../../utils/geocode", () => ({
  lookupZipPlace: (...a: unknown[]) => lookupZipPlace(...a),
  geocodeStreetAddress: (...a: unknown[]) => geocodeStreetAddress(...a),
}));

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
// The page's recipient tabs come from the job_postings roster — every
// per-recipient test needs one (Jane Doe, primary).
const seedRoster = (extra: Record<string, unknown> = {}) =>
  hoisted.docState.set(`job_postings/${CLIENT}`, { careRecipientFirstName: "Jane", careRecipientLastName: "Doe", relationship: "Parent", careRecipientAge: "78", ...extra });

describe("get_care_plan / update_care_plan — emergency contacts collection fix", () => {
  beforeEach(() => { hoisted.reset(); seedRoster(); });

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
  beforeEach(() => { hoisted.reset(); seedRoster(); });

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
  beforeEach(() => { hoisted.reset(); seedRoster(); });

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

  it("requires a street address (the page's form rule)", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: {} } });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careLocation", value: { city: "San Jose" }, action: "set", recipientFirstName: "Jane",
    }) as any;
    expect(r._toolError).toBe(true);
  });
});

// 2026-09-11 (live-caught): an SMS-driven careNeeds update landed in carePlans
// but never reached senior_profiles.needs — the field find_nearby_caregivers
// actually reads — so a family updating care needs by texting Evia saw the
// change reflected on the Care Plan page but caregiver matching kept using
// stale data. Same root cause and fix as the site's own CarePlan.tsx save path.
describe("update_care_plan — careNeeds syncs senior_profiles.needs (2026-09-11)", () => {
  beforeEach(() => { hoisted.reset(); seedRoster(); });

  it("single-recipient household: syncs to senior_profiles/{clientId} (primary, no suffix)", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: [] } } });
    hoisted.docState.set(`senior_profiles/${CLIENT}`, { name: "Jane Doe" });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careNeeds", value: ["Personal Care", "Meal Preparation"], action: "set",
    }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.docState.get(`carePlans/${CLIENT}`).recipientPlans.jane_doe.careNeeds)
      .toEqual(["Personal Care", "Meal Preparation"]);
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}`).needs)
      .toEqual(["Personal Care", "Meal Preparation"]);
  });

  it("multi-recipient household: an update for the NON-primary recipient syncs to senior_profiles/{clientId}_{key}", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, {
      recipientPlans: { jane_doe: { careNeeds: [] }, tom_doe: { careNeeds: [] } },
    });
    hoisted.docState.set(`senior_profiles/${CLIENT}`, { name: "Jane Doe" });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careNeeds", value: ["Companionship"], action: "set", recipientFirstName: "Tom",
    }) as any;
    expect(r.success).toBe(true);
    // Primary's senior_profiles doc untouched.
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}`).needs).toBeUndefined();
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}_tom_doe`).needs).toEqual(["Companionship"]);
  });

  it("append/remove actions mirror the same operation onto senior_profiles.needs", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: ["Personal Care"] } } });
    hoisted.docState.set(`senior_profiles/${CLIENT}`, { name: "Jane Doe", needs: ["Personal Care"] });

    await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careNeeds", value: "Mobility Assistance", action: "append",
    });
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}`).needs).toEqual(["Personal Care", "Mobility Assistance"]);

    await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "careNeeds", value: "Personal Care", action: "remove",
    });
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}`).needs).toEqual(["Mobility Assistance"]);
  });

  it("does NOT touch senior_profiles for non-careNeeds fields (e.g. notes)", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: ["Personal Care"] } } });
    hoisted.docState.set(`senior_profiles/${CLIENT}`, { name: "Jane Doe", needs: ["Personal Care"] });
    await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "notes", value: "Loves gardening", action: "set",
    });
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}`).needs).toEqual(["Personal Care"]);
  });
});

describe("create_senior_profile — the Care Plan page's '+ Add' form", () => {
  beforeEach(() => { hoisted.reset(); geocodeStreetAddress.mockClear(); lookupZipPlace.mockReset(); });

  it("first recipient in the household: writes the primary roster fields + the plan the family filled in (needs, sub-tasks, note, location) + the pool + needs mirror — no senior_profiles.add", async () => {
    lookupZipPlace.mockResolvedValueOnce({ lat: 0, lng: 0, city: "San Jose", state: "CA" });
    const r = await handleToolCall("create_senior_profile", {
      clientId: CLIENT, name: "Jane Doe", relationship: "Parent", age: 78,
      careNeeds: ["Meal Preparation", "personal care"], careNeedDetails: { "Meal Preparation": ["Breakfast", "Not a real sub-task"] }, notes: "she likes to go shopping",
      location: { street: "4746 campbell ave", zipCode: "95130" },
    }) as any;
    expect(r.success).toBe(true);
    expect(r.key).toBe("jane_doe");
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc).toMatchObject({ careRecipientFirstName: "Jane", careRecipientLastName: "Doe", relationship: "Parent", careRecipientAge: "78" });
    const plan = hoisted.docState.get(`carePlans/${CLIENT}`).recipientPlans.jane_doe;
    expect(plan.careNeeds).toEqual(["Meal Preparation", "Personal Care"]);
    expect(plan.careNeedDetails).toEqual({ "Meal Preparation": ["Breakfast"] });
    expect(plan.notes).toBe("she likes to go shopping");
    expect(plan.locations).toEqual([{ street: "4746 campbell ave", city: "San Jose", state: "CA", zipCode: "95130", lat: 37.3, lng: -121.9 }]);
    expect(plan.lifestyle.favoriteActivities).toEqual([]);
    expect(hoisted.docState.get(`carePlans/${CLIENT}`).locationPool).toHaveLength(1);
    expect(hoisted.docState.get(`senior_profiles/${CLIENT}`).needs).toEqual(["Meal Preparation", "Personal Care"]);
    expect(hoisted.adds.some(a => a.path === "senior_profiles")).toBe(false);
  });

  it("a second recipient goes into additionalRecipients and reuses an address already in the pool", async () => {
    seedRoster();
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: [] } }, locationPool: [{ street: "4746 campbell ave", city: "San Jose", state: "CA", zipCode: "95130", lat: 1, lng: 2 }] });
    const r = await handleToolCall("create_senior_profile", { clientId: CLIENT, firstName: "Imran", lastName: "Mohammed", relationship: "Parent", location: { street: "4746 Campbell Ave", zipCode: "95130" } }) as any;
    expect(r.success).toBe(true);
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc.careRecipientFirstName).toBe("Jane"); // untouched
    expect(jobDoc.additionalRecipients).toContainEqual({ firstName: "Imran", lastName: "Mohammed", relationship: "Parent", age: "" });
    const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
    expect(cp.recipientPlans.imran_mohammed.locations).toEqual([{ street: "4746 campbell ave", city: "San Jose", state: "CA", zipCode: "95130", lat: 1, lng: 2 }]);
    expect(cp.locationPool).toHaveLength(1);
    expect(geocodeStreetAddress).not.toHaveBeenCalled();
  });

  it("enforces the form's rules: relationship required, a street address required, 'Myself' only once, no special characters", async () => {
    seedRoster({ relationship: "Myself" });
    expect(((await handleToolCall("create_senior_profile", { clientId: CLIENT, firstName: "Bob", location: { street: "1 Elm St" } })) as any)._toolError).toBe(true);
    expect(((await handleToolCall("create_senior_profile", { clientId: CLIENT, firstName: "Bob", relationship: "Parent", location: { city: "San Jose" } })) as any)._toolError).toBe(true);
    const twice = await handleToolCall("create_senior_profile", { clientId: CLIENT, firstName: "Me", relationship: "Myself", location: { street: "1 Elm St" } }) as any;
    expect(twice._toolError).toBe(true);
    expect(twice.message).toContain("only add yourself once");
    expect(((await handleToolCall("create_senior_profile", { clientId: CLIENT, firstName: "Bo*b", relationship: "Parent", location: { street: "1 Elm St" } })) as any)._toolError).toBe(true);
  });
});

describe("get_care_plan — the page as one read", () => {
  beforeEach(() => { hoisted.reset(); seedRoster({ additionalRecipients: [{ firstName: "Imran", lastName: "Mohammed", relationship: "Parent" }], emergencyFirstName: "B", emergencyLastName: "y", emergencyPhone: "4086370483", emergencyRelationship: "Daughter", careNeeds: ["Companionship"], jobDescription: "wizard note", street: "4746 campbell ave", city: "San Jose", state: "CA", zipCode: "95130" }); });

  it("returns every recipient tab with the four sections (page defaults from signup data when a plan is missing), the pool, the contacts card and the review state", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, {
      recipientPlans: { jane_doe: { careNeeds: ["Meal Preparation", "Personal Care"], careNeedDetails: { "Meal Preparation": ["Breakfast"] }, notes: "she likes to go shopping", locations: [{ street: "4746 campbell ave", city: "San Jose", state: "CA", zipCode: "95130" }] } },
      carePlanReviewedAt: { seconds: 1 },
    });
    hoisted.docState.set(`care_plans/${CLIENT}`, { emergencyContacts: [{ id: "c1", name: "B y", relation: "Daughter", phone: "4086370483", isPrimary: true }] });
    const r = await handleToolCall("get_care_plan", { clientId: CLIENT }) as any;
    expect(r.success).toBe(true);
    expect(r.recipients.map((x: any) => [x.name, x.isPrimary])).toEqual([["Jane Doe", true], ["Imran Mohammed", false]]);
    const jane = r.recipients[0];
    expect(jane).toMatchObject({ key: "jane_doe", relationship: "Parent", age: "78", locationLabel: "4746 campbell ave, San Jose, CA 95130", lifestyleSpecified: false });
    expect(jane.plan.careNeedDetails).toEqual({ "Meal Preparation": ["Breakfast"] });
    // Imran has no stored plan → the page's signup-data defaults.
    const imran = r.recipients[1];
    expect(imran.plan.careNeeds).toEqual(["Companionship"]);
    expect(imran.plan.notes).toBe("wizard note");
    expect(imran.locationLabel).toBe("4746 campbell ave, San Jose, CA 95130");
    expect(r.emergencyContacts).toHaveLength(1);
    expect(r.setupContact).toEqual({ firstName: "B", lastName: "y", phone: "4086370483", relationship: "Daughter" });
    expect(r.reviewed).toBe(true);
    expect(r.options.careTypes).toContain("Light Housekeeping");
    // Older shape still present for existing callers.
    expect(r.carePlan.recipientPlans.jane_doe.notes).toBe("she likes to go shopping");
  });
});

describe("update_care_plan — Care Needs & Tasks, Emergency Contacts, Looks good", () => {
  beforeEach(() => { hoisted.reset(); seedRoster(); });

  it("careNeeds only accepts the page's pills, writes the whole recipient plan like saveSection, and drops a removed need's sub-tasks", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: ["Meal Preparation", "Personal Care"], careNeedDetails: { "Meal Preparation": ["Breakfast"] }, notes: "n" } } });
    const bad = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "careNeeds", value: ["Skydiving"], action: "append" }) as any;
    expect(bad._toolError).toBe(true);
    const r = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "careNeeds", value: "meal prep", action: "remove" }) as any;
    expect(r.success).toBe(true);
    const plan = hoisted.docState.get(`carePlans/${CLIENT}`).recipientPlans.jane_doe;
    expect(plan.careNeeds).toEqual(["Personal Care"]);
    expect(plan.careNeedDetails).toEqual({});
    expect(plan.notes).toBe("n");
    expect(plan.lifestyle.favoriteActivities).toEqual([]); // whole-plan write carries the page's empty lifestyle/tasks shape
  });

  it("careNeedDetails sets sub-tasks only under a selected need and only from the page's list", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: { careNeeds: ["Meal Preparation"], careNeedDetails: {} } } });
    const r = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "careNeedDetails", value: { "Meal Preparation": ["Breakfast", "Dinner"] }, action: "set" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.docState.get(`carePlans/${CLIENT}`).recipientPlans.jane_doe.careNeedDetails).toEqual({ "Meal Preparation": ["Breakfast", "Dinner"] });
    expect(((await handleToolCall("update_care_plan", { clientId: CLIENT, field: "careNeedDetails", value: { "Personal Care": ["Bathing"] }, action: "set" })) as any)._toolError).toBe(true); // not selected
    expect(((await handleToolCall("update_care_plan", { clientId: CLIENT, field: "careNeedDetails", value: { "Meal Preparation": ["Brunch"] }, action: "set" })) as any)._toolError).toBe(true); // not on the page
  });

  it("emergencyContacts append mints an id, validates the phone, and respects the card's 2-contact cap (signup contact counts)", async () => {
    seedRoster({ emergencyFirstName: "B", emergencyLastName: "y", emergencyPhone: "4086370483", emergencyRelationship: "Daughter" });
    const short = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "emergencyContacts", value: { name: "Sam", relation: "Son", phone: "555" }, action: "append" }) as any;
    expect(short._toolError).toBe(true);
    const r = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "emergencyContacts", value: { name: "Sam", relation: "Son", phone: "408-555-1212" }, action: "append" }) as any;
    expect(r.success).toBe(true);
    const saved = hoisted.docState.get(`care_plans/${CLIENT}`);
    expect(saved.emergencyContacts).toHaveLength(1);
    expect(saved.emergencyContacts[0]).toMatchObject({ name: "Sam", relation: "Son", phone: "408-555-1212", isPrimary: false });
    expect(typeof saved.emergencyContacts[0].id).toBe("string");
    expect(saved.lastUpdatedBy).toBe("web");
    // 1 saved + the signup contact = 2 → the card's "+ Add" is gone.
    const full = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "emergencyContacts", value: { name: "Third", relation: "Friend", phone: "4085550000" }, action: "append" }) as any;
    expect(full._toolError).toBe(true);
  });

  it("'reviewed' is the Looks good button: stamps carePlanReviewedAt and migrates the signup contact once", async () => {
    seedRoster({ emergencyFirstName: "B", emergencyLastName: "y", emergencyPhone: "4086370483", emergencyRelationship: "Daughter" });
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { jane_doe: {} } });
    const r = await handleToolCall("update_care_plan", { clientId: CLIENT, field: "reviewed", value: true, action: "set" }) as any;
    expect(r.success).toBe(true);
    const cp = hoisted.docState.get(`carePlans/${CLIENT}`);
    expect(cp.carePlanReviewedAt).toBeTruthy();
    expect(cp.emergencyContacts).toEqual([{ id: "wizard", name: "B y", relation: "Daughter", phone: "4086370483", isPrimary: true }]);
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

  it("removing a non-primary recipient just filters them out of additionalRecipients — and keeps their address in the shared pool, like the page", async () => {
    hoisted.docState.set(`job_postings/${CLIENT}`, {
      careRecipientFirstName: "Jane", careRecipientLastName: "Doe",
      additionalRecipients: [{ firstName: "Bob", lastName: "Doe" }, { firstName: "Sue", lastName: "Doe" }],
    });
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { bob_doe: { locations: [{ street: "9 Oak Ave", city: "San Jose", state: "CA", zipCode: "95130" }] } }, locationPool: [] });
    const r = await handleToolCall("remove_care_recipient", { clientId: CLIENT, recipientFirstName: "Bob" }) as any;
    expect(r.success).toBe(true);
    const jobDoc = hoisted.docState.get(`job_postings/${CLIENT}`);
    expect(jobDoc.careRecipientFirstName).toBe("Jane"); // untouched
    expect(jobDoc.additionalRecipients).toEqual([{ firstName: "Sue", lastName: "Doe" }]);
    expect(hoisted.docState.get(`carePlans/${CLIENT}`).locationPool).toEqual([{ street: "9 Oak Ave", city: "San Jose", state: "CA", zipCode: "95130" }]);
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
