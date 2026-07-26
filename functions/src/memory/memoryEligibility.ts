// ── Memory eligibility (childcare marketplace plan 2026-07-22-002, U4 → U10) ─
//
// THE decision seam between conversation ingress and every memory subsystem.
// U4 shipped the minimal typed precursor; U10 (this version) grows it into the
// full MemoryEligibilityDecision surface consulted by EVERY memory subsystem:
//   • Zep init/transcript (webhooks.ts call sites + memoryOperationWorker)
//   • learned-fact extraction (learnedFacts.extractAndStoreFacts)
//   • completed-turn persistence (conversationMemory.persistCompletedTurn)
//   • memory files (memoryFiles.initializeMemoryFiles / consolidateMemoryForUser)
//   • nightly consolidation + proactive reflection (scheduled/*)
//   • eval capture (evals/evalCandidateQueue.submitEvalCandidate)
// Denied rows are stamped with IMMUTABLE exclusion metadata
// (buildMemoryExclusionStamp) so downstream jobs can refuse them without
// re-deriving policy, and a session reclassified senior→child never backfills
// Zep (retroactive-sync prohibition, R48/R50).
//
// Contract (R48/R50, KTD17, AE22/AE23):
//   • Childcare-vertical sessions are DENIED — child/family facts never enter
//     Zep, learned facts, memory files, summaries, or eval captures.
//   • Pending-classification sessions (a typed childcare-capable intent that
//     has not resolved yet) are DENIED.
//   • Unclassified sessions (no typed vertical AND no classified account
//     role) are DENIED — unclassified inbound is a real fail-closed state:
//     it may classify role/vertical but cannot initialize memory, and there
//     is NO retroactive memory sync of earlier turns once it classifies.
//   • Senior-classified sessions are ELIGIBLE — the live senior path must
//     not change (parity is pinned by memoryEligibility.test.ts and the
//     handleInbound routing suite).
//
// The DECISION surface is intentionally PURE (no Firestore, no env): callers
// pass the session shape they already hold. That keeps the predicate
// synchronously usable at every initializeZepOnFirstContact call site in
// linq/webhooks.ts (first contact, secondary family member, pending-consent
// opt-in, web bridge, the widened lazy self-heal) and the onboarding Zep
// logging site. The ONLY impure exports are the explicitly-separate
// mark/clearCaregiverChildcareContext session stampers at the bottom (U10).
//
// KNOWN, PLAN-SANCTIONED BEHAVIOR DELTA (documented for the founder): the
// cold-SMS first-contact site creates its session UNCLASSIFIED (userType
// null, onboardingStep "ask_role"), so Zep initialization now happens on the
// first turn AFTER role classification (via the lazy self-heal) instead of at
// first contact. The plan's U4 approach section names this explicitly: "this
// inverts the live always-initialize invariant". Web-bridge signups (the
// dominant path) are classified at session creation and are unchanged.

export const MEMORY_ELIGIBILITY_POLICY_VERSION = "memory-eligibility-2026-07-22.1";

/** Machine-stable decision reasons. Eligible reasons first, denials after. */
export type MemoryEligibilityReason =
  // eligible
  | "senior_classified"      // explicit careVertical === "senior"
  | "senior_default_legacy"  // classified role, no vertical stamp (pre-cutoff legacy default)
  // denied
  | "childcare_vertical"     // typed child vertical/intent present
  | "caregiver_childcare_context" // AE22: caregiver session with active childcare context
  | "pending_classification" // typed pending intent — fail closed until resolved
  | "unclassified_session"   // no vertical stamp and no classified role
  | "no_session";            // nothing to decide on

/**
 * Per-subsystem eligibility (U10, R50/KTD17). One boolean per memory
 * subsystem so a caller gates exactly the write it is about to perform.
 * Today every reason maps to all-true or all-false — the map exists so a
 * future partial rule (e.g. transcript-yes/facts-no) is a data change, not a
 * call-site sweep. Callers MUST consult their own key, never `eligible` alone,
 * for non-Zep subsystems.
 */
export interface MemorySubsystemEligibility {
  /** Zep user/thread init + transcript + graph writes. */
  zep: boolean;
  /** learnedFacts extraction (learned_facts collection). */
  learnedFacts: boolean;
  /** conversationMemory turn_sync operation (Zep transcript + fact fan-out). */
  conversationMemory: boolean;
  /** Storage memory files (write/init/consolidate). */
  memoryFiles: boolean;
  /** Nightly compression / generic summaries / proactive reflection inputs. */
  summaries: boolean;
  /** Eval/training capture (evia_eval_candidates, training datasets). */
  evalCapture: boolean;
}

/** Typed decision consulted by every memory subsystem (R50/KTD17). */
export interface MemoryEligibilityDecision {
  eligible: boolean;
  reason: MemoryEligibilityReason;
  policyVersion: string;
  subsystems: MemorySubsystemEligibility;
}

