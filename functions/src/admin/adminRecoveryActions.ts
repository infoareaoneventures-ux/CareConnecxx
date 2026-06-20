import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";
import { isHighRisk, type PendingAction } from "../agents/pendingActions";

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
 * Control Room executable recovery callables (U4 / R6 / R16).
 *
 * These replace the note-only operator-intent controls. Each is admin-gated by
 * `requireAdmin`, writes an audit record, transitions the relevant ledger /
 * pending / alert state, is idempotent against double-execution, and fails
 * VISIBLY (never reports false success). High-risk replays require explicit
 * operator confirmation.
 */

// ── 1. admin_retry_linq_delivery ──────────────────────────────────────────────
//
// Re-attempt a FAILED outbound Linq send recorded on an agent_action_ledger row
// (or addressed directly by chatId/phone). On success the ledger row transitions
// failed→executed and the delivery is recorded. On failure it stays failed, a
// fresh admin_alerts doc is raised, and the caller gets a visible failure (AE5).
//
// Idempotency: a transactional single-use deliveryRetryLock (keyed by
// idempotencyKey) prevents a second retry from re-sending. A row already
// `executed`/`cancelled` is never retried.
export const admin_retry_linq_delivery = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const ledgerId: string =
      typeof data?.ledgerId === "string" ? data.ledgerId.trim() : "";
    const idempotencyKey: string =
      typeof data?.idempotencyKey === "string" && data.idempotencyKey.trim()
        ? data.idempotencyKey.trim()
        : "";
    // Direct addressing when there is no ledger row (e.g. a raw linq_send_failure alert).
    const directChatId: string | undefined =
      typeof data?.chatId === "string" && data.chatId.trim() ? data.chatId.trim() : undefined;
    const directPhone: string | undefined =
      typeof data?.phone === "string" && data.phone.trim() ? data.phone.trim() : undefined;
    const directText: string | undefined =
      typeof data?.text === "string" && data.text ? data.text : undefined;

    if (!idempotencyKey) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "An idempotencyKey is required to guard against double-delivery",
      );
    }
    if (!ledgerId && !(directChatId || directPhone)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Provide a ledgerId, or a chatId/phone to re-attempt delivery",
      );
    }

    // ── Resolve the message to (re)send + claim an idempotency lock ──────────
    let chatId: string | undefined = directChatId;
    let phone: string | undefined = directPhone;
    let text: string | undefined = directText;
    let userId = "";

    if (ledgerId) {
      const ref = db.collection("agent_action_ledger").doc(ledgerId);
      const claim = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          return { ok: false as const, code: "not-found" as const, reason: "Ledger entry not found" };
        }
        const entry = snap.data() ?? {};
        if (entry.status === "executed") {
          return { ok: false as const, code: "failed-precondition" as const, reason: "Delivery already executed — nothing to retry" };
        }
        if (entry.status === "cancelled") {
          return { ok: false as const, code: "failed-precondition" as const, reason: "Action was cancelled — not retryable" };
        }
        if (entry.status !== "failed") {
          return { ok: false as const, code: "failed-precondition" as const, reason: `Only failed deliveries can be retried (current: ${entry.status})` };
        }
        if (entry.deliveryRetryLock?.idempotencyKey) {
          return {
            ok: false as const,
            code: "already-exists" as const,
            reason:
              entry.deliveryRetryLock.idempotencyKey === idempotencyKey
                ? "This delivery retry was already submitted (idempotency key already used)"
                : "A delivery retry is already in progress for this action",
          };
        }
        const now = nowIso();
        tx.update(ref, {
          deliveryRetryLock: { idempotencyKey, claimedBy: adminUid, claimedAt: now },
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
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      chatId = chatId ?? (typeof entry.chatId === "string" ? entry.chatId : undefined) ?? (typeof meta.chatId === "string" ? meta.chatId : undefined);
      phone = phone ?? (typeof entry.phone === "string" ? entry.phone : undefined) ?? (typeof meta.phone === "string" ? meta.phone : undefined);
      text = text ?? (typeof meta.text === "string" ? meta.text : undefined) ?? (typeof entry.text === "string" ? entry.text : undefined);
      userId = typeof entry.userId === "string" ? entry.userId : "";
    }

    if (!text) {
      // Nothing to deliver — never claim success. Release the in-progress flag.
      if (ledgerId) {
        await db.collection("agent_action_ledger").doc(ledgerId).update({
          retryInProgress: false,
          retryOutcome: "no_message_payload",
          retryError: "No message text recorded for re-delivery; supply text.",
          updatedAt: nowIso(),
        }).catch(() => {});
      }
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No message text is recorded for this delivery. Provide `text` to re-attempt.",
      );
    }
    if (!chatId && !phone) {
      if (ledgerId) {
        await db.collection("agent_action_ledger").doc(ledgerId).update({
          retryInProgress: false,
          retryOutcome: "no_destination",
          retryError: "No chatId/phone recorded for re-delivery.",
          updatedAt: nowIso(),
        }).catch(() => {});
      }
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No destination (chatId or phone) recorded for this delivery.",
      );
    }

    // ── Re-attempt the real Linq send (reuse the production send path) ───────
    const { sendToPhone, sendMessage } = await import("../linq/client");
    let threwError: string | undefined;
    try {
      if (phone) {
        await sendToPhone(phone, text);
      } else {
        await sendMessage(chatId!, text);
      }
    } catch (err) {
      threwError = err instanceof Error ? err.message : String(err);
    }

    const now = nowIso();

    if (threwError !== undefined) {
      // Fail visibly: keep the ledger failed, raise a fresh admin alert, surface the error.
      if (ledgerId) {
        await db.collection("agent_action_ledger").doc(ledgerId).update({
          status: "failed",
          retryInProgress: false,
          retryOutcome: "failed",
          retryError: threwError.slice(0, 1000),
          errorReason: threwError.slice(0, 1000),
          updatedAt: now,
        }).catch(() => {});
      }
      await db.collection("admin_alerts").add({
        type: "linq_delivery_retry_failed",
        severity: "high",
        resolved: false,
        ledgerId: ledgerId || null,
        chatId: chatId ?? null,
        phone: phone ?? null,
        message: `Linq delivery retry failed: ${threwError}`.slice(0, 500),
        createdAt: now,
      }).catch((e) => console.warn("admin_retry_linq_delivery alert write failed", e));

      await logAudit({
        eventType: "linq_delivery_retry_attempted",
        userId: userId || ledgerId || "unknown",
        data: { source: "callable:admin_retry_linq_delivery", adminUid, ledgerId, outcome: "failed", error: threwError.slice(0, 500) },
      });

      return { success: false, ledgerId, retried: true, error: threwError.slice(0, 500) };
    }

    // Success: record delivery + transition the ledger row to executed.
    if (ledgerId) {
      await db.collection("agent_action_ledger").doc(ledgerId).update({
        status: "executed",
        retryInProgress: false,
        retryOutcome: "executed",
        retryError: admin.firestore.FieldValue.delete(),
        deliveredAt: now,
        executedAt: now,
        updatedAt: now,
      }).catch(() => {});
    }
    await logAudit({
      eventType: "linq_delivery_retry_attempted",
      userId: userId || ledgerId || "unknown",
      data: { source: "callable:admin_retry_linq_delivery", adminUid, ledgerId, outcome: "executed" },
    });

    return { success: true, ledgerId, retried: true };
  },
);

