import * as admin from "firebase-admin";
import type { LinqMessage, SendOptions } from "./client";
import type { SuperviseContext } from "../safety/supervisor";

const db = admin.firestore();

// ── Durable outbound queue for the two guarded-send DROP paths ────────────────
// safeSend/sendToPhone previously discarded messages outright when the Linq
// circuit breaker was open (line FLAGGED/CRITICAL) or the per-pair rate limit
// was hit. Both conditions are transient — the circuit closes when the line
// recovers, the rate window resets in ≤60s — so dropping loses messages that
// would have delivered fine a minute later (cancellation notices, APPROVE
// prompts, shift offers). Blocked sends are now parked here and drained by the
// every-minute sweep in scheduled/outboundQueueDrain.ts.
//
// Every message carries an expiry: a stale "she's running late" is worse than
// none, so unmarked messages default to a short window and only callers that
// opt in (e.g. toolNotify.trySend) get a long must-deliver TTL. Docs are kept
// past settlement (Firestore TTL on `ttl`) for observability.

export const OUTBOUND_QUEUE_COLLECTION = "linq_outbound_queue";

export const DEFAULT_QUEUE_TTL_MS = 15 * 60 * 1000;       // unmarked messages
export const MAX_DRAIN_ATTEMPTS   = 6;                     // then failed + admin_alert
export const CIRCUIT_RETRY_DELAY_MS = 2 * 60 * 1000;       // circuit rechecks
export const RATE_LIMIT_WINDOW_MS   = 60_000;              // mirrors client.ts pair limiter
const STALE_SENDING_MS  = 10 * 60 * 1000;                  // crashed mid-send → reclaim
const DOC_RETENTION_MS  = 7 * 24 * 60 * 60 * 1000;         // TTL cleanup after settle

export type QueueDropReason = "circuit_open" | "rate_limited" | "send_failed";

export type QueueTarget =
  | { kind: "chat";  chatId: string }
  | { kind: "phone"; phone: string };

export interface EnqueueParams {
  target:            QueueTarget;
  /** Exactly one of text / message. */
  text?:             string;
  message?:          LinqMessage;
  superviseContext?: SuperviseContext;
  preferredService?: SendOptions["preferredService"];
  /** Preserved so a redelivered send keeps skipping the outbound-history
   *  recorder (saveConversationTurn-backed replies must record exactly once). */
  skipHistoryRecord?: boolean;
  reason:            QueueDropReason;
  /** Caller tag for observability (e.g. "safeSend", "mcp:send_caregiver_message"). */
  source?:           string;
  ttlMs?:            number;
}

function backoffMs(attempts: number): number {
  // 1m, 2m, 4m, 8m, capped at 10m.
  return Math.min(Math.pow(2, Math.max(0, attempts - 1)) * 60_000, 10 * 60_000);
}

function targetKey(t: QueueTarget): string {
  return t.kind === "chat" ? `chat:${t.chatId}` : `phone:${t.phone}`;
}

/** Park a blocked outbound message for the drain sweep. Never throws — a
 *  queue-write failure degrades to the old drop behavior, logged loudly. */