/**
 * IMMUTABLE exclusion metadata stamped onto denied rows (operational
 * transcript rows, notification rows, smoke rows). Consumers must treat the
 * stamp as append-only truth: a stamped row is never fact-extracted,
 * compressed into a summary, synced to Zep, or captured for evals —
 * regardless of later session reclassification (retroactive-sync
 * prohibition).
 */
export interface MemoryExclusionStamp {
  memoryExcluded: true;
  reason: MemoryEligibilityReason;
  policyVersion: string;
  decidedAt: string; // ISO
}

export function buildMemoryExclusionStamp(
  decision: MemoryEligibilityDecision,
  now: Date = new Date(),
): MemoryExclusionStamp {
  return {
    memoryExcluded: true,
    reason: decision.reason,
    policyVersion: decision.policyVersion,
    decidedAt: now.toISOString(),
  };
}

/** True when a persisted row carries the immutable exclusion stamp. */
export function isMemoryExcludedRow(row: Record<string, unknown> | null | undefined): boolean {
  return !!row && (row as { memoryExcluded?: unknown }).memoryExcluded === true;
}

/**
 * The minimal slice of an agent_sessions doc the decision reads. Extra fields
 * are ignored — callers can pass the full session object.
 */
export interface MemoryEligibilitySessionLike {
  /** Classified account role ("client" | "caregiver" | legacy values). */
  userType?: string | null;
  /** Typed care vertical stamped by U4 ingress ("senior" | "child"). */
  careVertical?: string | null;
  /** Typed signup/classification intent ("senior" | "child" | "pending"). */
  verticalIntent?: string | null;
  /**
   * AE22 (U10): stamped true on a CAREGIVER session while the caregiver has an
   * active childcare engagement (accepted childcare booking / substitution).
   * While set, the session is memory-denied so childcare qualifications and
   * child-adjacent details discussed in the caregiver thread never enter
   * general Evia memory. Deliberately over-broad for the pilot (full denial,
   * not per-topic filtering) — documented in the U10 report.
   */
  childcareContextActive?: boolean | null;
}

const ALL_SUBSYSTEMS_ELIGIBLE: MemorySubsystemEligibility = Object.freeze({
  zep: true,
  learnedFacts: true,
  conversationMemory: true,
  memoryFiles: true,
  summaries: true,
  evalCapture: true,
});

const ALL_SUBSYSTEMS_DENIED: MemorySubsystemEligibility = Object.freeze({
  zep: false,
  learnedFacts: false,
  conversationMemory: false,
  memoryFiles: false,
  summaries: false,
  evalCapture: false,
});

function decide(
  eligible: boolean,
  reason: MemoryEligibilityReason,
): MemoryEligibilityDecision {
  return {
    eligible,
    reason,
    policyVersion: MEMORY_ELIGIBILITY_POLICY_VERSION,
    subsystems: eligible ? ALL_SUBSYSTEMS_ELIGIBLE : ALL_SUBSYSTEMS_DENIED,
  };
}

/**
 * Pure eligibility decision. Deny-first ordering: a childcare stamp always
 * wins over a classified role (a session can never be memory-eligible just
 * because it also looks like a client).
 */
export function decideMemoryEligibility(
  session: MemoryEligibilitySessionLike | null | undefined,
): MemoryEligibilityDecision {
  if (!session || typeof session !== "object") return decide(false, "no_session");

  const vertical = typeof session.careVertical === "string" ? session.careVertical : "";
  const intent = typeof session.verticalIntent === "string" ? session.verticalIntent : "";

  // Childcare vertical — denied regardless of any other field (R50/AE22).
  if (vertical === "child" || intent === "child") {
    return decide(false, "childcare_vertical");
  }

  // Typed pending classification — fail closed until it resolves (R48).
  if (vertical === "pending" || intent === "pending") {
    return decide(false, "pending_classification");
  }

  // AE22 (U10): a caregiver session with an active childcare engagement is
  // memory-denied while the context flag is set — childcare qualifications
  // discussed in the caregiver thread must never enter general memory. This
  // outranks the senior-eligible branches below but never fires on family
  // (client) sessions, so senior-family parity is untouched.
  if (session.childcareContextActive === true) {
    return decide(false, "caregiver_childcare_context");
  }

  // Explicit senior stamp — eligible.
  if (vertical === "senior") return decide(true, "senior_classified");

  // Legacy default: a CLASSIFIED role with no vertical stamp is a senior
  // record by construction (contract.ts legacy-cutoff rule — every session
  // that exists before the childcare launch is senior). This is what keeps
  // the live senior path byte-for-byte unchanged.
  const role = typeof session.userType === "string" ? session.userType.trim() : "";
  if (role) return decide(true, "senior_default_legacy");

  // No vertical, no role — unclassified inbound. Fail closed (R48/AE23).
  return decide(false, "unclassified_session");
}

/** Convenience boolean for call sites that don't record the reason. */
export function isMemoryEligible(
  session: MemoryEligibilitySessionLike | null | undefined,
): boolean {
  return decideMemoryEligibility(session).eligible;
}

