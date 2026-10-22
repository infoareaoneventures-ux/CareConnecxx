import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, Record<string, unknown>>();
const added: Array<{ col: string; data: Record<string, unknown> }> = [];
const INC = Symbol("inc");
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && (v as any)[INC] !== undefined) target[k] = (Number(target[k]) || 0) + (v as any)[INC];
    else target[k] = v;
  }
}
vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (name: string) => ({
      add: async (data: Record<string, unknown>) => { added.push({ col: name, data }); return { id: "a1" }; },
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            const cur = opts?.merge ? { ...(store.get(key) ?? {}) } : {};
            applyPatch(cur, data); store.set(key, cur);
          },
          update: async (data: Record<string, unknown>) => { const cur = { ...(store.get(key) ?? {}) }; applyPatch(cur, data); store.set(key, cur); },
        };
      },
    }),
  });
  firestore.FieldValue = { serverTimestamp: () => "ts", increment: (n: number) => ({ [INC]: n }) };
  return { default: { firestore, apps: [{}], auth: () => ({ getUser: async () => null }) }, firestore, apps: [{}], auth: () => ({ getUser: async () => null }), initializeApp: () => ({}) };
});
const sent: Array<{ to: string; text: string; opts?: Record<string, unknown> }> = [];
vi.mock("../../linq/client", () => ({
  sendToPhone: vi.fn(async (phone: string, text: string, opts?: Record<string, unknown>) => { sent.push({ to: phone, text, opts }); return { ok: true }; }),
  sendMessage: vi.fn(async () => ({ message_id: "m" })),
}));
const audits: Array<{ eventType: string; userId: string; data: Record<string, unknown> }> = [];
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async (e: any) => { audits.push(e); }) }));

import { setHumanMode, handleInboundWhileHuman, sendTeamText, isStopWord } from "../humanMode";

const PHONE = "+14085551234";
beforeEach(() => { store.clear(); added.length = 0; sent.length = 0; audits.length = 0; });

describe("human mode (2026-10-22): one flag per person, the team holds the thread", () => {
  it("Hand to human: the session flag, the list fields on users (and caregivers for a provider), an audit entry naming the admin", async () => {
    store.set("users/cg1", { userType: "caregiver", phone: PHONE, name: "Hamse Mahad" });
    store.set("caregivers/cg1", { phone: PHONE });
    await setHumanMode({ uid: "cg1", on: true, reason: "admin", by: { uid: "adm1", name: "Hamse" } });
    expect(store.get(`agent_sessions/${PHONE}`)?.humanMode).toMatchObject({ on: true, reason: "admin", by: { uid: "adm1", name: "Hamse" } });
    expect(store.get("users/cg1")).toMatchObject({ humanModeOn: true, humanModeByName: "Hamse", humanModeUnread: 0 });
    expect(store.get("caregivers/cg1")).toMatchObject({ humanModeOn: true });
    expect(audits[0]).toMatchObject({ eventType: "human_mode_on", userId: "cg1", data: { adminName: "Hamse", reason: "admin" } });
  });

  it("Back to Evia: flag off everywhere, audit entry", async () => {
    store.set("users/fam1", { userType: "client", phone: PHONE, firstName: "Anahi" });
    store.set(`agent_sessions/${PHONE}`, { userId: "fam1", humanMode: { on: true } });
    await setHumanMode({ uid: "fam1", on: false, reason: "admin", by: { uid: "adm1", name: "Hamse" } });
    expect((store.get(`agent_sessions/${PHONE}`)?.humanMode as any).on).toBe(false);
    expect(store.get("users/fam1")).toMatchObject({ humanModeOn: false, humanModeEndedByName: "Hamse" });
    expect(audits[0].eventType).toBe("human_mode_off");
  });

  it("Evia's own handoff flips the same flag (by 'evia')", async () => {
    store.set("users/fam1", { userType: "client", phone: PHONE });
    await setHumanMode({ uid: "fam1", on: true, reason: "low_confidence", by: "evia" });
    expect(store.get("users/fam1")).toMatchObject({ humanModeOn: true, humanModeReason: "low_confidence", humanModeByName: "Evia" });
  });

  it("a text while the team holds the thread: Evia stays quiet, counters move, the team is alerted; STOP is never swallowed", async () => {
    store.set("users/fam1", { userType: "client", firstName: "Anahi", humanModeUnread: 1 });
    const session = { userId: "fam1", chatId: "c1" } as any;
    expect(await handleInboundWhileHuman({ phone: PHONE, session, text: "STOP" })).toBe(false);
    expect(await handleInboundWhileHuman({ phone: PHONE, session, text: "are you there?" })).toBe(true);
    expect(store.get("users/fam1")).toMatchObject({ humanModeUnread: 2, humanModeLastText: "are you there?" });
    expect(added[0].col).toBe("admin_alerts");
    expect(added[0].data).toMatchObject({ type: "human_mode_text", userId: "fam1", role: "client" });
    expect(String(added[0].data.message)).toContain('Anahi (client) texted while the team has their thread: "are you there?"');
    expect(sent).toHaveLength(0);
  });

  it("the team's reply goes from Evia's number into the same thread (source team), clears unread, audit entry", async () => {
    store.set("users/fam1", { userType: "client", phone: PHONE, humanModeUnread: 3 });
    await sendTeamText({ uid: "fam1", text: "Hi Anahi, this is Hamse from Evia.", adminUid: "adm1", adminName: "Hamse" });
    expect(sent[0]).toEqual({ to: PHONE, text: "Hi Anahi, this is Hamse from Evia.", opts: { mirrorSource: "team" } });
    expect(store.get("users/fam1")?.humanModeUnread).toBe(0);
    expect(audits[0]).toMatchObject({ eventType: "team_text_sent", userId: "fam1", data: { adminName: "Hamse" } });
    await expect(sendTeamText({ uid: "fam1", text: "   ", adminUid: "adm1", adminName: "Hamse" })).rejects.toThrow("Nothing to send");
  });

  it("stop words", () => {
    expect(isStopWord(" stop ")).toBe(true);
    expect(isStopWord("please stop texting")).toBe(false);
  });
});
