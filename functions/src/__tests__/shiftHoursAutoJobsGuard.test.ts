import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C9 (2026-10-11): autoApproveShiftHours / autoAcceptCorrection
// used to write on the query's snapshot — a family approval / correction or a
// caregiver counter landing in the same window was overwritten. Both sweeps now
// re-read INSIDE a transaction (like billing/approvalNoticeDispatcher.ts) and
// write only while the status is still the one the job expected.
//
// The fake Firestore here separates the QUERY snapshot (stale copy, what the
// sweep iterates) from the LIVE document (what the transaction re-reads).

const hoisted = vi.hoisted(() => {
  const live = new Map<string, Record<string, any>>();
  const stale = new Map<string, Record<string, any>>();
  const updates: Array<{ path: string; data: Record<string, any> }> = [];
  const texts: string[] = [];
  const bells: any[] = [];
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: live.has(path), data: () => live.get(path) }),
    update: async (d: Record<string, any>) => { updates.push({ path, data: d }); live.set(path, { ...(live.get(path) ?? {}), ...d }); },
    collection: (name: string) => makeCollection(`${path}/${name}`),
  });
  const makeQuery = (colPath: string): any => ({
    where: () => makeQuery(colPath), limit: () => makeQuery(colPath), orderBy: () => makeQuery(colPath),
    get: async () => {
      const docs = [...stale.entries()].filter(([p]) => p.startsWith(`${colPath}/`)).map(([p, d]) => ({ id: p.split("/").pop(), data: () => d, ref: makeDocRef(p) }));
      return { empty: docs.length === 0, docs, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
    },
  });
  const makeCollection = (colPath: string): any => ({
    doc: (id: string) => makeDocRef(`${colPath}/${id}`),
    add: async (d: any) => { bells.push({ colPath, ...d }); return makeDocRef(`${colPath}/auto`); },
    where: () => makeQuery(colPath),
  });
  const firestore: any = () => ({
    collection: (name: string) => makeCollection(name),
    runTransaction: async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => ref.get(),
      update: (ref: any, d: Record<string, any>) => { updates.push({ path: ref.path, data: d }); live.set(ref.path, { ...(live.get(ref.path) ?? {}), ...d }); },
    }),
    batch: () => ({ set: () => {}, update: () => {}, commit: async () => {} }),
  });
  firestore.FieldValue = { serverTimestamp: () => "server-ts", arrayUnion: (...items: any[]) => ({ __arrayUnion: items }) };
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { live, stale, updates, texts, bells, stub };
});

vi.mock("firebase-admin", () => ({ __esModule: true, default: hoisted.stub, ...hoisted.stub }));
vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error { constructor(public code: string, msg: string) { super(msg); } }
  return {
    https: { HttpsError, onCall: (f: any) => f },
    firestore: { document: () => ({ onWrite: (f: any) => f, onUpdate: (f: any) => f, onCreate: (f: any) => f }) },
    pubsub: { schedule: () => ({ onRun: (f: any) => f }) },
    config: () => ({}),
  };
});
vi.mock("../sms", () => ({ sendSMSToUser: vi.fn(async (_uid: string, m: string) => { hoisted.texts.push(m); return { success: true }; }) }));
vi.mock("stripe", () => ({ __esModule: true, default: class StripeMock { constructor(_k?: string, _o?: any) {} } }));
vi.mock("../config/featureFlags", () => ({ timesheetAutoApprovalEnabled: () => true }));

import { autoApproveShiftHours, autoAcceptCorrection } from "../shiftHours";

const PAST = "2000-01-01T00:00:00.000Z";
const pending = {
  clientId: "c1", caregiverId: "cg1", clientName: "The Nguyens", caregiverName: "Alice",
  status: "pending_client_review", approvalNoticeState: "delivered", autoApproveAt: PAST,
  payRate: 30, submittedTotalHours: 4, submittedStartTime: "2026-07-13T09:00:00.000Z", submittedEndTime: "2026-07-13T13:00:00.000Z", lineItems: [],
};
const corrected = {
  clientId: "c1", caregiverId: "cg1", clientName: "The Nguyens", caregiverName: "Alice",
  status: "correction_proposed", correctionRespondByAt: PAST, payRate: 30,
  submittedStartTime: "2026-07-13T09:00:00.000Z", proposedStartTime: "2026-07-13T09:00:00.000Z", proposedEndTime: "2026-07-13T12:00:00.000Z",
};
const seed = (id: string, staleDoc: Record<string, any>, liveDoc: Record<string, any> = staleDoc) => {
  hoisted.stale.set(`shiftHours/${id}`, { ...staleDoc });
  hoisted.live.set(`shiftHours/${id}`, { ...liveDoc });
};
const writesTo = (id: string) => hoisted.updates.filter((u) => u.path === `shiftHours/${id}`);

