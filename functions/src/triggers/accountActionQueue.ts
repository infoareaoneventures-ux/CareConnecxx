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
  | "delete_account";

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
  } = await import("../accountRecovery");
  const { deleteAccountForUser } = await import("../accountDeletion");

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
      await requestEmailChangeSelf(String(data.uid ?? ""), String(data.newEmail ?? ""));
      return;

    case "confirm_email_change":
      await confirmEmailChange(String(data.token ?? ""));
      return;

    case "delete_account":
      return await deleteAccountForUser(String(data.uid ?? "")) as unknown as Record<string, unknown>;

    default:
      throw new Error(`Unknown account action type: ${String(type)}`);
  }
}
