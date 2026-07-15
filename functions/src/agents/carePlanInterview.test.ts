import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Doc-store mock: docs keyed "collection/id"; set/update calls captured.
const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const writes: Array<{ op: "set" | "update"; path: string; data: Record<string, unknown> }> = [];
  const docRef = (coll: string, id: string) => ({
    get: async () => {
      const d = docs.get(`${coll}/${id}`);
      return { exists: !!d, data: () => d ?? undefined };
    },
    set: async (data: Record<string, unknown>) => { writes.push({ op: "set", path: `${coll}/${id}`, data }); },
    update: async (data: Record<string, unknown>) => { writes.push({ op: "update", path: `${coll}/${id}`, data }); },
  });
  const collRef = (coll: string) => ({
    doc: (id: string) => docRef(coll, id),
    where: () => collRef(coll),
    limit: () => collRef(coll),
    get: async () => ({ empty: true, docs: [] }),
  });
  const firestoreFn: any = () => ({
    collection: (coll: string) => collRef(coll),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (_ref: unknown, data: Record<string, unknown>) => { writes.push({ op: "update", path: "tx", data }); },
    }),
  });
  firestoreFn.FieldValue = { delete: () => "__DELETE__" };
  return { docs, writes, firestoreFn };
});

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: h.firestoreFn }, firestore: h.firestoreFn }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback) }));
vi.mock("../linq/client", () => ({
  sendMessage: vi.fn(async () => ({ message_id: "m" })),
  getOrCreateSession: vi.fn(async () => ({ chatId: "chat", optedOut: false })),
}));

import {
  getCarePlanCompleteness,
  carePlanInterviewPending,
  buildCarePlanInterviewDirective,
  buildCaregiverSafeCareSummary,
  enrichJobPostFromCarePlan,
} from "./carePlanInterview";

beforeEach(() => {
  h.docs.clear();
  h.writes.length = 0;
  process.env.CARE_PLAN_INTERVIEW_ENABLED = "true";
});
afterEach(() => { delete process.env.CARE_PLAN_INTERVIEW_ENABLED; });

const CLIENT = "client1";

function seedPlan(opts: {
  detail?: Record<string, Record<string, string[]>>;   // key → careNeedDetails
  medications?: unknown[];
  medicationsConfirmedNone?: boolean;
  emergencyContacts?: unknown[];
  emergencyContactDeclined?: boolean;
}) {
  if (opts.detail) {
    const recipientPlans: Record<string, unknown> = {};
    for (const [key, d] of Object.entries(opts.detail)) {
      recipientPlans[key] = { name: key.split("_")[0], careNeedDetails: d, careNeeds: Object.keys(d) };
    }
    h.docs.set(`carePlans/${CLIENT}`, { recipientPlans });
  }
  h.docs.set(`care_plans/${CLIENT}`, {
    ...(opts.medications !== undefined ? { medications: opts.medications } : {}),
    ...(opts.medicationsConfirmedNone ? { medicationsConfirmedNone: true } : {}),
    ...(opts.emergencyContacts !== undefined ? { emergencyContacts: opts.emergencyContacts } : {}),
    ...(opts.emergencyContactDeclined ? { emergencyContactDeclined: true } : {}),
  });
}

describe("getCarePlanCompleteness", () => {
  it("reports everything missing on empty docs", async () => {
    const c = await getCarePlanCompleteness(CLIENT, { seniorName: "Rose" });
    expect(c.complete).toBe(false);
    expect(c.missing.join(" ")).toMatch(/day-to-day care tasks/);
    expect(c.missing.join(" ")).toMatch(/medications/);
    expect(c.missing.join(" ")).toMatch(/emergency contact/);
  });

  it("is complete with task detail + medications + emergency contact", async () => {
    seedPlan({
      detail: { rose_noname: { "Personal Care": ["Bathing", "Dressing"] } },
      medications: [{ name: "lisinopril" }],
      emergencyContacts: [{ name: "Ana", phone: "+14085550000" }],
    });
    const c = await getCarePlanCompleteness(CLIENT);
    expect(c.complete).toBe(true);
    expect(c.missing).toEqual([]);
    expect(c.taskDetailByRecipient.rose_noname["Personal Care"]).toContain("Bathing");
  });

  it("counts explicit 'none'/'declined' answers as filled", async () => {
    seedPlan({
      detail: { rose_noname: { Companionship: ["Daily visits"] } },
      medications: [],
      medicationsConfirmedNone: true,
      emergencyContactDeclined: true,
    });
    const c = await getCarePlanCompleteness(CLIENT);
    expect(c.complete).toBe(true);
    expect(c.filled.join(" ")).toMatch(/family confirmed: none/);
  });

  it("stays incomplete while ANY recipient lacks task detail", async () => {
    h.docs.set(`carePlans/${CLIENT}`, {
      recipientPlans: {
        rose_noname: { name: "Rose", careNeedDetails: { "Meal Preparation": ["Lunch"] }, careNeeds: ["Meal Preparation"] },
        ed_noname:   { name: "Ed" },
      },
    });
    h.docs.set(`care_plans/${CLIENT}`, { medicationsConfirmedNone: true, emergencyContacts: [{ name: "A", phone: "1" }] });
    const c = await getCarePlanCompleteness(CLIENT);
    expect(c.complete).toBe(false);
    expect(c.missing.join(" ")).toMatch(/Ed/);
  });
});

