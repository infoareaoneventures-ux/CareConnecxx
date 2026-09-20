import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// Firestore-trigger workaround for the same wall documented in project
// memory (careconnex-d4c8b's GCP org policy blocks granting public invoker
// IAM to brand-new Cloud Functions — the same thing that broke the original
// password-gate callable, worked around there with
// functions/src/triggers/adminAdvanceQueue.ts's pattern). The website writes
// a request doc directly to Firestore (allowed by firestore.rules, no
// Cloud Function call needed for that write) instead of calling an onCall
// function; this trigger — Firestore-triggered, not HTTP-triggered, so it
// never needs public invoker IAM — picks it up and runs the real logic in
// functions/src/accountRecovery.ts / accountDeletion.ts. Evia's MCP tools
// call those same functions directly and are unaffected by any of this.

type ActionType =
  | "request_phone_change"
  | "start_phone_verification"
  | "confirm_phone_change"
  | "request_email_change"
  | "confirm_email_change"
  | "approve_email_change"
  | "start_email_change_fallback"
  | "confirm_email_change_fallback"
  | "resend_email_confirmation"
  | "delete_account"
  | "set_caregiver_pause_status";

export const processAccountActionQueue = functions.firestore
  .document("account_action_requests/{requestId}")
  .onCreate(async (snap) => {
    const data = snap.data() as Record<string, unknown>;
    const type = data.type as ActionType;

    try {
      const result = await dispatch(type, data);
      await snap.ref.update({
        status: "done",
        result: result ?? { success: true },
        error: null,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      await snap.ref.update({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });

async function dispatch(type: ActionType, data: Record<string, unknown>): Promise<Record<string, unknown> | void> {
  const {
    requestPhoneChangeByEmail,
    startPhoneChangeVerification,
    confirmPhoneChange,
    requestEmailChangeSelf,
    confirmEmailChange,
    approveEmailChange,
    startEmailChangeFallback,
    confirmEmailChangeFallback,
    resendEmailConfirmation,
  } = await import("../accountRecovery");
  const { deleteAccountForUser } = await import("../accountDeletion");
  const { pauseCaregiver, reactivateCaregiver } = await import("../agents/pauseAccount");

  switch (type) {
    case "request_phone_change":
      // Anti-enumeration: this never throws (it swallows its own errors),
      // so the doc always resolves "done" regardless of what actually
      // happened inside — the website was never told which case applied.
      await requestPhoneChangeByEmail(String(data.email ?? ""));
      return;

    case "start_phone_verification":
      await startPhoneChangeVerification(String(data.token ?? ""), String(data.newPhone ?? ""));
      return;

    case "confirm_phone_change":
      await confirmPhoneChange(String(data.token ?? ""), String(data.code ?? ""));
      return;

    case "request_email_change":
      // Returns { stage, token, sentTo, oldEmail } — the page needs the stage
      // (old-address approval vs new-inbox confirmation) and the token for
      // the "Text me a code" fallback.
      return await requestEmailChangeSelf(String(data.uid ?? ""), String(data.newEmail ?? "")) as unknown as Record<string, unknown>;

    case "approve_email_change":
      return await approveEmailChange(String(data.token ?? ""), "old_email");

    case "start_email_change_fallback":
      await startEmailChangeFallback(String(data.token ?? ""));
      return;

    case "confirm_email_change_fallback":
      return await confirmEmailChangeFallback(String(data.token ?? ""), String(data.code ?? ""));

    case "resend_email_confirmation":
      return await resendEmailConfirmation(String(data.uid ?? "")) as unknown as Record<string, unknown>;

    case "confirm_email_change":
      await confirmEmailChange(String(data.token ?? ""));
      return;

    case "delete_account":
      return await deleteAccountForUser(String(data.uid ?? "")) as unknown as Record<string, unknown>;

    // Website entry point for the same pause/reactivate a caregiver could
    // already do over SMS (pause_account/reactivate_account MCP tools) —
    // calls the exact same shared write logic so all callers stay in sync.
    case "set_caregiver_pause_status": {
      const uid = String(data.uid ?? "");
      if (data.action === "reactivate") {
        await reactivateCaregiver(uid);
        return { status: "active" };
      }
      const until = typeof data.until === "string" && data.until.trim() ? data.until.trim() : "indefinite";
      await pauseCaregiver(uid, until);
      return { status: "paused", until };
    }

    default:
      throw new Error(`Unknown account action type: ${String(type)}`);
  }
}