export async function enqueueOutbound(params: EnqueueParams): Promise<boolean> {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_QUEUE_TTL_MS;
  // Rate-limited sends are eligible as soon as the next 60s window opens;
  // hard transport failures (send_failed) get a quick first recheck; circuit-
  // open sends wait a couple of minutes.
  const notBefore = params.reason === "rate_limited"
    ? (Math.floor(now / RATE_LIMIT_WINDOW_MS) + 1) * RATE_LIMIT_WINDOW_MS
    : params.reason === "send_failed"
      ? now + 60_000
      : now + CIRCUIT_RETRY_DELAY_MS;
  try {
    await db.collection(OUTBOUND_QUEUE_COLLECTION).add({
      target:           params.target,
      targetKey:        targetKey(params.target),
      payloadText:      params.text ?? null,
      payloadMessage:   params.message ?? null,
      superviseContext: params.superviseContext ?? null,
      preferredService: params.preferredService ?? null,
      skipHistoryRecord: params.skipHistoryRecord ?? false,
      reason:           params.reason,
      source:           params.source ?? "unknown",
      status:           "queued",
      attempts:         0,
      notBefore:        new Date(notBefore).toISOString(),
      expiresAt:        new Date(now + ttlMs).toISOString(),
      lastError:        null,
      createdAt:        new Date(now).toISOString(),
      ttl:              admin.firestore.Timestamp.fromMillis(now + ttlMs + DOC_RETENTION_MS),
    });
    return true;
  } catch (err) {
    console.error("[outboundQueue] enqueue failed — message dropped", {
      source: params.source, reason: params.reason,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Drain ─────────────────────────────────────────────────────────────────────

interface QueueDoc {
  target:            QueueTarget;
  targetKey:         string;
  payloadText:       string | null;
  payloadMessage:    LinqMessage | null;
  superviseContext:  SuperviseContext | null;
  preferredService:  SendOptions["preferredService"] | null;
  skipHistoryRecord?: boolean;
  reason:            QueueDropReason;
  source:            string;
  status:            string;
  attempts:          number;
  notBefore:         string;
  expiresAt:         string;
  createdAt:         string;
}

/** Transactionally claim a queued doc (queued → sending, attempts++). Returns
 *  the claimed attempt count, or null if another sweep got there first. */
async function claim(ref: FirebaseFirestore.DocumentReference): Promise<number | null> {
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data() as QueueDoc & { claimedAt?: string };
      const staleSending = d.status === "sending" &&
        (!d.claimedAt || Date.parse(d.claimedAt) < Date.now() - STALE_SENDING_MS);
      if (d.status !== "queued" && !staleSending) return null;
      const attempts = (d.attempts ?? 0) + 1;
      tx.update(ref, { status: "sending", attempts, claimedAt: new Date().toISOString() });
      return attempts;
    });
  } catch {
    return null;
  }
}

async function raiseFailureAlert(doc: QueueDoc, docId: string, lastError: string): Promise<void> {
  try {
    await db.collection("admin_alerts").add({
      type:      "linq_outbound_queue_failed",
      queueDocId: docId,
      source:     doc.source,
      reason:     doc.reason,
      targetKey:  doc.targetKey,
      attempts:   doc.attempts,
      lastError:  lastError.slice(0, 500),
      dedupeKey:  `linq_outbound_queue_failed:${doc.targetKey}:${new Date().toISOString().slice(0, 13)}`,
      severity:   "high",
      resolved:   false,
      createdAt:  new Date().toISOString(),
    });
  } catch { /* non-critical */ }
}

export interface DrainResult {
  sent:    number;
  requeued: number;
  expired:  number;
  failed:   number;
}

/** One sweep over due queue docs. Per-target ordering is preserved: docs for a
 *  target are attempted oldest-first, and if one doesn't go through, the rest
 *  of that target's docs are skipped this pass (never delivered out of order). */
export async function drainOutboundQueue(): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, requeued: 0, expired: 0, failed: 0 };
  const nowIso = new Date().toISOString();

  const snap = await db.collection(OUTBOUND_QUEUE_COLLECTION)
    .where("status", "==", "queued")
    .where("notBefore", "<=", nowIso)
    .orderBy("notBefore", "asc")
    .limit(50)
    .get();
  if (snap.empty) return result;

  // Group by target, oldest-first within each, so multi-message conversations
  // stay in order even though the query is ordered by notBefore.
  const byTarget = new Map<string, typeof snap.docs>();
  for (const doc of snap.docs) {
    const key = (doc.data() as QueueDoc).targetKey;
    const list = byTarget.get(key) ?? [];
    list.push(doc);
    byTarget.set(key, list);
  }
  const { safeSend, sendToPhone } = await import("./client");

  for (const docs of byTarget.values()) {
    docs.sort((a, b) =>
      ((a.data() as QueueDoc).createdAt).localeCompare((b.data() as QueueDoc).createdAt));
    let targetBlocked = false;

    for (const doc of docs) {
      if (targetBlocked) continue; // preserve order — retry next sweep
      const d = doc.data() as QueueDoc;

      if (d.expiresAt <= nowIso) {
        await doc.ref.update({ status: "expired" }).catch(() => {});
        result.expired++;
        console.warn("[outboundQueue] message expired undelivered", {
          id: doc.id, source: d.source, reason: d.reason, targetKey: d.targetKey,
        });
        continue;
      }

      const attempts = await claim(doc.ref);
      if (attempts === null) continue; // raced by a concurrent sweep

      const payload = d.payloadMessage ?? d.payloadText ?? "";
      const opts: SendOptions = {
        ...(d.preferredService ? { preferredService: d.preferredService } : {}),
        ...(d.skipHistoryRecord ? { skipHistoryRecord: true } : {}),
        _noQueue: true, // a still-blocked send reports back instead of re-enqueueing
      };

      let outcome: string;
      let sendError = "";
      try {
        if (d.target.kind === "chat" && d.superviseContext) {
          outcome = await safeSend(d.target.chatId, payload, d.superviseContext, opts);
        } else if (d.target.kind === "phone") {
          outcome = await sendToPhone(d.target.phone, payload, opts);
        } else if (d.target.kind === "chat" && d.reason === "send_failed") {
          // Transport-failure redelivery: this content already went through
          // the full lint/redact/supervise pipeline at its original send —
          // resend directly. opts._noQueue prevents a re-enqueue loop.
          const { sendMessage } = await import("./client");
          await sendMessage(d.target.chatId, payload, opts);
          outcome = "sent";
        } else {
          // chat target with no supervise context — sent unsupervised is not
          // acceptable for a chat-path message; treat as failed config.
          outcome = "error";
          sendError = "chat target missing superviseContext";
        }
      } catch (err) {
        outcome = "error";
        sendError = err instanceof Error ? err.message : String(err);
      }

      if (outcome === "sent" || outcome === "skipped_opt_out") {
        // Opt-out counts as settled: the recipient must not be messaged.
        await doc.ref.update({ status: "sent", sentAt: new Date().toISOString(), finalOutcome: outcome }).catch(() => {});
        result.sent++;
        continue;
      }

      targetBlocked = true;
      if (attempts >= MAX_DRAIN_ATTEMPTS) {
        await doc.ref.update({ status: "failed", lastError: sendError || outcome }).catch(() => {});
        await raiseFailureAlert({ ...d, attempts }, doc.id, sendError || outcome);
        result.failed++;
        continue;
      }
      await doc.ref.update({
        status:    "queued",
        lastError: sendError || outcome,
        notBefore: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      }).catch(() => {});
      result.requeued++;
    }
  }

  return result;
}
