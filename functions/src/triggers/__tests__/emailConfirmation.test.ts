import { describe, it, expect, vi, beforeEach } from "vitest";

// The one place that decides "this recovery email has not been confirmed yet,
// send the link" — regardless of which surface wrote the address.

vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    firestore: { document: () => ({ onWrite: (h: any) => h, onCreate: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

const sendEmailConfirmation = vi.fn();
vi.mock("../../accountRecovery", () => ({
  sendEmailConfirmation: (...a: unknown[]) => sendEmailConfirmation(...a),
}));

import { onUserEmailWrite, onCaregiverEmailWrite, emailNeedingConfirmation, emailStateUnchanged } from "../emailConfirmation";

const snap = (id: string, data: Record<string, unknown> | null) => ({ exists: data !== null, id, data: () => data ?? undefined });
const change = (id: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) => ({ before: snap(id, before), after: snap(id, after) });

beforeEach(() => sendEmailConfirmation.mockReset().mockResolvedValue("tok"));

describe("emailNeedingConfirmation", () => {
  it("wants a link for a new address; not once confirmed for that address or a link is already out", () => {
    expect(emailNeedingConfirmation({ email: "a@x.com" })).toBe("a@x.com");
    expect(emailNeedingConfirmation({ email: "a@x.com", emailVerified: true, emailVerifiedFor: "A@X.com" })).toBeNull();
    expect(emailNeedingConfirmation({ email: "a@x.com", emailConfirmSentFor: "a@x.com" })).toBeNull();
    // Confirmed for a DIFFERENT address (raw overwrite) → the new one still needs its link.
    expect(emailNeedingConfirmation({ email: "b@x.com", emailVerified: true, emailVerifiedFor: "a@x.com" })).toBe("b@x.com");
    expect(emailNeedingConfirmation({})).toBeNull();
  });
  it("emailStateUnchanged ignores unrelated field edits", () => {
    expect(emailStateUnchanged({ email: "a@x.com", city: "SJ" }, { email: "a@x.com", city: "Campbell" })).toBe(true);
    expect(emailStateUnchanged({ email: "a@x.com" }, { email: "b@x.com" })).toBe(false);
  });
});

describe("onUserEmailWrite / onCaregiverEmailWrite", () => {
  it("first write with an email → one first-entry confirmation for that uid", async () => {
    await (onUserEmailWrite as any)(change("u1", null, { email: "fam@x.com", phone: "+1", userType: "client" }));
    expect(sendEmailConfirmation).toHaveBeenCalledWith("u1", "client", "fam@x.com", "initial");
  });

  it("its own follow-up write (emailConfirmSentFor stamped) is a no-op, as is a confirmed address", async () => {
    await (onUserEmailWrite as any)(change("u1", { email: "fam@x.com" }, { email: "fam@x.com", emailConfirmSentFor: "fam@x.com", emailVerified: false }));
    await (onUserEmailWrite as any)(change("u1", { email: "fam@x.com" }, { email: "fam@x.com", emailVerified: true, emailVerifiedFor: "fam@x.com" }));
    expect(sendEmailConfirmation).not.toHaveBeenCalled();
  });

  it("an unrelated edit while a link is already out sends nothing; a raw overwrite of the address sends for the new one", async () => {
    await (onUserEmailWrite as any)(change("u1", { email: "fam@x.com", emailConfirmSentFor: "fam@x.com", city: "A" }, { email: "fam@x.com", emailConfirmSentFor: "fam@x.com", city: "B" }));
    expect(sendEmailConfirmation).not.toHaveBeenCalled();
    await (onUserEmailWrite as any)(change("u1", { email: "fam@x.com", emailVerified: true, emailVerifiedFor: "fam@x.com" }, { email: "other@x.com", emailVerified: true, emailVerifiedFor: "fam@x.com" }));
    expect(sendEmailConfirmation).toHaveBeenCalledWith("u1", "client", "other@x.com", "initial");
  });

  it("a caregiver's users doc is only a mirror — the caregivers trigger owns it", async () => {
    await (onUserEmailWrite as any)(change("cg1", null, { email: "cg@x.com", userType: "caregiver" }));
    expect(sendEmailConfirmation).not.toHaveBeenCalled();
    await (onCaregiverEmailWrite as any)(change("cg1", null, { email: "cg@x.com", phone: "+1" }));
    expect(sendEmailConfirmation).toHaveBeenCalledWith("cg1", "caregiver", "cg@x.com", "initial");
  });

  it("deletes and docs without an email are ignored; a send failure never throws out of the trigger", async () => {
    await (onUserEmailWrite as any)(change("u1", { email: "a@x.com" }, null));
    await (onUserEmailWrite as any)(change("u1", null, { phone: "+1" }));
    expect(sendEmailConfirmation).not.toHaveBeenCalled();
    sendEmailConfirmation.mockRejectedValueOnce(new Error("resend down"));
    await expect((onUserEmailWrite as any)(change("u2", null, { email: "z@x.com" }))).resolves.toBeUndefined();
  });
});