describe("carePlanInterviewPending", () => {
  it("gates on the kill switch", () => {
    const s = { carePlanInterviewActive: true };
    expect(carePlanInterviewPending(s)).toBe(true);
    process.env.CARE_PLAN_INTERVIEW_ENABLED = "false";
    expect(carePlanInterviewPending(s)).toBe(false);
  });

  it("is false once completed or when never started", () => {
    expect(carePlanInterviewPending({})).toBe(false);
    expect(carePlanInterviewPending({ carePlanInterviewActive: true, carePlanInterviewCompletedAt: "2026-07-15" })).toBe(false);
    expect(carePlanInterviewPending(undefined)).toBe(false);
  });
});

describe("buildCarePlanInterviewDirective", () => {
  it("lists filled fields as never-re-ask and missing fields in order", async () => {
    seedPlan({
      detail: { rose_noname: { "Personal Care": ["Bathing"] } },
      medications: [{ name: "metformin" }],
    });
    const d = await buildCarePlanInterviewDirective(CLIENT, undefined);
    expect(d).toMatch(/NEVER re-ask/);
    expect(d).toMatch(/day-to-day care tasks for rose/i);
    expect(d).toMatch(/emergency contact/);
    expect(d).not.toMatch(/Still needed.*medications/); // meds are filled
  });

  it("returns empty when the plan is already complete", async () => {
    seedPlan({
      detail: { rose_noname: { Transportation: ["Doctor appointments"] } },
      medicationsConfirmedNone: true,
      emergencyContacts: [{ name: "A", phone: "1" }],
    });
    expect(await buildCarePlanInterviewDirective(CLIENT, undefined)).toBe("");
  });
});

describe("buildCaregiverSafeCareSummary — the privacy choke point", () => {
  it("merges task detail across recipients without names, deduped", () => {
    const { summary, careTypes } = buildCaregiverSafeCareSummary(
      {
        rose_noname: { "Personal Care": ["Bathing", "Dressing"], Transportation: ["Doctor appointments"] },
        ed_noname:   { "Personal Care": ["Bathing"], "Meal Preparation": ["Dinner"] },
      },
      ["Companionship"],
    );
    expect(summary).toMatch(/Personal Care \(bathing, dressing\)/);
    expect(summary).toMatch(/Meal Preparation/);
    expect(summary).not.toMatch(/rose|ed/i);           // recipient names never flow
    expect(careTypes).toEqual(expect.arrayContaining(["Companionship", "Personal Care", "Transportation", "Meal Preparation"]));
  });

  it("physically cannot emit medical data — inputs are task fields only", () => {
    // The signature accepts (taskDetailByRecipient, careTypes) — there is no
    // parameter through which medications/diagnoses/contacts could arrive.
    const { summary } = buildCaregiverSafeCareSummary({ k: { "Medication Reminders": ["Morning", "Evening"] } }, []);
    expect(summary).toBe("Medication Reminders (morning, evening)");
  });
});

describe("enrichJobPostFromCarePlan — targeted update, never a rebuild", () => {
  it("updates careTypes/requirements/description and NOTHING that would reset engagement", async () => {
    h.docs.set(`job_posts/${CLIENT}`, {
      status: "open", description: "Care for Rose in San Jose.",
      applicantCount: 3, notifiedCount: 7, createdAt: "2026-07-14T00:00:00.000Z",
    });
    await enrichJobPostFromCarePlan(CLIENT, { summary: "Personal Care (bathing)", careTypes: ["Personal Care"] });
    const w = h.writes.find((x) => x.path === `job_posts/${CLIENT}`);
    expect(w?.op).toBe("update");
    expect(w?.data.careTypes).toEqual(["Personal Care"]);
    expect(w?.data.requirements).toEqual(["Personal Care"]);
    expect(String(w?.data.description)).toMatch(/Day-to-day tasks: Personal Care \(bathing\)/);
    expect(w?.data).not.toHaveProperty("applicantCount");
    expect(w?.data).not.toHaveProperty("notifiedCount");
    expect(w?.data).not.toHaveProperty("createdAt");
    expect(w?.data).not.toHaveProperty("status");
  });

  it("is idempotent on description (marker replaces, never stacks)", async () => {
    h.docs.set(`job_posts/${CLIENT}`, {
      status: "open",
      description: "Care for Rose.\n\nDay-to-day tasks: old summary",
    });
    await enrichJobPostFromCarePlan(CLIENT, { summary: "new summary", careTypes: [] });
    const w = h.writes.find((x) => x.path === `job_posts/${CLIENT}`);
    const desc = String(w?.data.description);
    expect(desc).toMatch(/Day-to-day tasks: new summary/);
    expect(desc).not.toMatch(/old summary/);
  });

  it("skips closed jobs entirely", async () => {
    h.docs.set(`job_posts/${CLIENT}`, { status: "closed", description: "x" });
    await enrichJobPostFromCarePlan(CLIENT, { summary: "s", careTypes: ["A"] });
    expect(h.writes.filter((x) => x.path === `job_posts/${CLIENT}`)).toEqual([]);
  });
});
