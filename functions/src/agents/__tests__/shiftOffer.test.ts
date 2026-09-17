import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore harness (booking.test.ts pattern) + runTransaction support
// for the single-fire offer claim.
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

  // Transaction shim: sequential get/update against the same in-memory state.
  const runTransaction = vi.fn(async (fn: (t: any) => Promise<any>) => {
    const t = {
      get: async (ref: any) => ref.get(),
      update: (ref: any, data: any) => {
        updates.push({ path: ref.path, data });
        docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data });
      },
    };
    return fn(t);
  });

  // batch shim — applied immediately (commit is a no-op marker)
  const makeBatch = () => ({
    update: (ref: any, data: any) => {
      updates.push({ path: ref.path, data });
      docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data });
    },
    set: (ref: any, data: any) => {
      sets.push({ path: ref.path, data });
      docState.set(ref.path, data);
    },
    commit: vi.fn(async () => undefined),
  });

  return {
    docState, collState, sets, adds, updates, runTransaction,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    makeBatch,
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = () => ({
    collection:     hoisted.collectionMock,
    runTransaction: hoisted.runTransaction,
    batch:          hoisted.makeBatch,
  });
  return {
    __esModule: true,
    default: { firestore: firestoreFn },
    firestore: Object.assign(firestoreFn, {
      FieldValue: {
        arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
        arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
        increment:   (n: number) => ({ __increment: n }),
        delete:      () => ({ __delete: true }),
      },
    }),
  };
});

const sendMessage = vi.fn().mockResolvedValue({ message_id: "m1" });
const getOrCreateSession = vi.fn().mockResolvedValue({ chatId: "chat-cg" });
vi.mock("../../linq/client", () => ({
  sendMessage:        (...args: unknown[]) => sendMessage(...args),
  getOrCreateSession: (...args: unknown[]) => getOrCreateSession(...args),
  sendToPhone:        vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));

const classifyApproval = vi.fn();
vi.mock("../approvalHandler", () => ({
  classifyApproval: (...args: unknown[]) => classifyApproval(...args),
}));

import { createShiftOffer, handleShiftOfferReply, expireShiftOffers } from "../shiftOffer";

const CG_PHONE = "+15555550101";
const FUTURE   = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST     = new Date(Date.now() - 60 * 1000).toISOString();

// 2026-09-17: the "booking" offer kind is gone (a new booking request is the
// site's own booking_requests doc, accepted on the caregiver's My Bookings
// page) — the default fixture is a client-requested swap.
function seedBookingOffer(overrides: Record<string, unknown> = {}) {
  hoisted.docState.set("shift_offers/offer1", {
    kind: "swap", status: "pending", payload: { date: "2026-06-15" },
    caregiverId: "cg1", caregiverName: "Alice", caregiverPhone: CG_PHONE,
    clientId: "c1", clientPhone: "+15555550100",
    appointmentIds: ["a1"],
    summary: "Cover Mary's visit on 2026-06-15",
    createdAt: PAST, expiresAt: FUTURE,
    ...overrides,
  });
  hoisted.docState.set(`agent_sessions/${CG_PHONE}`, { chatId: "chat-cg", pendingShiftOfferId: "offer1" });
  hoisted.docState.set("agent_sessions/+15555550100", { chatId: "chat-family", userId: "c1" });
  hoisted.docState.set("appointments/a1", { status: "confirmed", clientId: "c1", caregiverId: "cg-old", caregiverName: "Old" });
}

describe("createShiftOffer", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); getOrCreateSession.mockResolvedValue({ chatId: "chat-cg" }); });

  it("writes a pending shift_offers doc, flags the caregiver session, and sends a YES/NO prompt", async () => {
    hoisted.docState.set(`agent_sessions/${CG_PHONE}`, { chatId: "chat-cg" });
    const offerId = await createShiftOffer({
      kind: "swap", caregiverId: "cg1", caregiverName: "Alice", caregiverPhone: CG_PHONE,
      clientId: "c1", clientPhone: "+15555550100", appointmentIds: ["a1"], payload: { date: "2026-06-15" },
      summary: "Cover a visit", offerMessage: "Can you cover this visit?",
    });
    expect(offerId).toBeTruthy();
    const add = hoisted.adds.find((a) => a.path === "shift_offers")!;
    expect(add.data.status).toBe("pending");
    expect(add.data.kind).toBe("swap");
    expect(new Date(add.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const flagUpdate = hoisted.updates.find((u) => u.path === `agent_sessions/${CG_PHONE}`);
    expect(flagUpdate?.data.pendingShiftOfferId).toBe(offerId);
    expect(sendMessage).toHaveBeenCalledWith("chat-cg", expect.stringContaining("Reply YES to accept or NO to decline"));
  });
});

