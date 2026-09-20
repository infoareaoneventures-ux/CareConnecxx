import { describe, it, expect, vi, beforeEach } from "vitest";

// Firestore-trigger workaround for the GCP org policy blocking public
// invoker IAM on brand-new Cloud Functions (see accountRecovery.ts's header
// comment). These tests lock in the dispatcher: it routes each action type
// to the right accountRecovery.ts/accountDeletion.ts function and writes
// back status/result/error onto the request doc — the same contract the
// client-side listener (services/accountActionQueue.ts) depends on.

vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    firestore: { document: () => ({ onCreate: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: { FieldValue: { serverTimestamp: () => "SERVER_TS" } } },
  firestore: Object.assign(() => ({}), { FieldValue: { serverTimestamp: () => "SERVER_TS" } }),
}));

const requestPhoneChangeByEmail = vi.fn();
const startPhoneChangeVerification = vi.fn();
const confirmPhoneChange = vi.fn();
const requestEmailChangeSelf = vi.fn();
const confirmEmailChange = vi.fn();
const approveEmailChange = vi.fn();
const startEmailChangeFallback = vi.fn();
const confirmEmailChangeFallback = vi.fn();
const resendEmailConfirmation = vi.fn();
vi.mock("../../accountRecovery", () => ({
  requestPhoneChangeByEmail: (...a: unknown[]) => requestPhoneChangeByEmail(...a),
  startPhoneChangeVerification: (...a: unknown[]) => startPhoneChangeVerification(...a),
  confirmPhoneChange: (...a: unknown[]) => confirmPhoneChange(...a),
  requestEmailChangeSelf: (...a: unknown[]) => requestEmailChangeSelf(...a),
  confirmEmailChange: (...a: unknown[]) => confirmEmailChange(...a),
  approveEmailChange: (...a: unknown[]) => approveEmailChange(...a),
  startEmailChangeFallback: (...a: unknown[]) => startEmailChangeFallback(...a),
  confirmEmailChangeFallback: (...a: unknown[]) => confirmEmailChangeFallback(...a),
  resendEmailConfirmation: (...a: unknown[]) => resendEmailConfirmation(...a),
}));

const deleteAccountForUser = vi.fn();
vi.mock("../../accountDeletion", () => ({
  deleteAccountForUser: (...a: unknown[]) => deleteAccountForUser(...a),
}));

const pauseCaregiver = vi.fn();
const reactivateCaregiver = vi.fn();
vi.mock("../../agents/pauseAccount", () => ({
  pauseCaregiver: (...a: unknown[]) => pauseCaregiver(...a),
  reactivateCaregiver: (...a: unknown[]) => reactivateCaregiver(...a),
}));

import { processAccountActionQueue } from "../accountActionQueue";

function makeSnap(data: Record<string, unknown>) {
  const update = vi.fn().mockResolvedValue(undefined);
  return { data: () => data, ref: { update } };
}

beforeEach(() => {
  requestPhoneChangeByEmail.mockReset().mockResolvedValue(undefined);
  startPhoneChangeVerification.mockReset().mockResolvedValue(undefined);
  confirmPhoneChange.mockReset().mockResolvedValue(undefined);
  requestEmailChangeSelf.mockReset().mockResolvedValue(undefined);
  confirmEmailChange.mockReset().mockResolvedValue(undefined);
  approveEmailChange.mockReset().mockResolvedValue({ sentTo: "new@x.com" });
  startEmailChangeFallback.mockReset().mockResolvedValue(undefined);
  confirmEmailChangeFallback.mockReset().mockResolvedValue({ sentTo: "new@x.com" });
  resendEmailConfirmation.mockReset().mockResolvedValue({ sentTo: "a@x.com" });
  deleteAccountForUser.mockReset().mockResolvedValue({ deleted: true });
  pauseCaregiver.mockReset().mockResolvedValue(undefined);
  reactivateCaregiver.mockReset().mockResolvedValue(undefined);
});