// ── 2. admin_replay_pending_action ────────────────────────────────────────────
//
// Replay a pending action through the same MCP executor. High-risk replays (per
// the existing isHighRisk(toolName, toolInput)) are REJECTED unless confirm===true.
// Idempotency: a transactional single-use replayLock (keyed by idempotencyKey)
// prevents double-execution; a terminal (executed/rejected/expired) action is
// never replayed. On tool failure the action is marked failed, an admin alert is
// raised, and the caller gets a visible failure.
export const admin_replay_pending_action = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const pendingActionId: string =
      typeof data?.pendingActionId === "string" ? data.pendingActionId.trim() : "";
    const confirm: boolean = data?.confirm === true;
    const idempotencyKey: string =
      typeof data?.idempotencyKey === "string" && data.idempotencyKey.trim()
        ? data.idempotencyKey.trim()
        : "";

    if (!pendingActionId) {
      throw new functions.https.HttpsError("invalid-argument", "pendingActionId is required");
    }
    if (!idempotencyKey) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "An idempotencyKey is required to guard against double-replay",
      );
    }

    const ref = db.collection("pending_actions").doc(pendingActionId);

    // Read first so we can enforce the high-risk confirmation gate BEFORE claiming
    // the lock (a rejected high-risk replay must not consume the idempotency key).
    const pre = await ref.get();
    if (!pre.exists) {
      throw new functions.https.HttpsError("not-found", "Pending action not found");
    }
    const action = pre.data() as PendingAction;
    const toolName = action.toolName;
    const toolInput = (action.toolInput ?? {}) as Record<string, unknown>;

    const highRisk = isHighRisk(toolName, toolInput);
    if (highRisk && !confirm) {
      // Reject — never silently execute a high-risk replay without explicit confirm.
      await logAudit({
        eventType: "pending_action_replay_attempted",
        userId: (action.userId as string) ?? pendingActionId,
        data: { source: "callable:admin_replay_pending_action", adminUid, pendingActionId, toolName, outcome: "rejected_unconfirmed_highrisk" },
      });
      throw new functions.https.HttpsError(
        "failed-precondition",
        `Replaying ${toolName} is a high-risk action — pass confirm:true to proceed.`,
      );
    }

    // ── Idempotency: claim the replay lock transactionally ───────────────────
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { ok: false as const, code: "not-found" as const, reason: "Pending action not found" };
      }
      const cur = snap.data() as PendingAction & { replayLock?: { idempotencyKey?: string } };
      if (cur.status === "executed") {
        return { ok: false as const, code: "failed-precondition" as const, reason: "Action already executed — nothing to replay" };
      }
      if (cur.status === "rejected" || cur.status === "expired") {
        return { ok: false as const, code: "failed-precondition" as const, reason: `Action is ${cur.status} — not replayable` };
      }
      if (cur.replayLock?.idempotencyKey) {
        return {
          ok: false as const,
          code: "already-exists" as const,
          reason:
            cur.replayLock.idempotencyKey === idempotencyKey
              ? "This replay was already submitted (idempotency key already used)"
              : "A replay is already in progress for this action",
        };
      }
      const now = nowIso();
      tx.update(ref, {
        replayLock: { idempotencyKey, claimedBy: adminUid, claimedAt: now },
        status: "executing",
        executingStartedAt: now,
        replayConfirmed: highRisk ? true : admin.firestore.FieldValue.delete(),
      });
      return { ok: true as const };
    });

    if (!claim.ok) {
      throw new functions.https.HttpsError(claim.code, claim.reason);
    }

    // ── Execute through the same MCP executor used by the agent loop ─────────
    const { handleToolCall } = await import("../mcp/server");
    let result: unknown;
    let threwError: string | undefined;
    try {
      result = await handleToolCall(toolName, { ...toolInput });
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
      await ref.update({
        status: "failed",
        resolvedAt: now,
        replayError: errorReason.slice(0, 1000),
      }).catch(() => {});
      await db.collection("admin_alerts").add({
        type: "pending_action_replay_failed",
        severity: "high",
        resolved: false,
        pendingActionId,
        toolName,
        message: `Replay of ${toolName} failed: ${errorReason}`.slice(0, 500),
        createdAt: now,
      }).catch((e) => console.warn("admin_replay_pending_action alert write failed", e));
      await logAudit({
        eventType: "pending_action_replay_attempted",
        userId: (action.userId as string) ?? pendingActionId,
        data: { source: "callable:admin_replay_pending_action", adminUid, pendingActionId, toolName, outcome: "failed", error: errorReason.slice(0, 500) },
      });
      return { success: false, pendingActionId, replayed: true, error: errorReason.slice(0, 500) };
    }

    await ref.update({
      status: "executed",
      resolvedAt: now,
      replayError: admin.firestore.FieldValue.delete(),
    }).catch(() => {});
    await logAudit({
      eventType: "pending_action_replay_attempted",
      userId: (action.userId as string) ?? pendingActionId,
      data: { source: "callable:admin_replay_pending_action", adminUid, pendingActionId, toolName, outcome: "executed", highRisk },
    });

    return { success: true, pendingActionId, replayed: true };
  },
);

