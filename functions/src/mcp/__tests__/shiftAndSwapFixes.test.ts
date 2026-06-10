// Guards the no-silent-auto-booking contract at the MCP tool surface:
//  - reschedule_appointment must NOT move the appointment before the caregiver accepts
//  - initiate_client_swap must only offer bookable (profile_complete + approved) caregivers

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const sendMessage = vi.fn().mockResolvedValue({ message_id: "m1" });
vi.mock("../../linq/client", () => ({
  sendMessage:        (...args: unknown[]) => sendMessage(...args),
  getOrCreateSession: vi.fn().mockResolvedValue({ chatId: "chat-cg" }),
  sendToPhone:        vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));

import { handleToolCall } from "../server";

describe("reschedule_appointment — caregiver acceptance required", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

  it("keeps the original schedule and creates a pending time_change offer", async () => {
    hoisted.docState.set("appointments/a1", {
      clientId: "c1", status: "confirmed", caregiverId: "cg1", caregiverName: "Alice",
      date: "2026-06-18", startTime: "09:00", endTime: "11:00", durationHours: 2,
    });
    hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });

    const r = await handleToolCall("reschedule_appointment", {
      appointmentId: "a1", clientId: "c1", newDate: "2026-06-20", newTime: "14:00",
    }) as any;

    expect(r.success).toBe(true);
    expect(r.status).toBe("pending_caregiver_confirmation");
    expect(r.note).toContain("until");

    const appt = hoisted.docState.get("appointments/a1");
    expect(appt.date).toBe("2026-06-18");        // NOT moved
    expect(appt.startTime).toBe("09:00");        // NOT moved
    expect(appt.pendingTimeChange).toMatchObject({
      newDate: "2026-06-20", newStartTime: "14:00",
    });

    const offer = hoisted.adds.find((a) => a.path === "shift_offers");
    expect(offer).toBeTruthy();
    expect(offer!.data.kind).toBe("time_change");
    expect(offer!.data.payload).toMatchObject({ previousDate: "2026-06-18", newDate: "2026-06-20" });
    expect(sendMessage).toHaveBeenCalledWith("chat-cg", expect.stringContaining("Reply YES"));
  });

  it("still blocks reschedules of completed/cancelled appointments", async () => {
    hoisted.docState.set("appointments/a1", { clientId: "c1", status: "completed", caregiverId: "cg1" });
    const r = await handleToolCall("reschedule_appointment", {
      appointmentId: "a1", clientId: "c1", newDate: "2026-06-20", newTime: "14:00",
    }) as any;
    expect(r._toolError).toBe(true);
  });
});

describe("initiate_client_swap — bookable-only replacement options", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

  it("excludes caregivers who are not profile_complete + approved", async () => {
    hoisted.docState.set("appointments/a1", {
      clientId: "c1", caregiverId: "cg-current", caregiverName: "Current",
      date: "2026-06-19", time: "10:00",
    });
    // 2026-06-19 is a Friday UTC; include Thursday too so the local-TZ
    // weekday rendering in the tool can't shift the slot off by a day.
    const weekly = {
      friday:   [{ start: "08:00", end: "18:00" }],
      thursday: [{ start: "08:00", end: "18:00" }],
    };
    hoisted.collState.set("caregivers", [
      // bookable — should appear
      { id: "cg-ok", name: "Bookable Betty", verified: true, onboardingStatus: "profile_complete", verificationStatus: "approved", weeklyAvailability: weekly, hourlyRate: 25 },
      // verified flag set but verification NOT approved (e.g. consider) — must be excluded
      { id: "cg-consider", name: "Consider Carl", verified: true, onboardingStatus: "profile_complete", verificationStatus: "pre_adverse_action", weeklyAvailability: weekly, hourlyRate: 22 },
      // approved but onboarding incomplete — must be excluded
      { id: "cg-incomplete", name: "Incomplete Ida", verified: true, onboardingStatus: "incomplete", verificationStatus: "approved", weeklyAvailability: weekly, hourlyRate: 24 },
    ]);

    const r = await handleToolCall("initiate_client_swap", { appointmentId: "a1" }) as any;
    expect(Array.isArray(r.available)).toBe(true);
    const names = r.available.map((o: any) => o.name);
    expect(names).toContain("Bookable Betty");
    expect(names).not.toContain("Consider Carl");
    expect(names).not.toContain("Incomplete Ida");
  });
});
