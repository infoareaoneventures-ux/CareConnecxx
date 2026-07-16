import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Query-capable doc-store mock: docs keyed "collection/id". where() filters over
// direct children of a collection by equality; doc refs from queries write back
// into the store (so sent-guards written this run are observable on re-run).
const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const writes: Array<{ op: "set" | "update"; path: string; data: Record<string, unknown> }> = [];
  const sendMessage = vi.fn(async () => ({ message_id: "m" }));
  const getOrCreateSession = vi.fn(async (_phone: string) => ({ chatId: "chat", optedOut: false }));

  const makeDocRef = (coll: string, id: string) => ({
    id,
    get: async () => {
      const d = docs.get(`${coll}/${id}`);
      return { exists: !!d, data: () => d ?? undefined };
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      writes.push({ op: "set", path: `${coll}/${id}`, data });
      const prev = docs.get(`${coll}/${id}`) ?? {};
      docs.set(`${coll}/${id}`, opts?.merge ? { ...prev, ...data } : data);
    },
    update: async (data: Record<string, unknown>) => {
      writes.push({ op: "update", path: `${coll}/${id}`, data });
      docs.set(`${coll}/${id}`, { ...(docs.get(`${coll}/${id}`) ?? {}), ...data });
    },
  });

  const queryDocs = (coll: string, filters: Array<[string, string, unknown]>) => {
    const out: Array<{ id: string; data: () => Record<string, unknown>; ref: ReturnType<typeof makeDocRef> }> = [];
    for (const [key, data] of docs) {
      if (!key.startsWith(`${coll}/`)) continue;
      const id = key.slice(coll.length + 1);
      if (id.includes("/")) continue; // direct children only
      if (filters.every(([f, , v]) => (data as Record<string, unknown>)[f] === v)) {
        out.push({ id, data: () => data, ref: makeDocRef(coll, id) });
      }
    }
    return out;
  };

  const makeQuery = (coll: string, filters: Array<[string, string, unknown]>): any => ({
    doc: (id: string) => makeDocRef(coll, id),
    where: (f: string, op: string, v: unknown) => makeQuery(coll, [...filters, [f, op, v]]),
    limit: () => makeQuery(coll, filters),
    get: async () => { const d = queryDocs(coll, filters); return { empty: d.length === 0, docs: d }; },
  });

  const firestoreFn: any = () => ({
    collection: (coll: string) => makeQuery(coll, []),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => { ref.set(data, opts); },
      update: (ref: any, data: Record<string, unknown>) => { ref.update(data); },
    }),
  });
  firestoreFn.FieldValue = { delete: () => "__DELETE__" };
  return { docs, writes, firestoreFn, sendMessage, getOrCreateSession };
});

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: h.firestoreFn }, firestore: h.firestoreFn }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback) }));
vi.mock("../linq/client", () => ({
  sendMessage: (...a: unknown[]) => h.sendMessage(...(a as [])),
  getOrCreateSession: (...a: unknown[]) => h.getOrCreateSession(...(a as [string])),
}));

import {
  getCarePlanCompleteness,
  carePlanInterviewPending,
  buildCarePlanInterviewDirective,
  buildCaregiverSafeCareSummary,
  enrichJobPostFromCarePlan,
  notifyEngagedCaregiversOfCarePlan,
  startCarePlanInterview,
} from "./carePlanInterview";