// ── 3. admin_cancel_pending_action ────────────────────────────────────────────
//
// Cancel a stale / awaiting pending action by transitioning it to a terminal
// `rejected` state WITHOUT executing the underlying tool. `reason` is required.
// Idempotent: an already-terminal action is a no-op success.
export const admin_cancel_pending_action = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const pendingActionId: string =
      typeof data?.pendingActionId === "string" ? data.pendingActionId.trim() : "";
    const reason: string = typeof data?.reason === "string" ? data.reason.trim() : "";

    if (!pendingActionId) {
      throw new functions.https.HttpsError("invalid-argument", "pendingActionId is required");
    }
    if (!reason) {
      throw new functions.https.HttpsError("invalid-argument", "A cancellation reason is required");
    }

    const ref = db.collection("pending_actions").doc(pendingActionId);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { ok: false as const, code: "not-found" as const, reason: "Pending action not found" };
      }
      const cur = snap.data() as PendingAction;
      // Terminal already → idempotent no-op (don't resurrect or re-cancel).
      if (cur.status === "rejected" || cur.status === "executed" || cur.status === "expired" || cur.status === "failed") {
        return { ok: true as const, alreadyTerminal: true, status: cur.status };
      }
      const now = nowIso();
      // Transition to terminal cancelled state — DO NOT call the underlying tool.
      tx.update(ref, {
        status: "rejected",
        resolvedAt: now,
        cancelledAt: now,
        cancelledBy: adminUid,
        operatorNotes: reason.slice(0, 1000),
        recoveryAction: "admin_cancelled",
      });
      return { ok: true as const, alreadyTerminal: false, status: "rejected" as const };
    });

    if (!result.ok) {
      throw new functions.https.HttpsError(result.code, result.reason);
    }

    await logAudit({
      eventType: "pending_action_cancelled",
      userId: pendingActionId,
      data: { source: "callable:admin_cancel_pending_action", adminUid, pendingActionId, reason: reason.slice(0, 500), alreadyTerminal: result.alreadyTerminal },
    });

    return { success: true, pendingActionId, status: result.status, executed: false };
  },
);