beforeEach(() => { hoisted.live.clear(); hoisted.stale.clear(); hoisted.updates.length = 0; hoisted.texts.length = 0; hoisted.bells.length = 0; });

describe("autoApproveShiftHours — decides on the live record, inside the write", () => {
  it("still pending → auto-approved from the fresh amounts; the caregiver is told (text first, then bell)", async () => {
    seed("a1", pending);
    await (autoApproveShiftHours as any)();
    expect(hoisted.live.get("shiftHours/a1")).toMatchObject({ status: "auto_approved", grossPay: 120, resolvedBy: "system_auto_approve" });
    expect(hoisted.texts.some((t) => /auto-approved — \$120\.00/.test(t))).toBe(true);
    expect(hoisted.bells.find((b) => b.type === "shift_hours_auto_approved" && b.userId === "cg1")).toBeTruthy();
  });

  it("the family approved (or corrected) between the query and the write → the row is left alone, nobody is told twice", async () => {
    seed("a2", pending, { ...pending, status: "approved", grossPay: 150, resolvedBy: "client" });
    seed("a3", pending, { ...pending, status: "correction_proposed" });
    await (autoApproveShiftHours as any)();
    expect(writesTo("a2")).toHaveLength(0);
    expect(writesTo("a3")).toHaveLength(0);
    expect(hoisted.live.get("shiftHours/a2")).toMatchObject({ status: "approved", grossPay: 150, resolvedBy: "client" });
    expect(hoisted.texts).toHaveLength(0);
    expect(hoisted.bells).toHaveLength(0);
  });

  it("a row whose notice got un-delivered or that now needs explicit approval is skipped on the fresh read too", async () => {
    seed("a4", pending, { ...pending, requiresExplicitApproval: true });
    seed("a5", pending, { ...pending, autoApproveAt: "2999-01-01T00:00:00.000Z" });
    await (autoApproveShiftHours as any)();
    expect(writesTo("a4")).toHaveLength(0);
    expect(writesTo("a5")).toHaveLength(0);
  });
});

describe("autoAcceptCorrection — decides on the live record, inside the write", () => {
  it("still correction_proposed → the family's proposal is final; caregiver told text-then-bell", async () => {
    seed("b1", corrected);
    await (autoAcceptCorrection as any)();
    expect(hoisted.live.get("shiftHours/b1")).toMatchObject({ status: "approved", finalTotalHours: 3, grossPay: 90, resolvedBy: "system_auto_accept" });
    expect(hoisted.texts.some((t) => /proposal is final — \$90\.00/.test(t))).toBe(true);
    expect(hoisted.bells.find((b) => b.type === "shift_hours_approved" && b.userId === "cg1")).toBeTruthy();
  });

  it("the caregiver countered (or accepted) in the same window → untouched", async () => {
    seed("b2", corrected, { ...corrected, status: "caregiver_counter_proposed", counterTotalHours: 3.5 });
    seed("b3", corrected, { ...corrected, status: "approved", resolvedBy: "caregiver" });
    await (autoAcceptCorrection as any)();
    expect(writesTo("b2")).toHaveLength(0);
    expect(writesTo("b3")).toHaveLength(0);
    expect(hoisted.live.get("shiftHours/b2")?.status).toBe("caregiver_counter_proposed");
    expect(hoisted.texts).toHaveLength(0);
  });

  it("a caregiver text that does not go leaves no bell behind (bell ⇄ text, C11)", async () => {
    const { sendSMSToUser } = await import("../sms");
    (sendSMSToUser as any).mockResolvedValueOnce({ success: false, error: "no phone" });
    seed("b4", corrected);
    await (autoAcceptCorrection as any)();
    expect(hoisted.live.get("shiftHours/b4")?.status).toBe("approved");
    expect(hoisted.bells.find((b) => b.userId === "cg1")).toBeUndefined();
    expect(hoisted.bells.find((b) => b.userId === "c1")).toBeTruthy(); // the family's pair is unchanged
  });
});