describe("processAccountActionQueue", () => {
  it("dispatches request_phone_change with the email and writes status:done", async () => {
    const snap = makeSnap({ type: "request_phone_change", email: "a@b.com" });
    await processAccountActionQueue(snap as any);
    expect(requestPhoneChangeByEmail).toHaveBeenCalledWith("a@b.com");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "done", error: null,
    }));
  });

  it("dispatches start_phone_verification with token + newPhone", async () => {
    const snap = makeSnap({ type: "start_phone_verification", token: "tok1", newPhone: "+15551234567" });
    await processAccountActionQueue(snap as any);
    expect(startPhoneChangeVerification).toHaveBeenCalledWith("tok1", "+15551234567");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("dispatches confirm_phone_change with token + code", async () => {
    const snap = makeSnap({ type: "confirm_phone_change", token: "tok1", code: "123456" });
    await processAccountActionQueue(snap as any);
    expect(confirmPhoneChange).toHaveBeenCalledWith("tok1", "123456");
  });

  it("dispatches request_email_change with uid + newEmail", async () => {
    const snap = makeSnap({ type: "request_email_change", uid: "u1", newEmail: "new@example.com" });
    await processAccountActionQueue(snap as any);
    expect(requestEmailChangeSelf).toHaveBeenCalledWith("u1", "new@example.com");
  });

  it("dispatches confirm_email_change with token", async () => {
    const snap = makeSnap({ type: "confirm_email_change", token: "tok2" });
    await processAccountActionQueue(snap as any);
    expect(confirmEmailChange).toHaveBeenCalledWith("tok2");
  });

  it("dispatches delete_account with uid and writes the result back", async () => {
    const snap = makeSnap({ type: "delete_account", uid: "u1" });
    await processAccountActionQueue(snap as any);
    expect(deleteAccountForUser).toHaveBeenCalledWith("u1");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "done", result: { deleted: true },
    }));
  });

  it("dispatches set_caregiver_pause_status (pause) with uid + until", async () => {
    const snap = makeSnap({ type: "set_caregiver_pause_status", uid: "cg1", action: "pause", until: "2026-10-01" });
    await processAccountActionQueue(snap as any);
    expect(pauseCaregiver).toHaveBeenCalledWith("cg1", "2026-10-01");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "done", result: { status: "paused", until: "2026-10-01" },
    }));
  });

  it("dispatches set_caregiver_pause_status (pause) defaulting to indefinite when no until is given", async () => {
    const snap = makeSnap({ type: "set_caregiver_pause_status", uid: "cg1", action: "pause" });
    await processAccountActionQueue(snap as any);
    expect(pauseCaregiver).toHaveBeenCalledWith("cg1", "indefinite");
  });

  it("dispatches set_caregiver_pause_status (reactivate) with uid", async () => {
    const snap = makeSnap({ type: "set_caregiver_pause_status", uid: "cg1", action: "reactivate" });
    await processAccountActionQueue(snap as any);
    expect(reactivateCaregiver).toHaveBeenCalledWith("cg1");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "done", result: { status: "active" },
    }));
  });

  it("writes status:error with the thrown message when the underlying function throws", async () => {
    confirmPhoneChange.mockRejectedValue(new Error("This link is invalid or has expired."));
    const snap = makeSnap({ type: "confirm_phone_change", token: "tok1", code: "000000" });
    await processAccountActionQueue(snap as any);
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "error", error: "This link is invalid or has expired.",
    }));
  });

  it("writes status:error for an unrecognized type instead of throwing unhandled", async () => {
    const snap = makeSnap({ type: "not_a_real_type" });
    await processAccountActionQueue(snap as any);
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });
});

describe("recovery-email approval flow actions (2026-09-20)", () => {
  it("request_email_change hands the page the stage + token it needs for the old-inbox / phone-code step", async () => {
    requestEmailChangeSelf.mockResolvedValueOnce({ stage: "awaiting_old_approval", token: "t1", sentTo: "old@x.com", oldEmail: "old@x.com" });
    const snap = makeSnap({ type: "request_email_change", uid: "u1", newEmail: "new@x.com" });
    await (processAccountActionQueue as any)(snap);
    expect(requestEmailChangeSelf).toHaveBeenCalledWith("u1", "new@x.com");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: "done", result: expect.objectContaining({ stage: "awaiting_old_approval", token: "t1" }) }));
  });

  it("approve / fallback start / fallback confirm / resend each route to accountRecovery", async () => {
    let snap = makeSnap({ type: "approve_email_change", token: "t1" });
    await (processAccountActionQueue as any)(snap);
    expect(approveEmailChange).toHaveBeenCalledWith("t1", "old_email");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: "done", result: { sentTo: "new@x.com" } }));

    snap = makeSnap({ type: "start_email_change_fallback", token: "t1" });
    await (processAccountActionQueue as any)(snap);
    expect(startEmailChangeFallback).toHaveBeenCalledWith("t1");

    snap = makeSnap({ type: "confirm_email_change_fallback", token: "t1", code: "246810" });
    await (processAccountActionQueue as any)(snap);
    expect(confirmEmailChangeFallback).toHaveBeenCalledWith("t1", "246810");

    snap = makeSnap({ type: "resend_email_confirmation", uid: "u1" });
    await (processAccountActionQueue as any)(snap);
    expect(resendEmailConfirmation).toHaveBeenCalledWith("u1");
    expect(snap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: "done", result: { sentTo: "a@x.com" } }));
  });
});