/**
 * Structured, PII-free denial log line (R57): reason + policy version only.
 * `site` names the call site (static string), never message content.
 */
export function logMemoryDenial(site: string, decision: MemoryEligibilityDecision): void {
  if (decision.eligible) return;
  console.info(JSON.stringify({
    memory_denied: true,
    site,
    reason: decision.reason,
    policyVersion: decision.policyVersion,
  }));
}

// ── AE22 caregiver childcare-context stampers (impure, U10) ──────────────────
//
// The ONLY Firestore-touching exports in this module, kept here because they
// exist purely to feed the decision above. Called best-effort from the
// childcare booking acceptance/substitution seams: while a caregiver holds an
// active childcare engagement, their agent session is memory-denied
// (reason "caregiver_childcare_context").

type StampDb = { collection: (name: string) => FirebaseFirestore.CollectionReference };

async function resolveCaregiverSessionPhone(
  caregiverUid: string,
  db: StampDb,
): Promise<string | null> {
  for (const col of ["caregivers", "users"] as const) {
    try {
      const snap = await db.collection(col).doc(caregiverUid).get();
      const phone = snap.exists ? String((snap.data() ?? {}).phone ?? "").trim() : "";
      if (phone) return phone;
    } catch {
      // best-effort — try the next source
    }
  }
  return null;
}

/**
 * Stamp `childcareContextActive: true` onto the caregiver's agent session.
 * Best-effort (never throws): a failed stamp only means the caregiver session
 * stays at its previous memory posture — never a childcare data leak, because
 * child data itself never rides SMS threads (R33).
 */
export async function markCaregiverChildcareContext(
  caregiverUid: string,
  opts: { db?: StampDb; now?: Date } = {},
): Promise<boolean> {
  try {
    const admin = await import("firebase-admin");
    const db = opts.db ?? (admin.firestore() as unknown as StampDb);
    const phone = await resolveCaregiverSessionPhone(caregiverUid, db);
    if (!phone) return false;
    await (db.collection("agent_sessions").doc(phone) as FirebaseFirestore.DocumentReference).set({
      childcareContextActive: true,
      childcareContextStampedAt: (opts.now ?? new Date()).toISOString(),
    }, { merge: true });
    return true;
  } catch (err) {
    console.warn("memoryEligibility: caregiver childcare-context stamp failed (best-effort)", {
      reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
    return false;
  }
}

/**
 * Statuses that mean the caregiver still holds a live childcare engagement.
 * Mirrors bookingPolicy's non-terminal set; duplicated as a local literal so
 * this leaf memory module keeps no import edge into the childcare stack.
 */
const ENGAGED_CHILDCARE_BOOKING_STATUSES = ["requested", "accepted", "confirmed", "in_progress"];

/**
 * The AE22 counterpart to `markCaregiverChildcareContext`: restore a caregiver's
 * general memory eligibility once they hold NO remaining childcare engagement
 * (every childcare booking of theirs is completed / declined / canceled).
 *
 * FAIL-CLOSED by construction: any read error, or any doubt about whether an
 * engagement remains, leaves the denial stamp in place and returns false.
 * Clearing on uncertainty is the only outcome that could leak childcare context
 * into general memory, so it never happens — the cost of over-denying is a
 * caregiver's senior-side memory staying cold slightly longer, which is
 * recoverable; the cost of under-denying is not.
 *
 * Best-effort (never throws) — called from the childcare booking completion,
 * cancellation, and substitution-release seams.
 */
export async function clearCaregiverChildcareContextIfIdle(
  caregiverUid: string,
  opts: { db?: StampDb; now?: Date } = {},
): Promise<boolean> {
  try {
    const admin = await import("firebase-admin");
    const db = opts.db ?? (admin.firestore() as unknown as StampDb);

    // Equality-only query + in-memory status filter: deliberately needs no new
    // composite index (same shape the U11 family-read callables use).
    const snap = await db.collection("booking_requests")
      .where("careVertical", "==", "child")
      .where("caregiverId", "==", caregiverUid)
      .get();

    const stillEngaged = snap.docs.some((d) => {
      const status = String((d.data() ?? {}).status ?? "");
      return ENGAGED_CHILDCARE_BOOKING_STATUSES.includes(status);
    });
    if (stillEngaged) return false;

    const phone = await resolveCaregiverSessionPhone(caregiverUid, db);
    if (!phone) return false;
    const ref = db.collection("agent_sessions").doc(phone) as FirebaseFirestore.DocumentReference;
    const session = await ref.get();
    // Nothing to restore if the stamp was never set — avoids a pointless write
    // on every childcare booking completion.
    if (!session.exists || (session.data() ?? {}).childcareContextActive !== true) return false;

    await ref.set({
      childcareContextActive: false,
      childcareContextClearedAt: (opts.now ?? new Date()).toISOString(),
    }, { merge: true });
    return true;
  } catch (err) {
    console.warn("memoryEligibility: caregiver childcare-context clear failed (fail-closed, stamp retained)", {
      reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
    return false;
  }
}
