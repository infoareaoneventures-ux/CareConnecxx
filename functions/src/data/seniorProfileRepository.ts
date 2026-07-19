// ── Canonical senior-profile repository (U6, R17/KTD12) ──────────────────────
// ONE documented read order for Evia senior context:
//
//   1. senior_profiles/{seniorId} — CANONICAL. Written by onboarding
//      (onboardingConversation.persistClientCareRecords), web signup, and the
//      household migration; read by the web dashboard, matching, and MCP.
//   2. seniors/{seniorId}        — LEGACY fallback, read ONLY when no
//      canonical doc exists. No new writers.
//
// Why: qaAgent used to read legacy `seniors` directly while the Linq prefetch
// writer cached `senior_profiles` — so a prefetch-HIT turn saw canonical data
// and a prefetch-MISS turn saw stale legacy data for the same senior. Every
// server senior-context read now goes through this function so the order can
// never diverge per call site again.
//
// Scope (KTD12): this module owns ONLY the read order and source metadata.
// Callers own authorization (e.g. MCP assertSeniorAccess runs BEFORE this) and
// prompt formatting. It never widens access: it reads exactly the two docs the
// caller was already authorized to read.

import * as admin from "firebase-admin";

export type SeniorProfileSource = "senior_profiles" | "seniors" | "none";

export interface SeniorProfileWithSource {
  /** Raw document data from the winning source, or null when neither exists. */
  profile: Record<string, unknown> | null;
  source: SeniorProfileSource;
}

/**
 * Canonical-first senior profile read. `senior_profiles/{id}` wins whenever it
 * exists (even if a conflicting legacy `seniors/{id}` doc remains); legacy is
 * consulted only when the canonical doc is absent.
 *
 * `db` is injectable for tests; production callers may pass their module-level
 * Firestore or omit it.
 */
export async function getSeniorProfileWithSource(
  seniorId: string,
  db: admin.firestore.Firestore = admin.firestore(),
): Promise<SeniorProfileWithSource> {
  if (!seniorId) return { profile: null, source: "none" };

  const canonical = await db.collection("senior_profiles").doc(seniorId).get();
  if (canonical.exists) {
    return { profile: (canonical.data() ?? {}) as Record<string, unknown>, source: "senior_profiles" };
  }

  const legacy = await db.collection("seniors").doc(seniorId).get();
  if (legacy.exists) {
    return { profile: (legacy.data() ?? {}) as Record<string, unknown>, source: "seniors" };
  }

  return { profile: null, source: "none" };
}
