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
  firestore.Timestamp = { fromMillis: (ms: number) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000) }) };
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
vi.mock("firebase-functions/v1", () => ({
  firestore: { document: () => ({ onCreate: (fn: any) => fn, onWrite: (fn: any) => fn, onUpdate: (fn: any) => fn }) },
  https: { onCall: (fn: any) => fn, HttpsError: class HttpsError extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } } },
}));
const bells: Array<Record<string, unknown>> = [];
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (input: Record<string, unknown>) => { bells.push(input); return true; }) }));

import {
  consentReplyKind, isPendingFresh, isAssistActive, assistWindowEnd, ASSIST_WINDOW_MS,
  requestAdminAssist, endAdminAssist, handleAdminAssistConsentReply, CONSENT_GRANTED_TEXT, CONSENT_DECLINED_TEXT,
  actedText, assistWindowOpenFor, recordAdminActed, resolveActingCallerUid, recordActedByCallable,
} from "../adminAssist";
import { linkKindAllowedForRole } from "../../triggers/adminAssistQueue";

const PHONE = "+14085551234";
const UID = "fam1";
const pendingFor = (requestedAt = new Date().toISOString()) => ({ uid: UID, role: "client" as const, adminUid: "adm1", adminName: "Hamse", requestedAt });

beforeEach(() => { store.clear(); sent.length = 0; audits.length = 0; bells.length = 0; });

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

  it("YES also writes the window as a Timestamp (untilTs) for firestore.rules actingFor()", async () => {
    store.set(`adminAssist/${UID}`, { status: "requested" });
    store.set(`agent_sessions/${PHONE}`, { chatId: "c1", adminAssistConsentPending: pendingFor() });
    await handleAdminAssistConsentReply(PHONE, "c1", store.get(`agent_sessions/${PHONE}`) as any, "YES");
    const st = store.get(`adminAssist/${UID}`)!;
    expect(st.untilTs).toBeDefined();
  });

  it("an acted-for change = one audit entry under the admin's name + a bell + a text to the person", async () => {
    await recordAdminActed({ uid: UID, role: "client", adminUid: "adm1", adminName: "Hamse", kind: "care_plan_updated", summary: "updated your care plan", sourcePath: "adminAssistQueue/q1", eventId: "q1", phone: PHONE });
    expect(audits[0]).toMatchObject({ eventType: "admin_acted", userId: UID, data: { kind: "care_plan_updated", summary: "updated your care plan", adminName: "Hamse" } });
    expect(bells[0]).toMatchObject({ recipientId: UID, transitionType: "admin_acted_care_plan_updated", title: "Our team helped with your account" });
    expect(sent[0]).toEqual({ to: PHONE, text: actedText("updated your care plan") });
    expect(actedText("updated your care plan.")).toBe("Our team updated your care plan for you by phone, at your request. If that's not right, reply here and I'll flag it.");
  });

  it("the server-side window check: open window + a real admin, else false", async () => {
    store.set("users/adm1", { userType: "admin" });
    store.set("users/notadmin", { userType: "client" });
    store.set(`adminAssist/${UID}`, { status: "granted", until: new Date(Date.now() + 60000).toISOString() });
    expect(await assistWindowOpenFor(UID, "adm1")).toBe(true);
    expect(await assistWindowOpenFor(UID, "notadmin")).toBe(false);
    store.set(`adminAssist/${UID}`, { status: "ended" });
    expect(await assistWindowOpenFor(UID, "adm1")).toBe(false);
  });

  it("a callable acts for the person only with actingForUid + an open window + an admin caller", async () => {
    store.set("users/adm1", { userType: "admin", displayName: "Hamse" });
    store.set("users/cg1", { userType: "caregiver" });
    store.set("caregivers/cg1", { phone: PHONE });
    expect(await resolveActingCallerUid("cg1", { shiftId: "s1" })).toEqual({ uid: "cg1", actingAdminUid: null });
    expect(await resolveActingCallerUid("adm1", { actingForUid: "adm1" })).toEqual({ uid: "adm1", actingAdminUid: null });
    await expect(resolveActingCallerUid("adm1", { actingForUid: "cg1" })).rejects.toMatchObject({ code: "permission-denied" });
    store.set("adminAssist/cg1", { status: "granted", until: new Date(Date.now() + 60000).toISOString() });
    expect(await resolveActingCallerUid("adm1", { actingForUid: "cg1" })).toEqual({ uid: "cg1", actingAdminUid: "adm1" });
    await recordActedByCallable({ uid: "cg1", adminUid: "adm1", kind: "hours_submitted", summary: "submitted your hours for a visit", sourcePath: "shifts/s1", eventId: "e1" });
    expect(audits.at(-1)).toMatchObject({ eventType: "admin_acted", userId: "cg1", data: { kind: "hours_submitted", adminName: "Hamse" } });
    expect(sent.at(-1)).toEqual({ to: PHONE, text: actedText("submitted your hours for a visit") });
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
