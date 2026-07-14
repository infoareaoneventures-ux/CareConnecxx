// System-wide degraded mode.
//
// Before this existed, a provider outage (LLM billing exhausted, auth broken)
// surfaced as an uncoordinated stream of per-turn "I hit a snag" messages —
// every user, every turn — plus proactive sends marching on as if nothing was
// wrong. This module holds ONE flag (system_status/current) that:
//   • providerFailureAlert sets on critical (billing/auth) provider errors,
//   • any successful agent turn clears,
//   • the QA catch path reads to send one honest degraded notice per user
//     per hour instead of snag spam,
//   • the trigger engine reads to hold proactive sends until recovery.
// Commitment sweeps deliberately keep running while degraded — their re-runs
// failing fast just escalates to a human sooner, which is the honest outcome.

import * as admin from "firebase-admin";

const db = admin.firestore();

const STATUS_DOC = "system_status/current";
const CACHE_TTL_MS = 30_000;

let _cache: { degraded: boolean; fetchedAt: number } | null = null;

export async function setSystemDegraded(reason: string): Promise<void> {
  try {
    await db.doc(STATUS_DOC).set({
      degraded:  true,
      reason:    reason.slice(0, 300),
      since:     new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    _cache = { degraded: true, fetchedAt: Date.now() };
    console.warn("[systemStatus] DEGRADED MODE SET:", reason.slice(0, 120));
  } catch (err) {
    console.error("[systemStatus] setSystemDegraded failed:", err);
  }
}

/** Cheap no-op unless the cached flag says we're degraded — safe to call on
 *  every successful turn. */
export async function clearSystemDegradedIfSet(): Promise<void> {
  try {
    if (!(await isSystemDegraded())) return;
    await db.doc(STATUS_DOC).set({
      degraded:  false,
      clearedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    _cache = { degraded: false, fetchedAt: Date.now() };
    console.info("[systemStatus] degraded mode cleared — a turn succeeded");
  } catch (err) {
    console.error("[systemStatus] clearSystemDegradedIfSet failed:", err);
  }
}

/** 30s-cached read. Fails open (not degraded) — an unreadable status flag
 *  must never suppress normal operation. */
export async function isSystemDegraded(): Promise<boolean> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.degraded;
  try {
    const snap = await db.doc(STATUS_DOC).get();
    const degraded = snap.exists && snap.data()?.degraded === true;
    _cache = { degraded, fetchedAt: Date.now() };
    return degraded;
  } catch {
    return _cache?.degraded ?? false;
  }
}

/** Test seam. */
export function _resetSystemStatusCache(): void {
  _cache = null;
}

/**
 * Degraded-aware failure notice: returns the message to send for a failed
 * turn, or null when this user already got a degraded notice within the hour
 * (repeat snag spam is worse than brief silence — the commitment tracker
 * still owes them the answer). Callers pass the session doc they already
 * loaded; the stamp is written fire-and-forget.
 */
export async function degradedFailureNotice(
  phone: string,
  session: Record<string, unknown> | undefined,
  normalCopy: string,
): Promise<string | null> {
  if (!(await isSystemDegraded())) return normalCopy;
  const lastNotice = (session?.lastDegradedNoticeAt as string | undefined) ?? "";
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  if (lastNotice && lastNotice > oneHourAgo) return null;
  db.collection("agent_sessions").doc(phone)
    .set({ lastDegradedNoticeAt: new Date().toISOString() }, { merge: true })
    .catch(() => {});
  return (
    "I'm having trouble on my end right now — not you. I've flagged it, " +
    "and I'll pick your message back up as soon as I'm running normally again."
  );
}
