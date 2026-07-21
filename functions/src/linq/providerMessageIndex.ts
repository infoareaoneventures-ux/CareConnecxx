import * as admin from "firebase-admin";
import { createHash } from "crypto";

// U2 (KTD5/KTD6): scoped, hashed provider-message → canonical-message map.
//
// Linq delivery/sent/edited/failed webhooks previously queried root
// `agent_conversations` docs that never exist (canonical messages live in the
// `agent_conversations/{phone}/messages` subcollection), so every receipt was
// silently dropped. This map resolves a provider message id to the canonical
// message refs in O(1) via a hashed document id, with no root query.
//
// Privacy (R9/R10): the document id is a sha256 hash — the raw provider id never
// appears in the path or in stored fields. Stored values are reference-only:
// canonical message doc paths + normalized receipt metadata. Never message text,
// phone numbers, chat ids, or user ids. Edits are applied to the referenced
// canonical rows; the edited text is never stored in the map.
//
// Convergence (KTD6): send-side registration and a webhook that wins the race
// meet at the same hash. A receipt arriving before registration upserts an
// "unresolved" entry (24h TTL) holding only the buffered status; registration
// then attaches the refs, applies the buffered status, and extends the entry to
// a 365-day horizon. An enriched entry's horizon is fixed — later events never
// extend it, and an event after it expired creates only an unresolved entry.

const COLLECTION = "linq_message_index";
const ENRICHED_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const UNRESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
// Provider account scope. Provider message ids are globally unique, so a fixed
// scope is sufficient and — crucially — derivable identically on the send side
// and on every webhook (both only reliably share the provider message id).
const DEFAULT_SCOPE = "linq";

type ReceiptStatus = "sent" | "delivered" | "failed";
const STATUS_FIELD: Record<ReceiptStatus, string> = {
  sent: "sentAt",
  delivered: "deliveredAt",
  failed: "failedAt",
};

function db() {
  return admin.firestore();
}

/** Hashed document id — sha256(scope + ":" + providerMessageId). */
export function providerMessageDocId(providerMessageId: string, scope: string = DEFAULT_SCOPE): string {
  return createHash("sha256").update(`${scope}:${providerMessageId}`).digest("hex");
}

function ttl(ms: number): admin.firestore.Timestamp {
  return admin.firestore.Timestamp.fromMillis(Date.now() + ms);
}

/** Apply a receipt field to each referenced canonical message doc (idempotent). */
async function applyToRefs(refs: string[], field: string, at: string): Promise<void> {
  await Promise.all(
    refs.map((path) => db().doc(path).update({ [field]: at }).catch(() => {/* row gone / non-critical */})),
  );
}

/**
 * Send-side registration (KTD6). Attaches the canonical refs to the hashed
 * entry. If a receipt arrived webhook-first, its buffered status is applied to
 * the refs now. Fixed 365-day horizon; safe to call once per provider part.
 */
export async function registerSentProviderMessage(
  providerMessageId: string,
  refs: string[],
  scope: string = DEFAULT_SCOPE,
): Promise<void> {
  if (!providerMessageId || refs.length === 0) return;
  const ref = db().collection(COLLECTION).doc(providerMessageDocId(providerMessageId, scope));

  const buffered = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data()! : null;
    // Merge refs (a logical message can map several provider parts to the same rows).
    const mergedRefs = Array.from(new Set([...(prev?.refs ?? []), ...refs]));
    tx.set(ref, {
      refs: mergedRefs,
      resolved: true,
      ttl: ttl(ENRICHED_TTL_MS), // fixed horizon; not extended by later events
      // Consume the buffered receipt: cleared here so a later re-registration
      // (e.g. a retried send resolving to the same provider id) can never
      // re-apply a stale status over a newer receipt.
      ...(prev?.bufferedStatus
        ? { bufferedStatus: admin.firestore.FieldValue.delete(), bufferedAt: admin.firestore.FieldValue.delete() }
        : {}),
    }, { merge: true });
    // Return any buffered status/edit to apply after the txn.
    return prev?.bufferedStatus
      ? { status: prev.bufferedStatus as ReceiptStatus, at: prev.bufferedAt as string }
      : null;
  });

  if (buffered) await applyToRefs(refs, STATUS_FIELD[buffered.status], buffered.at ?? new Date().toISOString());
}

/**
 * Apply a delivery/sent/failed receipt. Resolved entry → updates the canonical
 * refs idempotently. No/unresolved entry → buffers the status on a 24h entry so
 * later registration can apply it. Returns whether it resolved to canonical rows.
 */
export async function applyProviderReceipt(
  providerMessageId: string,
  status: ReceiptStatus,
  at: string = new Date().toISOString(),
  scope: string = DEFAULT_SCOPE,
): Promise<{ resolved: boolean }> {
  if (!providerMessageId) return { resolved: false };
  const ref = db().collection(COLLECTION).doc(providerMessageDocId(providerMessageId, scope));

  const refs = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : null;
    if (prev?.resolved && Array.isArray(prev.refs) && prev.refs.length) {
      tx.set(ref, { [STATUS_FIELD[status]]: at }, { merge: true });
      return prev.refs as string[];
    }
    // Webhook-first: buffer the status on an unresolved 24h entry.
    tx.set(ref, {
      resolved: false,
      bufferedStatus: status,
      bufferedAt: at,
      ttl: ttl(UNRESOLVED_TTL_MS),
    }, { merge: true });
    return null;
  });

  if (refs) {
    await applyToRefs(refs, STATUS_FIELD[status], at);
    return { resolved: true };
  }
  return { resolved: false };
}

/**
 * Apply an edit. Resolved entry → writes editedText/editedAt to the canonical
 * rows (the text lives only on the canonical message, never in the map).
 * Unresolved → records an editedAt marker only (no text) and does not mutate
 * history. Returns whether it resolved.
 */
export async function applyProviderEdit(
  providerMessageId: string,
  editedText: string | undefined,
  at: string = new Date().toISOString(),
  scope: string = DEFAULT_SCOPE,
): Promise<{ resolved: boolean }> {
  if (!providerMessageId) return { resolved: false };
  const ref = db().collection(COLLECTION).doc(providerMessageDocId(providerMessageId, scope));

  const refs = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : null;
    if (prev?.resolved && Array.isArray(prev.refs) && prev.refs.length) {
      tx.set(ref, { editedAt: at }, { merge: true });
      return prev.refs as string[];
    }
    tx.set(ref, { resolved: false, editedAt: at, ttl: ttl(UNRESOLVED_TTL_MS) }, { merge: true });
    return null;
  });

  if (refs) {
    await Promise.all(refs.map((path) =>
      db().doc(path).update({
        ...(editedText !== undefined ? { editedText } : {}),
        editedAt: at,
      }).catch(() => {/* non-critical */})));
    return { resolved: true };
  }
  return { resolved: false };
}