beforeEach(() => {
  h.docs.clear();
  h.writes.length = 0;
  h.sendMessage.mockClear();
  h.getOrCreateSession.mockClear();
  h.getOrCreateSession.mockImplementation(async () => ({ chatId: "chat", optedOut: false }));
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

  it("includes the drug-name privacy rule for task strings", async () => {
    const d = await buildCarePlanInterviewDirective(CLIENT, { seniorName: "Rose" });
    expect(d).toMatch(/NEVER a drug name/i);
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

  it("is idempotent on the appended block (replaces, never stacks)", async () => {
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

  it("preserves family text that contains the marker phrase mid-sentence (U3)", async () => {
    h.docs.set(`job_posts/${CLIENT}`, {
      status: "open",
      description: "Rose needs help. Day-to-day tasks: are honestly her favorite topic.",
    });
    await enrichJobPostFromCarePlan(CLIENT, { summary: "Personal Care (bathing)", careTypes: ["Personal Care"] });
    const desc = String(h.writes.find((x) => x.path === `job_posts/${CLIENT}`)?.data.description);
    expect(desc).toMatch(/are honestly her favorite topic\./);          // family text survives
    expect(desc).toMatch(/\n\nDay-to-day tasks: Personal Care \(bathing\)$/); // our block appended once at the end
  });

  it("skips closed jobs entirely", async () => {
    h.docs.set(`job_posts/${CLIENT}`, { status: "closed", description: "x" });
    await enrichJobPostFromCarePlan(CLIENT, { summary: "s", careTypes: ["A"] });
    expect(h.writes.filter((x) => x.path === `job_posts/${CLIENT}`)).toEqual([]);
  });
});

describe("notifyEngagedCaregiversOfCarePlan — engaged targeting + guard hygiene", () => {
  const SAFE = { summary: "Personal Care (bathing)", careTypes: ["Personal Care"] };

  it("texts an interested caregiver and guards on the EXISTING notification doc (no marker doc)", async () => {
    h.docs.set("job_notifications/n1", { jobId: CLIENT, phone: "+1408", status: "interested", sentAt: "2026-07-15" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    // guard stamped on the real notification doc
    expect(h.docs.get("job_notifications/n1")).toMatchObject({ carePlanUpdateSentAt: expect.any(String) });
    // NO new job_notifications doc was created (only n1 exists)
    const notifKeys = [...h.docs.keys()].filter((k) => k.startsWith("job_notifications/"));
    expect(notifKeys).toEqual(["job_notifications/n1"]);
  });

  it("guards an application-only caregiver on the APPLICATION doc, never a job_notifications marker", async () => {
    h.docs.set("job_applications/app1", { jobId: CLIENT, phone: "+1650" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(1);
    // guard landed on the application doc
    expect(h.docs.get("job_applications/app1")).toMatchObject({ carePlanUpdateSentAt: expect.any(String) });
    // critically: NO doc was minted in job_notifications (which would wedge notifyFamilyIfAllDeclined)
    const notifKeys = [...h.docs.keys()].filter((k) => k.startsWith("job_notifications/"));
    expect(notifKeys).toEqual([]);
  });

  it("resolves a web applicant's phone from the caregiver doc and guards on the application doc", async () => {
    h.docs.set("job_applications/app1", { jobId: CLIENT, caregiverId: "cg9" }); // no phone — web-originated
    h.docs.set("caregivers/cg9", { phone: "+1999" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(1);
    expect(h.getOrCreateSession).toHaveBeenCalledWith("+1999");
    expect(h.docs.get("job_applications/app1")).toMatchObject({ carePlanUpdateSentAt: expect.any(String) });
    expect([...h.docs.keys()].filter((k) => k.startsWith("job_notifications/"))).toEqual([]);
  });

  it("skips a web applicant whose phone cannot be resolved (no caregiver doc)", async () => {
    h.docs.set("job_applications/app1", { jobId: CLIENT, caregiverId: "ghost" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("does not re-send when the notification doc already carries the guard (poison)", async () => {
    h.docs.set("job_notifications/n1", { jobId: CLIENT, phone: "+1408", status: "interested", sentAt: "x", carePlanUpdateSentAt: "y" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("does not re-send when the application doc already carries the guard", async () => {
    h.docs.set("job_applications/app1", { jobId: CLIENT, phone: "+1650", carePlanUpdateSentAt: "y" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("dedupes one phone that both has a notification and applied — single send", async () => {
    h.docs.set("job_notifications/n1", { jobId: CLIENT, phone: "+1777", status: "applied", sentAt: "x" });
    h.docs.set("job_applications/app1", { jobId: CLIENT, phone: "+1777" });
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("skips opted-out caregivers", async () => {
    h.docs.set("job_notifications/n1", { jobId: CLIENT, phone: "+1408", status: "interested", sentAt: "x" });
    h.getOrCreateSession.mockImplementation(async () => ({ chatId: "chat", optedOut: true }));
    const sent = await notifyEngagedCaregiversOfCarePlan(CLIENT, SAFE);
    expect(sent).toBe(0);
  });
});

describe("startCarePlanInterview — transactional single-send claim", () => {
  const session = () => ({ userId: CLIENT, chatId: "chat", onboardingData: { seniorName: "Rose", careNeeds: ["bathing"] } });

  it("claims the interview and sends the first question", async () => {
    const ok = await startCarePlanInterview("+1408", "chat", session());
    expect(ok).toBe(true);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.docs.get("agent_sessions/+1408")).toMatchObject({ carePlanInterviewActive: true });
  });

  it("refuses when the flag is already set in the store (racing kickoff loses the claim)", async () => {
    h.docs.set("agent_sessions/+1408", { carePlanInterviewActive: true });
    const ok = await startCarePlanInterview("+1408", "chat", session()); // in-hand session lacks the flag
    expect(ok).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses when the kill switch is off", async () => {
    process.env.CARE_PLAN_INTERVIEW_ENABLED = "false";
    const ok = await startCarePlanInterview("+1408", "chat", session());
    expect(ok).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("skips when the plan is already complete", async () => {
    seedPlan({
      detail: { rose_noname: { "Personal Care": ["Bathing"] } },
      medicationsConfirmedNone: true,
      emergencyContacts: [{ name: "A", phone: "1" }],
    });
    const ok = await startCarePlanInterview("+1408", "chat", session());
    expect(ok).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});
