// phoneRekey.ts — a phone change moves EVERYTHING keyed to the old number onto
// the new one (founder 2026-10-03: "the new number should be doing everything").
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const deleted: string[] = [];
  const alias = vi.fn(async () => {});
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, { ...(opts?.merge ? docs.get(path) ?? {} : {}), ...data }); }),
    update: vi.fn(async (data: Record<string, unknown>) => { docs.set(path, { ...(docs.get(path) ?? {}), ...data }); }),
    delete: vi.fn(async () => { docs.delete(path); deleted.push(path); }),
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (path: string): any => {
    const q = (filter?: [string, unknown]): any => ({
      where: (f: string, _op: string, v: unknown) => q([f, v]),
      get: vi.fn(async () => {
        const rows = [...docs.entries()]
          .filter(([p]) => p.startsWith(path + "/") && p.slice(path.length + 1).indexOf("/") < 0)
          .filter(([, d]) => !filter || d[filter[0]] === filter[1])
          .map(([p, d]) => ({ id: p.split("/").pop(), ref: makeDoc(p), data: () => d }));
        return { empty: rows.length === 0, docs: rows };
      }),
    });
    return { ...q(), doc: (id: string) => makeDoc(`${path}/${id}`) };
  };
  const batch = () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: any, data: Record<string, unknown>) => { ops.push(() => ref.set(data)); },
      update: (ref: any, data: Record<string, unknown>) => { ops.push(() => ref.update(data)); },
      delete: (ref: any) => { ops.push(() => ref.delete()); },
      commit: async () => { for (const op of ops) await op(); },
    };
  };
  const firestore = Object.assign(() => ({ collection: (name: string) => makeColl(name), batch }), { FieldValue: {} });
  return { docs, deleted, alias, firestore };
});

vi.mock("firebase-admin", () => ({ __esModule: true, apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestore, default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestore } }));
vi.mock("./memory/zepClient", () => ({ setZepUserAlias: (...a: unknown[]) => (hoisted.alias as any)(...a) }));

import { rekeyPhoneEverywhere } from "./phoneRekey";

const OLD = "+14085550001", NEW = "+14085559999";

beforeEach(() => {
  hoisted.docs.clear(); hoisted.deleted.length = 0; hoisted.alias.mockClear();
  hoisted.docs.set("users/cg1", { phone: OLD, userType: "caregiver" });
  hoisted.docs.set("caregivers/cg1", { phone: OLD, name: "Mahad Ali" });
  hoisted.docs.set(`agent_sessions/${OLD}`, { phone: OLD, chatId: "chat-old", userType: "caregiver", onboardingStep: "complete", caregiverId: "cg1", userId: "cg1", zepThreadId: "thr1", preferredLanguage: "en" });
  hoisted.docs.set(`agent_conversations/${OLD}`, { phone: OLD, summary: "…" });
  hoisted.docs.set(`agent_conversations/${OLD}/messages/m1`, { role: "user", content: "hi" });
  hoisted.docs.set(`agent_conversations/${OLD}/messages/m2`, { role: "assistant", content: "hello" });
  hoisted.docs.set("pending_actions/pa1", { phone: OLD, status: "awaiting" });
  hoisted.docs.set("pending_actions/pa2", { phone: "+10000000000", status: "awaiting" });
  hoisted.docs.set("proactive_triggers/t1", { phone: OLD, type: "appointment_reminder" });
  hoisted.docs.set(`web_onboarding_sessions/${OLD}`, { status: "connected" });
});

describe("rekeyPhoneEverywhere", () => {
  it("both profile records, the session MOVED with everything on it, history + messages, memory alias, parked items, bridge doc", async () => {
    const r = await rekeyPhoneEverywhere({ uid: "cg1", role: "caregiver", oldPhone: OLD, newPhone: NEW });
    expect(r).toEqual({ sessionMoved: true, conversationMoved: true, messagesMoved: 2, pendingActionsRepointed: 1, triggersRepointed: 1, memoryAliased: true });
    expect(hoisted.docs.get("users/cg1")?.phone).toBe(NEW);
    expect(hoisted.docs.get("caregivers/cg1")?.phone).toBe(NEW);
    // session: same fields (step, ids, Zep thread, language, chat id for the webhook to refresh), new key, old gone
    expect(hoisted.docs.get(`agent_sessions/${NEW}`)).toMatchObject({ phone: NEW, chatId: "chat-old", onboardingStep: "complete", caregiverId: "cg1", userId: "cg1", zepThreadId: "thr1", preferredLanguage: "en", phoneChangedFrom: OLD });
    expect(hoisted.docs.has(`agent_sessions/${OLD}`)).toBe(false);
    // conversation history + messages moved, old removed
    expect(hoisted.docs.get(`agent_conversations/${NEW}`)).toMatchObject({ phone: NEW, summary: "…" });
    expect(hoisted.docs.get(`agent_conversations/${NEW}/messages/m1`)).toEqual({ role: "user", content: "hi" });
    expect(hoisted.docs.get(`agent_conversations/${NEW}/messages/m2`)).toEqual({ role: "assistant", content: "hello" });
    expect(hoisted.docs.has(`agent_conversations/${OLD}/messages/m1`)).toBe(false);
    expect(hoisted.docs.has(`agent_conversations/${OLD}`)).toBe(false);
    // long-term memory: new digits → old digits
    expect(hoisted.alias).toHaveBeenCalledWith("14085559999", "14085550001");
    // parked confirmations / reminders re-pointed, other people's untouched
    expect(hoisted.docs.get("pending_actions/pa1")?.phone).toBe(NEW);
    expect(hoisted.docs.get("pending_actions/pa2")?.phone).toBe("+10000000000");
    expect(hoisted.docs.get("proactive_triggers/t1")?.phone).toBe(NEW);
    // the old signup bridge doc is gone
    expect(hoisted.docs.has(`web_onboarding_sessions/${OLD}`)).toBe(false);
  });

  it("a family: user record only (no care provider record written), everything else the same", async () => {
    hoisted.docs.delete("caregivers/cg1");
    const r = await rekeyPhoneEverywhere({ uid: "cg1", role: "client", oldPhone: OLD, newPhone: NEW });
    expect(r.sessionMoved).toBe(true);
    expect(hoisted.docs.get("users/cg1")?.phone).toBe(NEW);
    expect(hoisted.docs.has("caregivers/cg1")).toBe(false);
  });

  it("no old number (or the same number): writes the profile phone and stops", async () => {
    const r = await rekeyPhoneEverywhere({ uid: "cg1", role: "caregiver", oldPhone: undefined, newPhone: NEW });
    expect(r.sessionMoved).toBe(false);
    expect(hoisted.docs.get("users/cg1")?.phone).toBe(NEW);
    expect(hoisted.docs.has(`agent_sessions/${OLD}`)).toBe(true);
    expect(hoisted.alias).not.toHaveBeenCalled();
  });

  it("a failing store never blocks the rest (memory alias throws → session still moved, report says not aliased)", async () => {
    hoisted.alias.mockRejectedValueOnce(new Error("zep down"));
    const r = await rekeyPhoneEverywhere({ uid: "cg1", role: "caregiver", oldPhone: OLD, newPhone: NEW });
    expect(r.memoryAliased).toBe(false);
    expect(r.sessionMoved).toBe(true);
    expect(r.pendingActionsRepointed).toBe(1);
  });
});
