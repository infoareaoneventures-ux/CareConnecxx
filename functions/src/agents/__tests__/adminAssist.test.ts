import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore: collection(name).doc(id) → get/set/update, enough for adminAssist.ts.
const store = new Map<string, Record<string, unknown>>();
const DELETE = Symbol("delete");
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) { if (v === DELETE) delete target[k]; else target[k] = v; }
}
vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (name: string) => ({
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            const cur = opts?.merge ? { ...(store.get(key) ?? {}) } : {};
            applyPatch(cur, data); store.set(key, cur);
          },
          update: async (data: Record<string, unknown>) => {
            if (!store.has(key)) throw new Error("no doc");
            const cur = { ...store.get(key)! }; applyPatch(cur, data); store.set(key, cur);
          },
        };
      },
    }),
  });
  firestore.FieldValue = { serverTimestamp: () => "ts", delete: () => DELETE };
  return { default: { firestore, apps: [{}], auth: () => ({}) }, firestore, apps: [{}], auth: () => ({}), initializeApp: () => ({}) };
});
const sent: Array<{ to: string; text: string }> = [];
vi.mock("../../linq/client", () => ({
  sendMessage: vi.fn(async (chatId: string, text: string) => { sent.push({ to: chatId, text }); return { message_id: "m" }; }),
  sendToPhone: vi.fn(async (phone: string, text: string) => { sent.push({ to: phone, text }); return { ok: true }; }),
}));
const audits: Array<{ eventType: string; userId: string; data: Record<string, unknown> }> = [];
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async (e: any) => { audits.push(e); }) }));
vi.mock("firebase-functions", () => ({ firestore: { document: () => ({ onCreate: (fn: any) => fn }) } }));

import {
  consentReplyKind, isPendingFresh, isAssistActive, assistWindowEnd, ASSIST_WINDOW_MS,
  requestAdminAssist, endAdminAssist, handleAdminAssistConsentReply, CONSENT_GRANTED_TEXT, CONSENT_DECLINED_TEXT,
} from "../adminAssist";
import { linkKindAllowedForRole } from "../../triggers/adminAssistQueue";

const PHONE = "+14085551234";
const UID = "fam1";
const pendingFor = (requestedAt = new Date().toISOString()) => ({ uid: UID, role: "client" as const, adminUid: "adm1", adminName: "Hamse", requestedAt });

beforeEach(() => { store.clear(); sent.length = 0; audits.length = 0; });

