import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, Record<string, unknown>>();
const added: Array<{ col: string; data: Record<string, unknown> }> = [];
function setDeep(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) target[k] = v;
}
vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: (name: string) => ({
      add: async (data: Record<string, unknown>) => { added.push({ col: name, data }); return { id: "a1" }; },
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { const cur = opts?.merge ? { ...(store.get(key) ?? {}) } : {}; setDeep(cur, data); store.set(key, cur); },
          update: async (data: Record<string, unknown>) => { const cur = { ...(store.get(key) ?? {}) }; setDeep(cur, data); store.set(key, cur); },
          collection: (sub: string) => ({ doc: (sid: string) => ({ get: async () => ({ exists: store.has(`${key}/${sub}/${sid}`), data: () => store.get(`${key}/${sub}/${sid}`) }) }) }),
        };
      },
    }),
  });
  firestore.FieldValue = { serverTimestamp: () => "ts", delete: () => "del" };
  const auth = () => ({ updateUser: async () => ({}) });
  return { default: { firestore, auth, apps: [{}] }, firestore, auth, apps: [{}], initializeApp: () => ({}) };
});
const sent: Array<{ to: string; text: string }> = [];
vi.mock("../linq/client", () => ({ sendToPhone: vi.fn(async (phone: string, text: string) => { sent.push({ to: phone, text }); return { ok: true }; }), sendMessage: vi.fn() }));
const bells: Array<Record<string, unknown>> = [];
vi.mock("../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (i: Record<string, unknown>) => { bells.push(i); return true; }) }));
const audits: Array<{ eventType: string; userId: string; data: Record<string, unknown> }> = [];
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async (e: any) => { audits.push(e); }) }));
vi.mock("../caregiverPrivate", () => ({ readCaregiverBackgroundPII: vi.fn(async (uid: string) => store.get(`pii/${uid}`) ?? {}) }));
const advanced: string[] = [];
vi.mock("../agents/onboardingConversation", () => ({ advanceOnboardingStep: vi.fn(async (phone: string, task: string) => { advanced.push(`${phone}:${task}`); }) }));
vi.mock("../stripe", () => ({ advanceEviaSessionForUid: vi.fn(async (uid: string) => { advanced.push(`uid:${uid}`); }) }));

import { normalizeName, splitAccountName, namesMatch, caregiverVerifiedName, holdNameMismatch, applyNameDecision } from "../nameBinding";

beforeEach(() => { store.clear(); added.length = 0; sent.length = 0; bells.length = 0; audits.length = 0; advanced.length = 0; });

describe("name binding (2026-10-24): the profile name is the verified legal name", () => {
  it("compares first AND last after normalization; an initial-only or missing last name never matches", () => {
    expect(normalizeName(" O'Neil-Smith ")).toBe("o neil smith");
    expect(splitAccountName("Hamse Mahad Ali")).toEqual({ first: "Hamse", last: "Mahad Ali" });
    expect(namesMatch({ first: "Imran", last: "Khan" }, { first: "imran", last: "KHAN" })).toBe(true);
    expect(namesMatch({ first: "Hamse", last: "C" }, { first: "Hamse", last: "Cali" })).toBe(false);
    expect(namesMatch({ first: "Imran", last: "" }, { first: "Imran", last: "Khan" })).toBe(false);
    expect(namesMatch({ first: "José", last: "Núñez" }, { first: "Jose", last: "Nunez" })).toBe(true);
  });

  it("reads the legal name the provider typed at consent", async () => {
    store.set("pii/cg1", { legalFirstName: "Imran", legalLastName: "Khan" });
    expect(await caregiverVerifiedName("cg1")).toEqual({ first: "Imran", last: "Khan" });
    expect(await caregiverVerifiedName("nobody")).toBeNull();
  });

  it("a mismatch holds the approval: review on the record, an admin alert, a text + bell to the person, an audit entry", async () => {
    store.set("caregivers/cg1", { name: "Imran", phone: "+1408" });
    const review = await holdNameMismatch({ uid: "cg1", role: "caregiver", source: "checkr", phone: "+1408", accountName: "Imran", verifiedFirst: "Imran", verifiedLast: "Khan" });
    expect(review.status).toBe("mismatch");
    expect(store.get("caregivers/cg1")?.nameReview).toMatchObject({ status: "mismatch", verifiedFirst: "Imran", verifiedLast: "Khan" });
    expect(store.get("caregivers/cg1")?.status).toBeUndefined(); // not active
    expect(added.find((a) => a.col === "admin_alerts")?.data).toMatchObject({ type: "name_mismatch", userId: "cg1", role: "caregiver" });
    expect(sent[0].text).toContain("the name on it (Imran Khan) doesn't match the name on your account (Imran)");
    expect(bells[0]).toMatchObject({ recipientId: "cg1", transitionType: "name_mismatch" });
    expect(audits[0].eventType).toBe("name_mismatch_held");
  });

  it("Use the verified name: the profile name becomes the legal name, locked; the held clear is applied and the session moves on", async () => {
    store.set("caregivers/cg1", { name: "Imran", phone: "+1408", mvrPaid: true, nameReview: { status: "mismatch", source: "checkr", accountName: "Imran", verifiedFirst: "Imran", verifiedLast: "Khan", at: "t" } });
    await applyNameDecision({ uid: "cg1", role: "caregiver", decision: "use_verified", adminUid: "adm1", adminName: "Hamse" });
    const cg = store.get("caregivers/cg1")!;
    expect(cg).toMatchObject({ name: "Imran Khan", nameLocked: true, verifiedLegalName: "Imran Khan", status: "active", verified: true, verificationStatus: "approved", backgroundCheckStatus: "clear", isApprovedDriver: true });
    expect((cg.nameReview as any).status).toBe("resolved");
    expect((cg.nameReview as any).decision).toBe("use_verified");
    expect(advanced).toEqual(["+1408:background_check"]);
    expect(sent[0].text).toContain("Your name on file is now Imran Khan");
    expect(audits.find((a) => a.eventType === "name_decided")?.data).toMatchObject({ decision: "use_verified", adminName: "Hamse" });
  });

  it("Keep the account name needs a reason; a family's held ID check is then applied", async () => {
    store.set("users/fam1", { firstName: "Mo", lastName: "Ali", phone: "+1650", nameReview: { status: "mismatch", source: "stripe_identity", accountName: "Mo Ali", verifiedFirst: "Mohamed", verifiedLast: "Ali", at: "t" } });
    await expect(applyNameDecision({ uid: "fam1", role: "client", decision: "keep_account", adminUid: "adm1", adminName: "Hamse" })).rejects.toThrow("reason is required");
    await applyNameDecision({ uid: "fam1", role: "client", decision: "keep_account", reason: "goes by Mo, ID says Mohamed", adminUid: "adm1", adminName: "Hamse" });
    const u = store.get("users/fam1")!;
    expect(u).toMatchObject({ firstName: "Mo", nameLocked: true, verifiedLegalName: "Mohamed Ali", identityCheckStatus: "verified" });
    expect((u.nameReview as any).reason).toBe("goes by Mo, ID says Mohamed");
    expect(advanced).toEqual(["uid:fam1"]);
    expect(sent[0].text).toContain("confirmed the name on your account (Mo Ali)");
  });

  it("nothing waiting → refuses", async () => {
    store.set("caregivers/cg2", { name: "A B" });
    await expect(applyNameDecision({ uid: "cg2", role: "caregiver", decision: "use_verified", adminUid: "adm1", adminName: "Hamse" })).rejects.toThrow("Nothing is waiting");
  });
});