// ── 4. admin_assign_recovery_owner ────────────────────────────────────────────
//
// Set an owner/assignee on the ledger OR alert doc for operator accountability.
// No tool execution. Idempotent (re-assigning is a plain overwrite).
export const admin_assign_recovery_owner = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const ledgerId: string | undefined =
      typeof data?.ledgerId === "string" && data.ledgerId.trim() ? data.ledgerId.trim() : undefined;
    const alertId: string | undefined =
      typeof data?.alertId === "string" && data.alertId.trim() ? data.alertId.trim() : undefined;
    const ownerUid: string | undefined =
      typeof data?.ownerUid === "string" && data.ownerUid.trim() ? data.ownerUid.trim() : undefined;
    const ownerLabel: string | undefined =
      typeof data?.ownerLabel === "string" && data.ownerLabel.trim() ? data.ownerLabel.trim() : undefined;

    if (!ledgerId && !alertId) {
      throw new functions.https.HttpsError("invalid-argument", "A ledgerId or alertId is required");
    }
    if (!ownerUid && !ownerLabel) {
      throw new functions.https.HttpsError("invalid-argument", "An ownerUid or ownerLabel is required");
    }

    const collection = ledgerId ? "agent_action_ledger" : "admin_alerts";
    const docId = (ledgerId ?? alertId)!;
    const ref = db.collection(collection).doc(docId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", `${collection} doc not found`);
    }
    const now = nowIso();
    await ref.update({
      recoveryOwnerUid: ownerUid ?? admin.firestore.FieldValue.delete(),
      recoveryOwnerLabel: ownerLabel ?? admin.firestore.FieldValue.delete(),
      assignedTo: ownerUid ?? ownerLabel,
      assignedAt: now,
      assignedBy: adminUid,
      updatedAt: now,
    });

    await logAudit({
      eventType: "recovery_owner_assigned",
      userId: docId,
      data: { source: "callable:admin_assign_recovery_owner", adminUid, collection, docId, ownerUid: ownerUid ?? null, ownerLabel: ownerLabel ?? null },
    });

    return { success: true, collection, docId, owner: ownerUid ?? ownerLabel };
  },
);

// ── 5. admin_mark_recovery_complete ───────────────────────────────────────────
//
// Mark a manual recovery done on a ledger OR alert doc. `reason` is REQUIRED.
// Transitions the ledger row to a terminal `cancelled`/handled state (or resolves
// the alert). No tool execution. Idempotent.
export const admin_mark_recovery_complete = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const ledgerId: string | undefined =
      typeof data?.ledgerId === "string" && data.ledgerId.trim() ? data.ledgerId.trim() : undefined;
    const alertId: string | undefined =
      typeof data?.alertId === "string" && data.alertId.trim() ? data.alertId.trim() : undefined;
    const reason: string = typeof data?.reason === "string" ? data.reason.trim() : "";

    if (!ledgerId && !alertId) {
      throw new functions.https.HttpsError("invalid-argument", "A ledgerId or alertId is required");
    }
    if (!reason) {
      throw new functions.https.HttpsError("invalid-argument", "A reason is required to mark recovery complete");
    }

    const now = nowIso();
    if (ledgerId) {
      const ref = db.collection("agent_action_ledger").doc(ledgerId);
      const snap = await ref.get();
      if (!snap.exists) {
        throw new functions.https.HttpsError("not-found", "Ledger entry not found");
      }
      await ref.update({
        status: "cancelled",
        handledBy: adminUid,
        handledAt: now,
        handledReason: reason.slice(0, 1000),
        recoveryAction: "manual_recovery_complete",
        updatedAt: now,
      });
    } else {
      const ref = db.collection("admin_alerts").doc(alertId!);
      const snap = await ref.get();
      if (!snap.exists) {
        throw new functions.https.HttpsError("not-found", "Alert not found");
      }
      await ref.update({
        resolved: true,
        resolvedAt: now,
        resolvedBy: adminUid,
        handledReason: reason.slice(0, 1000),
      });
    }

    await logAudit({
      eventType: "recovery_marked_complete",
      userId: (ledgerId ?? alertId)!,
      data: { source: "callable:admin_mark_recovery_complete", adminUid, ledgerId: ledgerId ?? null, alertId: alertId ?? null, reason: reason.slice(0, 500) },
    });

    return { success: true, ledgerId: ledgerId ?? null, alertId: alertId ?? null };
  },
);
