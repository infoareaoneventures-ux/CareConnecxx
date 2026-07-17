import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Multi-recipient household scoping (2026-07-16): update_care_plan with
// recipientFirstName writes the recipientMedical map + household-union mirror.
// Harness mirrors crudTools.test.ts (in-memory Firestore).
const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${adds.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${adds.length}`;
      adds.push({ path, data, id });
      docState.set(`${path}/${id}`, data);
      return { id };
    });
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, sets, adds, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  vi.fn().mockResolvedValue(""),
  writeMemoryFile: vi.fn().mockResolvedValue(undefined),
  MemoryFile: {},
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

// The high-risk confirmation gate (propose→confirm SMS round-trip) is tested in
// pendingActions.test.ts — bypass it here so these tests exercise the scoping
// write path itself.
vi.mock("../../agents/pendingActions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isHighRisk: () => false,
}));

import { handleToolCall } from "../server";

const CLIENT = "c1";
const twoRecipientHousehold = () => {
  hoisted.docState.set(`carePlans/${CLIENT}`, {
    recipientPlans: {
      mary_noname: { name: "Mary" },
      john_noname: { name: "John" },
    },
  });
};

const setsFor = (path: string) => hoisted.sets.filter((s) => s.path === path);

describe("update_care_plan — multi-recipient scoping", () => {
  beforeEach(() => { hoisted.reset(); delete process.env.MULTI_RECIPIENT_SCOPING_ENABLED; });
  afterEach(() => { delete process.env.MULTI_RECIPIENT_SCOPING_ENABLED; });

  it("scoped append writes recipientMedical entry + household arrayUnion mirror", async () => {
    twoRecipientHousehold();
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "medications", value: "Aspirin 81mg", action: "append",
      recipientFirstName: "Mary",
    }) as any;
    expect(r.success).toBe(true);
    expect(r.scoped).toBe(true);
    expect(r.recipient).toBe("mary_noname");

    const planSets = setsFor(`care_plans/${CLIENT}`);
    const mapWrite = planSets.find((s) => s.data.recipientMedical);
    expect(mapWrite?.data.recipientMedical.mary_noname.medications).toEqual(["Aspirin 81mg"]);
    expect(mapWrite?.data.recipientMedical.mary_noname.name).toBe("Mary");
    const mirror = planSets.find((s) => s.data.medications?.__arrayUnion);
    expect(mirror?.data.medications.__arrayUnion).toEqual(["Aspirin 81mg"]);
  });

  it("scoped remove keeps the household mirror when the other recipient still has the value", async () => {
    twoRecipientHousehold();
    hoisted.docState.set(`care_plans/${CLIENT}`, {
      medications: ["Aspirin"],
      recipientMedical: {
        mary_noname: { medications: ["Aspirin"] },
        john_noname: { medications: ["Aspirin"] },
      },
    });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "medications", value: "Aspirin", action: "remove",
      recipientFirstName: "Mary",
    }) as any;
    expect(r.scoped).toBe(true);
    const planSets = setsFor(`care_plans/${CLIENT}`);
    const mapWrite = planSets.find((s) => s.data.recipientMedical);
    expect(mapWrite?.data.recipientMedical.mary_noname.medications).toEqual([]);
    // John still takes it — the union must NOT shrink.
    expect(planSets.some((s) => s.data.medications?.__arrayRemove)).toBe(false);
  });

  it("scoped remove shrinks the mirror when nobody else has the value", async () => {
    twoRecipientHousehold();
    hoisted.docState.set(`care_plans/${CLIENT}`, {
      medications: ["Insulin"],
      recipientMedical: { mary_noname: { medications: ["Insulin"] } },
    });
    await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "medications", value: "Insulin", action: "remove",
      recipientFirstName: "Mary",
    });
    const planSets = setsFor(`care_plans/${CLIENT}`);
    expect(planSets.some((s) => s.data.medications?.__arrayRemove)).toBe(true);
  });

  it("scalar scoped field (dietaryNotes) writes per-person only — no household mirror", async () => {
    twoRecipientHousehold();
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "dietaryNotes", value: "low sodium", action: "set",
      recipientFirstName: "John",
    }) as any;
    expect(r.scoped).toBe(true);
    const planSets = setsFor(`care_plans/${CLIENT}`);
    const mapWrite = planSets.find((s) => s.data.recipientMedical);
    expect(mapWrite?.data.recipientMedical.john_noname.dietaryNotes).toBe("low sodium");
    expect(planSets.some((s) => "dietaryNotes" in s.data && !s.data.recipientMedical)).toBe(false);
  });

  it("unscoped write in a 2-recipient household succeeds account-level with a nudge note", async () => {
    twoRecipientHousehold();
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "medications", value: "Metformin", action: "append",
    }) as any;
    expect(r.success).toBe(true);
    expect(r.scoped).toBe(false);
    expect(r.note).toMatch(/2 care recipients/);
    const planSets = setsFor(`care_plans/${CLIENT}`);
    expect(planSets.some((s) => s.data.medications?.__arrayUnion)).toBe(true);
    expect(planSets.some((s) => s.data.recipientMedical)).toBe(false);
  });

  it("single-recipient household without a name behaves exactly as before (no note, no map)", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: { mary_noname: { name: "Mary" } } });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "medications", value: "Aspirin", action: "append",
    }) as any;
    expect(r.success).toBe(true);
    expect(r.scoped).toBeUndefined();
    expect(r.note).toBeUndefined();
    expect(setsFor(`care_plans/${CLIENT}`).some((s) => s.data.recipientMedical)).toBe(false);
  });

  it("kill switch off reverts to account-level writes even with recipientFirstName", async () => {
    process.env.MULTI_RECIPIENT_SCOPING_ENABLED = "false";
    twoRecipientHousehold();
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "medications", value: "Aspirin", action: "append",
      recipientFirstName: "Mary",
    }) as any;
    expect(r.success).toBe(true);
    expect(r.scoped).toBeUndefined();
    expect(setsFor(`care_plans/${CLIENT}`).some((s) => s.data.recipientMedical)).toBe(false);
  });

  it("diagnoses is now an allowed field", async () => {
    hoisted.docState.set(`carePlans/${CLIENT}`, { recipientPlans: {} });
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "diagnoses", value: "dementia", action: "append",
    }) as any;
    expect(r.success).toBe(true);
  });

  it("household-level fields (emergencyContacts) are never scoped", async () => {
    twoRecipientHousehold();
    const r = await handleToolCall("update_care_plan", {
      clientId: CLIENT, field: "emergencyContacts",
      value: { name: "Sam", relation: "son", phone: "555", isPrimary: true }, action: "append",
      recipientFirstName: "Mary",
    }) as any;
    expect(r.success).toBe(true);
    expect(r.scoped).toBeUndefined();
    expect(setsFor(`care_plans/${CLIENT}`).some((s) => s.data.recipientMedical)).toBe(false);
  });
});