describe("admin assist consent (2026-10-22): a texted YES opens a one-hour window", () => {
  it("only a strict YES / NO is the consent answer", () => {
    expect(consentReplyKind("YES")).toBe("yes");
    expect(consentReplyKind(" yes. ")).toBe("yes");
    expect(consentReplyKind("Sí")).toBe("yes");
    expect(consentReplyKind("no")).toBe("no");
    expect(consentReplyKind("yes please go ahead")).toBeNull();
    expect(consentReplyKind("ok")).toBeNull();
    expect(consentReplyKind("")).toBeNull();
  });

  it("the ask lapses after 15 minutes; the window is one hour", () => {
    const now = Date.now();
    expect(isPendingFresh({ requestedAt: new Date(now - 14 * 60000).toISOString() }, now)).toBe(true);
    expect(isPendingFresh({ requestedAt: new Date(now - 16 * 60000).toISOString() }, now)).toBe(false);
    expect(Date.parse(assistWindowEnd(now)) - now).toBe(ASSIST_WINDOW_MS);
    expect(isAssistActive({ status: "granted", until: new Date(now + 1000).toISOString() }, now)).toBe(true);
    expect(isAssistActive({ status: "granted", until: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(isAssistActive({ status: "requested" }, now)).toBe(false);
  });

  it("Act for this person: the state is 'requested', the ask is parked on the session, the text goes out, the audit entry names the admin", async () => {
    await requestAdminAssist({ uid: UID, role: "client", phone: PHONE, firstName: "Anahi", adminUid: "adm1", adminName: "Hamse" });
    expect(store.get(`adminAssist/${UID}`)).toMatchObject({ status: "requested", requestedBy: { uid: "adm1", name: "Hamse" }, phone: PHONE });
    expect(store.get(`agent_sessions/${PHONE}`)?.adminAssistConsentPending).toMatchObject({ uid: UID, adminName: "Hamse" });
    expect(sent[0].to).toBe(PHONE);
    expect(sent[0].text).toContain("Hi Anahi, this is Evia.");
    expect(sent[0].text).toContain("Reply YES to allow it for the next hour, or NO.");
    expect(audits[0]).toMatchObject({ eventType: "admin_assist_requested", userId: UID, data: { adminName: "Hamse" } });
  });

  it("YES from the account's phone grants the hour: state + window written, the parked ask cleared, the person told, audit entry", async () => {
    store.set(`adminAssist/${UID}`, { status: "requested" });
    store.set(`agent_sessions/${PHONE}`, { chatId: "c1", adminAssistConsentPending: pendingFor() });
    const handled = await handleAdminAssistConsentReply(PHONE, "c1", store.get(`agent_sessions/${PHONE}`) as any, "yes");
    expect(handled).toBe(true);
    const st = store.get(`adminAssist/${UID}`)!;
    expect(st.status).toBe("granted");
    expect(Date.parse(String(st.until)) - Date.parse(String(st.grantedAt))).toBe(ASSIST_WINDOW_MS);
    expect(store.get(`agent_sessions/${PHONE}`)?.adminAssistConsentPending).toBeUndefined();
    expect(sent[0]).toEqual({ to: "c1", text: CONSENT_GRANTED_TEXT });
    expect(audits[0]).toMatchObject({ eventType: "admin_assist_granted", userId: UID });
  });

  it("NO declines; any other message is not the answer and routes as usual (the ask stays parked)", async () => {
    store.set(`adminAssist/${UID}`, { status: "requested" });
    store.set(`agent_sessions/${PHONE}`, { chatId: "c1", adminAssistConsentPending: pendingFor() });
    expect(await handleAdminAssistConsentReply(PHONE, "c1", store.get(`agent_sessions/${PHONE}`) as any, "what time is my visit?")).toBe(false);
    expect(store.get(`agent_sessions/${PHONE}`)?.adminAssistConsentPending).toBeDefined();
    expect(sent).toHaveLength(0);
    expect(await handleAdminAssistConsentReply(PHONE, "c1", store.get(`agent_sessions/${PHONE}`) as any, "NO")).toBe(true);
    expect(store.get(`adminAssist/${UID}`)?.status).toBe("declined");
    expect(sent[0].text).toBe(CONSENT_DECLINED_TEXT);
    expect(audits[0].eventType).toBe("admin_assist_declined");
  });

  it("a lapsed ask (>15 min) is closed as expired without taking the message", async () => {
    store.set(`adminAssist/${UID}`, { status: "requested" });
    store.set(`agent_sessions/${PHONE}`, { chatId: "c1", adminAssistConsentPending: pendingFor(new Date(Date.now() - 20 * 60000).toISOString()) });
    expect(await handleAdminAssistConsentReply(PHONE, "c1", store.get(`agent_sessions/${PHONE}`) as any, "YES")).toBe(false);
    expect(store.get(`adminAssist/${UID}`)?.status).toBe("expired");
    expect(store.get(`agent_sessions/${PHONE}`)?.adminAssistConsentPending).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(audits[0].eventType).toBe("admin_assist_expired");
  });

  it("Stop ends the window, tells the person, and logs who stopped it", async () => {
    store.set(`adminAssist/${UID}`, { status: "granted" });
    store.set(`agent_sessions/${PHONE}`, { chatId: "c1" });
    await endAdminAssist({ uid: UID, phone: PHONE, adminUid: "adm1", adminName: "Hamse", reason: "ended" });
    expect(store.get(`adminAssist/${UID}`)).toMatchObject({ status: "ended", endedBy: { uid: "adm1", name: "Hamse" } });
    expect(sent[0].text).toContain("finished helping with your account");
    expect(audits[0]).toMatchObject({ eventType: "admin_assist_ended", data: { adminName: "Hamse" } });
  });

  it("send-link kinds follow the role: a client gets identity + payment, a care provider the membership / background check / payouts / photo links", () => {
    expect(linkKindAllowedForRole("client_identity", "client")).toBe(true);
    expect(linkKindAllowedForRole("client_payment", "client")).toBe(true);
    expect(linkKindAllowedForRole("caregiver_payouts", "client")).toBe(false);
    expect(linkKindAllowedForRole("caregiver_background_check", "caregiver")).toBe(true);
    expect(linkKindAllowedForRole("client_identity", "caregiver")).toBe(false);
    expect(linkKindAllowedForRole("anything", "caregiver")).toBe(false);
  });
});
