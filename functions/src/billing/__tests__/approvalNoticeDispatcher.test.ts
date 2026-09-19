// The approval notice ("Basra submitted hours … reply APPROVE") goes out once,
// and only while the timesheet is still waiting on the family. Live-caught
// 2026-09-18: a missing delivery receipt re-sent it a day after the family had
// already sent a correction.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    update: async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); },
    set: async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); },
  });
  const makeQuery = (coll: string, conds: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...conds, [f, op, v]]),
    orderBy: () => makeQuery(coll, conds), limit: () => makeQuery(coll, conds),
    get: async () => {
      const docs = [...docState.entries()].filter(([p]) => p.startsWith(`${coll}/`)).filter(([, d]) => conds.every(([f, op, v]) => {
        const a = d?.[f];
        if (op === "==") return a === v;
        if (op === "in") return Array.isArray(v) && v.includes(a);
        if (op === "<=") return String(a ?? "") <= String(v);
        return false;
      })).map(([p, d]) => ({ id: p.slice(coll.length + 1), data: () => d, ref: makeDoc(p) }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  const coll = (name: string): any => ({ doc: (id: string) => makeDoc(`${name}/${id}`), where: (f: string, op: string, v: any) => makeQuery(name, [[f, op, v]]) });
  const tx = { get: async (ref: any) => ref.get(), update: (ref: any, data: any) => { docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data }); }, set: (ref: any, data: any) => { docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data }); } };
  return { docState, coll, runTransaction: async (fn: any) => fn(tx), reset: () => docState.clear() };
});
vi.mock("firebase-admin", () => ({
  firestore: Object.assign(() => ({ collection: hoisted.coll, runTransaction: hoisted.runTransaction }), { FieldValue: {} }),
}));
vi.mock("firebase-functions", () => {
  const fn: any = new Proxy(() => fn, { get: () => fn, apply: () => fn });
  return { __esModule: true, default: fn, pubsub: fn, https: fn, region: () => fn };
});
const sendViaInteractionAgent = vi.fn(async () => true);
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendViaInteractionAgent(...(a as [])) }));

import { dispatchApprovalNotice, processApprovalNoticeOutbox } from "../approvalNoticeDispatcher";

const OUTBOX = "sh-1:approval-request:v1";
const base = { appointmentId: "sh-1", recipientUid: "c1", payloadSnapshot: { caregiverName: "Basra Yousuf", grossPayCents: 295 }, attemptCount: 1 };

beforeEach(() => {
  hoisted.reset(); sendViaInteractionAgent.mockClear();
  hoisted.docState.set("users/c1", { phone: "+15551234567" });
});

describe("approval notice — once, and only while the timesheet waits on the family", () => {
  it("a retry finds the family already acted (Correction Sent) → closed as superseded, nothing sent", async () => {
    hoisted.docState.set(`billingApprovalOutbox/${OUTBOX}`, { ...base, state: "retry", nextAttemptAt: "2026-01-01T00:00:00.000Z" });
    hoisted.docState.set("shiftHours/sh-1", { status: "correction_proposed", approvalNoticeState: "sent" });
    expect(await dispatchApprovalNotice(OUTBOX, "w1")).toBe(false);
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`billingApprovalOutbox/${OUTBOX}`)).toMatchObject({ state: "delivered", providerStatus: "superseded" });
    expect(hoisted.docState.get("shiftHours/sh-1").approvalNoticeState).toBe("delivered");
  });

  it("still pending on the family → sends once and records it", async () => {
    hoisted.docState.set(`billingApprovalOutbox/${OUTBOX}`, { ...base, state: "pending", attemptCount: 0, nextAttemptAt: "2026-01-01T00:00:00.000Z" });
    hoisted.docState.set("shiftHours/sh-1", { status: "pending_client_review", approvalNoticeState: "pending" });
    expect(await dispatchApprovalNotice(OUTBOX, "w1")).toBe(true);
    expect(sendViaInteractionAgent).toHaveBeenCalledTimes(1);
    expect(hoisted.docState.get(`billingApprovalOutbox/${OUTBOX}`).state).toBe("sent");
  });

  it("24h with no delivery receipt → closed as assumed delivered, never re-sent", async () => {
    hoisted.docState.set(`billingApprovalOutbox/${OUTBOX}`, { ...base, state: "sent", providerMessageId: null, nextAttemptAt: "2026-01-01T00:00:00.000Z" });
    hoisted.docState.set("shiftHours/sh-1", { status: "pending_client_review", approvalNoticeState: "sent" });
    await processApprovalNoticeOutbox();
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(hoisted.docState.get(`billingApprovalOutbox/${OUTBOX}`)).toMatchObject({ state: "delivered", providerStatus: "assumed_delivered" });
    // And a second sweep finds nothing to do.
    await processApprovalNoticeOutbox();
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
  });
});
