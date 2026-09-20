import { describe, it, expect, vi, beforeEach } from "vitest";

// Recovery email confirmed at first entry + approval-first changes (2026-09-20).
// In-memory Firestore; email / SMS / links / OTP are boundary mocks.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const emails: any[] = [];
  const sms: any[] = [];
  let autoId = 0;
  const FieldValue = {
    serverTimestamp: () => "TS",
    delete: () => ({ __delete: true }),
    arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }),
    arrayRemove: (...v: unknown[]) => ({ __arrayRemove: v }),
  };
  const apply = (base: Record<string, any>, data: Record<string, any>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && (v as any).__delete) delete base[k];
      else base[k] = v;
    }
    return base;
  };
  const docRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), id: path.split("/").pop(), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => { const base = opts?.merge ? { ...(docs.get(path) ?? {}) } : {}; docs.set(path, apply(base, data)); },
    update: async (data: any) => { const cur = { ...(docs.get(path) ?? {}) }; docs.set(path, apply(cur, data)); },
    collection: (sub: string) => collRef(`${path}/${sub}`),
  });
  const collRef = (path: string): any => {
    const conds: Array<[string, string, any]> = [];
    const q: any = {
      where: (f: string, op: string, v: any) => { conds.push([f, op, v]); return q; },
      limit: () => q,
      get: async () => {
        const prefix = path + "/";
        const out = [...docs.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .filter(([, d]) => conds.every(([f, op, v]) => (op === "==" ? d?.[f] === v : true)))
          .map(([p, d]) => ({ id: p.slice(prefix.length), data: () => d, ref: docRef(p) }));
        return { empty: out.length === 0, docs: out, size: out.length };
      },
      doc: (id?: string) => docRef(`${path}/${id ?? "auto" + (++autoId)}`),
      add: async (data: any) => { const id = "auto" + (++autoId); docs.set(`${path}/${id}`, data); return { id }; },
    };
    return q;
  };
  return {
    docs, emails, sms, FieldValue,
    collection: (name: string) => collRef(name),
    reset: () => { docs.clear(); emails.length = 0; sms.length = 0; autoId = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({ collection: hoisted.collection });
  firestore.FieldValue = hoisted.FieldValue;
  const stub = { apps: [{}], initializeApp: () => ({}), firestore, auth: () => ({ updateUser: vi.fn() }) };
  return { __esModule: true, default: stub, ...stub };
});
vi.mock("../email", () => ({
  sendTransactionalEmail: vi.fn(async (o: any) => { hoisted.emails.push(o); return { id: "e" }; }),
  phoneChangeRequestHtml: () => "<p>phone</p>",
  phoneChangeConfirmedHtml: () => "<p>phone-done</p>",
  emailChangeConfirmHtml: (u: string) => `confirm:${u}`,
  emailChangeApprovalHtml: (n: string, u: string) => `approve:${n}:${u}`,
  emailChangedNoticeHtml: (n: string) => `changed:${n}`,
}));
vi.mock("../sms", () => ({ sendSMS: vi.fn(async (p: any) => { hoisted.sms.push(p); return { success: true }; }) }));
vi.mock("../config/appUrl", () => ({ appLink: (p: string) => `https://app.test${p}` }));
vi.mock("../utils/phoneVerification", () => ({
  generateOtp: () => ({ code: "246810", expiresAt: Date.now() + 900_000, attempts: 0 }),
  verifyOtp: (code: string, state: any) => ({ status: !state ? "expired" : code === state.code ? "ok" : "wrong" }),
}));

import {
  sendEmailConfirmation, requestEmailChangeSelf, approveEmailChange, confirmEmailChange,
  startEmailChangeFallback, confirmEmailChangeFallback, cancelEmailChange, resendEmailConfirmation,
  requestPhoneChangeByEmail, isEmailVerified, maskEmail,
} from "../accountRecovery";

const UID = "u1"; const PHONE = "+14085550001";
const tokenDocs = () => [...hoisted.docs.entries()].filter(([p]) => p.startsWith("email_change_requests/")).map(([p, d]) => ({ token: p.split("/")[1], ...d }));
const seedClient = (extra: Record<string, unknown> = {}) => {
  hoisted.docs.set(`users/${UID}`, { uid: UID, phone: PHONE, userType: "client", firstName: "Hamse", ...extra });
  hoisted.docs.set(`agent_sessions/${PHONE}`, { optedIn: true, chatId: "c1" });
};
const confirmedClient = () => seedClient({ email: "old@example.com", emailVerified: true, emailVerifiedFor: "old@example.com" });

beforeEach(() => hoisted.reset());

describe("maskEmail / isEmailVerified", () => {
  it("masks the local part and only counts the flag for the exact address on file", () => {
    expect(maskEmail("hamse@icloud.com")).toBe("ha***@icloud.com");
    expect(isEmailVerified({ email: "A@x.com", emailVerified: true, emailVerifiedFor: "a@x.com" })).toBe(true);
    expect(isEmailVerified({ email: "b@x.com", emailVerified: true, emailVerifiedFor: "a@x.com" })).toBe(false);
    expect(isEmailVerified({ email: "b@x.com", emailVerified: false })).toBe(false);
  });
});

describe("sendEmailConfirmation (first entry)", () => {
  it("creates a new-inbox token, stamps the profile, emails the link, and texts once opted in", async () => {
    seedClient({ email: "new@example.com" });
    const token = await sendEmailConfirmation(UID, "client", "new@example.com", "initial");
    const req = hoisted.docs.get(`email_change_requests/${token}`);
    expect(req).toMatchObject({ uid: UID, role: "client", newEmail: "new@example.com", kind: "initial", stage: "awaiting_new_confirm", status: "pending" });
    expect(hoisted.docs.get(`users/${UID}`)).toMatchObject({ emailConfirmSentFor: "new@example.com", emailVerified: false });
    expect(hoisted.emails[0]).toMatchObject({ to: "new@example.com", subject: "Confirm your Evia recovery email", html: `confirm:https://app.test/verify-email-change?token=${token}` });
    expect(hoisted.sms[0].to).toBe(PHONE);
    expect(hoisted.sms[0].message).toContain("confirmation link to ne***@example.com");
  });

  it("never texts before the phone has opted in (TCPA) — the email still goes", async () => {
    hoisted.docs.set(`users/${UID}`, { uid: UID, phone: PHONE, email: "new@example.com" }); // no agent_sessions doc yet
    await sendEmailConfirmation(UID, "client", "new@example.com", "initial");
    expect(hoisted.emails).toHaveLength(1);
    expect(hoisted.sms).toHaveLength(0);
  });

  it("confirmEmailChange on that token marks the address confirmed and tells the account holder", async () => {
    seedClient({ email: "new@example.com" });
    const token = await sendEmailConfirmation(UID, "client", "new@example.com", "initial");
    hoisted.sms.length = 0;
    await confirmEmailChange(token);
    expect(hoisted.docs.get(`users/${UID}`)).toMatchObject({ email: "new@example.com", emailVerified: true, emailVerifiedFor: "new@example.com" });
    expect(hoisted.docs.get(`email_change_requests/${token}`).status).toBe("consumed");
    expect(hoisted.sms[0].message).toContain("is confirmed");
    const bell = [...hoisted.docs.entries()].find(([p]) => p.startsWith(`users/${UID}/notifications/`));
    expect(bell?.[1]).toMatchObject({ type: "account_email_confirmed", title: "Recovery email confirmed" });
  });
});

describe("requestEmailChangeSelf — approval from the confirmed address first", () => {
  it("emails the OLD address an approval link, texts the phone the APPROVE/NO option, and anchors the session", async () => {
    confirmedClient();
    const r = await requestEmailChangeSelf(UID, "new@example.com");
    expect(r.stage).toBe("awaiting_old_approval");
    expect(r.sentTo).toBe("old@example.com");
    expect(hoisted.emails[0]).toMatchObject({ to: "old@example.com", subject: "Approve a change to your Evia recovery email", html: `approve:ne***@example.com:https://app.test/approve-email-change?token=${r.token}` });
    expect(hoisted.sms[0].message).toContain("Reply APPROVE");
    expect(hoisted.sms[0].message).toContain("Reply NO");
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`)).toMatchObject({ pendingEmailChangeToken: r.token });
    // The new inbox has NOT been contacted yet.
    expect(hoisted.emails.some((e) => e.to === "new@example.com")).toBe(false);
    // The profile is untouched until the swap.
    expect(hoisted.docs.get(`users/${UID}`)).toMatchObject({ email: "old@example.com", emailVerified: true });
  });

  it("approve → new inbox gets its confirmation link → confirm swaps the address, notifies the old one, clears the anchor", async () => {
    confirmedClient();
    const r = await requestEmailChangeSelf(UID, "new@example.com");
    hoisted.emails.length = 0; hoisted.sms.length = 0;
    const a = await approveEmailChange(r.token, "old_email");
    expect(a.sentTo).toBe("new@example.com");
    expect(hoisted.docs.get(`email_change_requests/${r.token}`)).toMatchObject({ status: "consumed", approvedVia: "old_email" });
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`).pendingEmailChangeToken).toBeUndefined();
    const second = tokenDocs().find((t) => t.stage === "awaiting_new_confirm" && t.status === "pending");
    expect(second).toMatchObject({ newEmail: "new@example.com", oldEmail: "old@example.com", kind: "change" });
    expect(hoisted.emails[0]).toMatchObject({ to: "new@example.com", subject: "Confirm your new Evia email address" });
    hoisted.emails.length = 0; hoisted.sms.length = 0;
    await confirmEmailChange(second!.token);
    expect(hoisted.docs.get(`users/${UID}`)).toMatchObject({ email: "new@example.com", emailVerified: true, emailVerifiedFor: "new@example.com" });
    expect(hoisted.emails[0]).toMatchObject({ to: "old@example.com", subject: "Your Evia recovery email was changed" });
    expect(hoisted.sms[0].message).toContain("your recovery email is now ne***@example.com");
  });

  it("an approval-stage token can never confirm an address by itself", async () => {
    confirmedClient();
    const r = await requestEmailChangeSelf(UID, "new@example.com");
    await expect(confirmEmailChange(r.token)).rejects.toThrow("invalid or has expired");
    expect(hoisted.docs.get(`users/${UID}`).email).toBe("old@example.com");
  });

  it("with an UNCONFIRMED current address there is nothing to anchor to — the new inbox's link is sent straight away", async () => {
    seedClient({ email: "old@example.com" });
    const r = await requestEmailChangeSelf(UID, "new@example.com");
    expect(r.stage).toBe("awaiting_new_confirm");
    expect(hoisted.emails[0]).toMatchObject({ to: "new@example.com" });
  });

  it("phone fallback: a code is texted to the phone on file; the right code approves, a wrong one does not", async () => {
    confirmedClient();
    const r = await requestEmailChangeSelf(UID, "new@example.com");
    hoisted.sms.length = 0; hoisted.emails.length = 0;
    await startEmailChangeFallback(r.token);
    expect(hoisted.sms[0].message).toContain("246810");
    await expect(confirmEmailChangeFallback(r.token, "000000")).rejects.toThrow("Incorrect code");
    const ok = await confirmEmailChangeFallback(r.token, "246810");
    expect(ok.sentTo).toBe("new@example.com");
    expect(hoisted.docs.get(`email_change_requests/${r.token}`)).toMatchObject({ status: "consumed", approvedVia: "phone_code" });
    expect(hoisted.emails[0]).toMatchObject({ to: "new@example.com", subject: "Confirm your new Evia email address" });
  });

  it("cancel leaves everything as it was", async () => {
    confirmedClient();
    const r = await requestEmailChangeSelf(UID, "new@example.com");
    await cancelEmailChange(r.token);
    expect(hoisted.docs.get(`email_change_requests/${r.token}`).status).toBe("cancelled");
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`).pendingEmailChangeToken).toBeUndefined();
    expect(hoisted.docs.get(`users/${UID}`).email).toBe("old@example.com");
  });

  it("caregiver: the caregivers doc is canonical and the users doc mirrors the confirmed state", async () => {
    hoisted.docs.set("caregivers/cg1", { phone: PHONE, email: "cg@example.com" });
    hoisted.docs.set("users/cg1", { phone: PHONE, userType: "caregiver", email: "cg@example.com" });
    hoisted.docs.set(`agent_sessions/${PHONE}`, { optedIn: true });
    const token = await sendEmailConfirmation("cg1", "caregiver", "cg@example.com", "initial");
    await confirmEmailChange(token);
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({ emailVerified: true, emailVerifiedFor: "cg@example.com" });
    expect(hoisted.docs.get("users/cg1")).toMatchObject({ emailVerified: true, emailVerifiedFor: "cg@example.com" });
  });
});

describe("resendEmailConfirmation", () => {
  it("re-sends for an unconfirmed address and does nothing for a confirmed one", async () => {
    seedClient({ email: "new@example.com" });
    expect(await resendEmailConfirmation(UID)).toEqual({ sentTo: "new@example.com" });
    expect(hoisted.emails[0].to).toBe("new@example.com");
    hoisted.reset();
    confirmedClient();
    expect(await resendEmailConfirmation(UID)).toEqual({ sentTo: null });
    expect(hoisted.emails).toHaveLength(0);
  });
});

describe("requestPhoneChangeByEmail — the gate", () => {
  it("sends nothing when the recovery email is not confirmed, and the link when it is", async () => {
    seedClient({ email: "old@example.com" });
    await requestPhoneChangeByEmail("old@example.com");
    expect(hoisted.emails).toHaveLength(0);
    expect([...hoisted.docs.keys()].some((k) => k.startsWith("phone_change_requests/"))).toBe(false);
    hoisted.reset();
    confirmedClient();
    await requestPhoneChangeByEmail("old@example.com");
    expect(hoisted.emails[0]).toMatchObject({ to: "old@example.com", subject: "Verify it's you — change your Evia phone number" });
    expect([...hoisted.docs.keys()].some((k) => k.startsWith("phone_change_requests/"))).toBe(true);
  });
});
