import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

function nowIso() {
  return new Date().toISOString();
}

/** A tool result is a failure if it threw, or returned the `_toolError` shape. */
function isFailedToolResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return r._toolError === true || r.success === false;
}

/**
 * admin_retry_agent_action — retry / replay a FAILED action from the
 * agent_action_ledger (AE5 / R16).
 *
 * Two hard guarantees, per the plan:
 *
 *  1. No false success. The callable EITHER executes the intended backend action
 *     OR fails visibly. It re-dispatches the recorded tool through the same MCP
 *     executor and inspects the real result. A thrown error or a `_toolError`
 *     result transitions the ledger row to a terminal `failed` state with the
 *     error surfaced (errorReason + a fresh admin alert) — it NEVER returns
 *     `{ success: true }` for a failed replay. If the row carries no replayable
 *     tool payload, the retry is refused (no silent claim of success).
 *
 *  2. Idempotency. A transactional compare-and-set claims a single-use
 *     `retryLock` (keyed by the supplied idempotencyKey). A second retry with the
 *     same key — or any retry while one is already in flight or after the row has
 *     reached a terminal `executed`/`cancelled` state — is rejected, so a
 *     double-retry cannot double-execute the side effect.
 *
 * Replay payload resolution order:
 *   data.replayToolName / data.replayInput  (explicit, preferred)
 *   ledger.toolName + ledger.replayInput     (persisted on the row, if present)
 */
export const admin_retry_agent_action = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const ledgerId: string = data?.ledgerId;
    const idempotencyKey: string =
      typeof data?.idempotencyKey === "string" && data.idempotencyKey.trim()
        ? data.idempotencyKey.trim()
        : "";

    if (!ledgerId) {
      throw new functions.https.HttpsError("invalid-argument", "ledgerId is required");
    }
    if (!idempotencyKey) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "An idempotencyKey is required to guard against double-retry",
      );
    }

    const ref = db.collection("agent_action_ledger").doc(ledgerId);

    // ── Idempotency: claim the retry lock transactionally ────────────────────
    // A single committed transaction either grants this caller the lock or
    // rejects the retry. Concurrent / repeated calls with the same key see the
    // already-set lock and bail. A row in a terminal success state is never
    // retried.
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { ok: false as const, code: "not-found" as const, reason: "Ledger entry not found" };
      }
      const entry = snap.data() ?? {};

      if (entry.status === "executed") {
        return { ok: false as const, code: "failed-precondition" as const, reason: "Action already executed — nothing to retry" };
      }
      if (entry.status === "cancelled") {
        return { ok: false as const, code: "failed-precondition" as const, reason: "Action was cancelled — not retryable" };
      }
      if (entry.status !== "failed") {
        return { ok: false as const, code: "failed-precondition" as const, reason: `Only failed actions can be retried (current: ${entry.status})` };
      }

      // Already locked? If it's the same key, this is a duplicate retry → refuse.
      if (entry.retryLock && entry.retryLock.idempotencyKey) {
        return {
          ok: false as const,
          code: "already-exists" as const,
          reason:
            entry.retryLock.idempotencyKey === idempotencyKey
              ? "This retry was already submitted (idempotency key already used)"
              : "A retry is already in progress for this action",
        };
      }

      const now = nowIso();
      tx.update(ref, {
        retryLock: { idempotencyKey, claimedBy: adminUid, claimedAt: now },
        retryInProgress: true,
        lastRetryAt: now,
        retryCount: (entry.retryCount ?? 0) + 1,
        updatedAt: now,
      });
      return { ok: true as const, entry };
    });

    if (!claim.ok) {
      throw new functions.https.HttpsError(claim.code, claim.reason);
    }

    const entry = claim.entry;

    // ── Resolve the replay payload ───────────────────────────────────────────
    const replayToolName: string | undefined =
      (typeof data?.replayToolName === "string" && data.replayToolName) ||
      (typeof entry.toolName === "string" ? entry.toolName : undefined);
    const replayInput: Record<string, unknown> =
      (data?.replayInput && typeof data.replayInput === "object" ? data.replayInput : undefined) ??
      (entry.replayInput && typeof entry.replayInput === "object" ? entry.replayInput : undefined) ??
      {};

    if (!replayToolName) {
      // No tool to replay. Do NOT claim success. Leave the row failed, surface
      // the gap, and release the in-progress flag so an operator can supply an
      // explicit replay payload later.
      const now = nowIso();
      await ref.update({
        retryInProgress: false,
        retryOutcome: "no_replay_payload",
        retryError: "Ledger row has no replayable tool payload; supply replayToolName/replayInput.",
        updatedAt: now,
      });
      await logAudit({
        eventType: "agent_action_retry_attempted",
        userId: (entry.userId as string) ?? ledgerId,
        data: {
          source: "callable:admin_retry_agent_action",
          adminUid,
          ledgerId,
          outcome: "no_replay_payload",
        },
      });
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This ledger row has no replayable tool payload. Provide replayToolName and replayInput to retry.",
      );
    }

    // ── Execute the intended backend action ──────────────────────────────────
    const { handleToolCall } = await import("../mcp/server");
    let result: unknown;
    let threwError: string | undefined;
    try {
      result = await handleToolCall(replayToolName, { ...replayInput });
    } catch (err) {
      threwError = err instanceof Error ? err.message : String(err);
    }

    const failed = threwError !== undefined || isFailedToolResult(result);
    const now = nowIso();

    if (failed) {
      const errorReason =
        threwError ??
        (result && typeof result === "object"
          ? String((result as Record<string, unknown>).message ?? "Tool reported failure")
          : "Tool reported failure");

      // Fail visibly: terminal failed state, error surfaced, fresh admin alert.
      await ref.update({
        status: "failed",
        retryInProgress: false,
        retryOutcome: "failed",
        retryError: errorReason.slice(0, 1000),
        errorReason: errorReason.slice(0, 1000),
        updatedAt: now,
      });

      await db.collection("admin_alerts").add({
        type: "agent_action_retry_failed",
        severity: "high",
        resolved: false,
        ledgerId,
        toolName: replayToolName,
        message: `Retry of ${replayToolName} failed: ${errorReason}`.slice(0, 500),
        createdAt: now,
      }).catch((e) => console.warn("admin_retry_agent_action alert write failed", e));

      await logAudit({
        eventType: "agent_action_retry_attempted",
        userId: (entry.userId as string) ?? ledgerId,
        data: {
          source: "callable:admin_retry_agent_action",
          adminUid,
          ledgerId,
          toolName: replayToolName,
          outcome: "failed",
          error: errorReason.slice(0, 500),
        },
      });

      // Surface failure to the caller too — never report success.
      return { success: false, ledgerId, retried: true, error: errorReason.slice(0, 500) };
    }

    // Success: terminal executed state.
    await ref.update({
      status: "executed",
      retryInProgress: false,
      retryOutcome: "executed",
      retryError: admin.firestore.FieldValue.delete(),
      executedAt: now,
      updatedAt: now,
    });

    await logAudit({
      eventType: "agent_action_retry_attempted",
      userId: (entry.userId as string) ?? ledgerId,
      data: {
        source: "callable:admin_retry_agent_action",
        adminUid,
        ledgerId,
        toolName: replayToolName,
        outcome: "executed",
      },
    });

    return { success: true, ledgerId, retried: true };
  },
);