describe("handleShiftOfferReply", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); getOrCreateSession.mockResolvedValue({ chatId: "chat-cg" }); });

  it("falls through when no offer flag is set", async () => {
    hoisted.docState.set(`agent_sessions/${CG_PHONE}`, { chatId: "chat-cg" });
    const r = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "hello" });
    expect(r).toBe("fallthrough");
    expect(classifyApproval).not.toHaveBeenCalled();
  });

  it("clears a stale flag (offer already resolved) and falls through", async () => {
    seedBookingOffer({ status: "accepted" });
    const r = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "yes" });
    expect(r).toBe("fallthrough");
    const flagClear = hoisted.updates.find((u) => u.path === `agent_sessions/${CG_PHONE}` && u.data.pendingShiftOfferId?.__delete);
    expect(flagClear).toBeTruthy();
  });

  it("falls through on QUESTION and keeps the offer pending", async () => {
    seedBookingOffer();
    classifyApproval.mockResolvedValueOnce("QUESTION");
    const r = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "what time is it?" });
    expect(r).toBe("fallthrough");
    expect(hoisted.docState.get("shift_offers/offer1").status).toBe("pending");
  });

  it("YES on a swap offer reassigns the appointment to the new caregiver", async () => {
    seedBookingOffer({ kind: "swap", payload: { date: "2026-06-15" }, agentTaskId: undefined });
    hoisted.docState.set("appointments/a1", { status: "confirmed", clientId: "c1", caregiverId: "cg-old", caregiverName: "Old" });
    classifyApproval.mockResolvedValueOnce("YES");
    const r = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "sure" });
    expect(r).toBe("handled");
    const appt = hoisted.docState.get("appointments/a1");
    expect(appt.caregiverId).toBe("cg1");
    expect(appt.caregiverName).toBe("Alice");
  });

  it("NO on a swap offer leaves the appointment untouched", async () => {
    seedBookingOffer({ kind: "swap", payload: { date: "2026-06-15" }, agentTaskId: undefined });
    hoisted.docState.set("appointments/a1", { status: "confirmed", clientId: "c1", caregiverId: "cg-old", caregiverName: "Old" });
    classifyApproval.mockResolvedValueOnce("NO");
    const r = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "can't" });
    expect(r).toBe("handled");
    const appt = hoisted.docState.get("appointments/a1");
    expect(appt.caregiverId).toBe("cg-old"); // unchanged — swap never applied
    expect(appt.status).toBe("confirmed");
  });

  it("YES on a time_change applies the new schedule and clears pendingTimeChange", async () => {
    seedBookingOffer({
      kind: "time_change", agentTaskId: undefined,
      payload: { newDate: "2026-06-20", newStartTime: "14:00", newEndTime: "16:00", previousDate: "2026-06-18", previousStartTime: "09:00" },
    });
    hoisted.docState.set("appointments/a1", { status: "confirmed", clientId: "c1", caregiverId: "cg1", date: "2026-06-18", startTime: "09:00", pendingTimeChange: { newDate: "2026-06-20" } });
    classifyApproval.mockResolvedValueOnce("YES");
    await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "yes" });
    const appt = hoisted.docState.get("appointments/a1");
    expect(appt.date).toBe("2026-06-20");
    expect(appt.startTime).toBe("14:00");
    expect(appt.pendingTimeChange.__delete).toBe(true);
  });

  it("NO on a time_change keeps the original schedule", async () => {
    seedBookingOffer({
      kind: "time_change", agentTaskId: undefined,
      payload: { newDate: "2026-06-20", newStartTime: "14:00", newEndTime: "16:00", previousDate: "2026-06-18", previousStartTime: "09:00" },
    });
    hoisted.docState.set("appointments/a1", { status: "confirmed", clientId: "c1", caregiverId: "cg1", date: "2026-06-18", startTime: "09:00", pendingTimeChange: { newDate: "2026-06-20" } });
    classifyApproval.mockResolvedValueOnce("NO");
    await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "no" });
    const appt = hoisted.docState.get("appointments/a1");
    expect(appt.date).toBe("2026-06-18");
    expect(appt.startTime).toBe("09:00");
    expect(appt.pendingTimeChange.__delete).toBe(true);
  });

  it("expired-but-unswept offer resolves as expired and notifies", async () => {
    seedBookingOffer({ expiresAt: PAST });
    const r = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "yes" });
    expect(r).toBe("handled");
    expect(classifyApproval).not.toHaveBeenCalled(); // never classified — expiry wins
    expect(hoisted.docState.get("shift_offers/offer1").status).toBe("expired");
    // Swap declined/expired: the appointment is never modified.
    expect(hoisted.docState.get("appointments/a1").caregiverId).toBe("cg-old");
  });

  it("single-fire: a second YES after resolution does not re-execute", async () => {
    seedBookingOffer();
    classifyApproval.mockResolvedValue("YES");
    await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "yes" });
    expect(hoisted.docState.get("shift_offers/offer1").status).toBe("accepted");
    const swapWrites = () => hoisted.updates.filter((u) => u.path === "appointments/a1" && u.data.swapAcceptedAt).length;
    expect(swapWrites()).toBe(1);
    // Flag cleared in state; restore it to simulate a duplicate webhook delivery
    hoisted.docState.set(`agent_sessions/${CG_PHONE}`, { chatId: "chat-cg", pendingShiftOfferId: "offer1" });
    const r2 = await handleShiftOfferReply({ phone: CG_PHONE, chatId: "chat-cg", text: "yes" });
    expect(r2).toBe("fallthrough"); // offer no longer pending → stale-flag path
    expect(swapWrites()).toBe(1);
  });
});

describe("expireShiftOffers", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); getOrCreateSession.mockResolvedValue({ chatId: "chat-cg" }); });

  it("expires only past-TTL pending offers and runs the non-acceptance flow", async () => {
    seedBookingOffer({ expiresAt: PAST });
    hoisted.collState.set("shift_offers", [
      { id: "offer1", ...hoisted.docState.get("shift_offers/offer1") },
      { id: "offer2", kind: "swap", status: "pending", caregiverId: "cg2", caregiverName: "B", caregiverPhone: "+15555550102", clientId: "c2", clientPhone: "+15555550103", appointmentIds: [], summary: "x", createdAt: PAST, expiresAt: FUTURE },
    ]);
    hoisted.docState.set("shift_offers/offer2", hoisted.collState.get("shift_offers")![1]);
    const n = await expireShiftOffers();
    expect(n).toBe(1);
    expect(hoisted.docState.get("shift_offers/offer1").status).toBe("expired");
    expect(hoisted.docState.get("shift_offers/offer2").status).toBe("pending");
  });
});
