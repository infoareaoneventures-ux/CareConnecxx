// Canonical objective ledger (plan 2026-07-18-001 U3, R13-R19/R22, KTD5/KTD6).
//
// One durable record of what a user is trying to accomplish across turns:
// structured intent, steps, missing inputs, expected reply, affected
// recipients, and completion evidence references. Deliberately NOT stored:
// model chain-of-thought, free-form rationale, or transcript copies (R14) —
// the description field is a short sanitized label, nothing more.
//
// Wave 1 ships this DARK as a library: no production caller writes objectives
// yet. Legacy stores (activeGoal, todos, commitments, pending actions) remain
// authoritative; read-through adapters and one-flow-at-a-time bridges come in
// the next slice with their own shadow evidence (KTD5).
//
// Storage: agent_objectives/{objectiveId} — server-only (clients are denied by
// the rules catch-all). Queries are registered as contracts Q28/Q29 in
// firestore.query-contracts.json per the plan's mandatory index workflow.

import * as admin from "firebase-admin";
import { sanitizePromptContext } from "./promptContext";
import type { CareVertical } from "../data/contract";
import { isChildRecipientRef, type TypedCareRecipientRef } from "./careRecipients";
import { authorityDocId } from "../childcare/guardianAuthority";

export const OBJECTIVES_COLLECTION = "agent_objectives";
export const OBJECTIVE_LEDGER_CAPABILITY = "objective_ledger";

export type ObjectiveStatus =
  | "active"
  | "waiting_user"
  | "waiting_external"
  | "blocked"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export const TERMINAL_STATUSES: ReadonlySet<ObjectiveStatus> = new Set([
  "completed", "cancelled", "expired", "failed",
]);

export type StepStatus = "pending" | "in_progress" | "done" | "skipped" | "failed";

export interface ObjectiveStep {
  id: string;
  /** Short sanitized label — never model reasoning or transcript text. */
  label: string;
  status: StepStatus;
  /** Step ids that must be done before this one can start. */
  dependsOn?: string[];
  /** Deterministic action key linking to the action/evidence ledgers (R25). */
  actionKey?: string;
  /** Evidence receipt reference (agent_action_ledger doc id or similar). */
  evidenceRef?: string;
  /** Optional: this step notifies/acknowledges another participant (R19). */
  affectedRecipient?: string;
}

export interface ExpectedReply {
  kind: "yes_no" | "time" | "choice" | "free";
  /** The missing-input field the reply resolves. */
  field: string;
  /** For kind=choice: the sanitized candidate labels. */
  choices?: string[];
}

export interface AgentObjective {
  objectiveId: string;
  userId: string;
  seniorId?: string;
  role: "client" | "caregiver" | "family-secondary";
  channel: "linq" | "web";
  /** Server-derived source-turn key of the turn that created it (U4 wires this). */
  sourceTurnKey?: string;
  /** Structured intent slug, e.g. "schedule.reschedule_visit". */
  intent: string;
  /** Short sanitized human label. NOT reasoning, NOT transcript (R14/KTD6). */
  description?: string;
  status: ObjectiveStatus;
  steps: ObjectiveStep[];
  /** Field names still needed from the user (drives clarification policy). */
  missingInputs: string[];
  expectedReply?: ExpectedReply;
  /** Other participants who must be notified before completion (R19). */
  affectedRecipients?: string[];
  /** Optimistic-concurrency version; every transition bumps it (R21/R25). */
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  terminalReason?: string;
  /**
   * Care vertical stamp (childcare plan 2026-07-22-002, U0/U4). ADDITIVE with
   * the senior legacy default: an absent field on a pre-childcare objective
   * reads as senior; childcare writers stamp "child" explicitly. New childcare
   * records are never silently senior (contract.ts cutoff rule).
   */
  careVertical?: CareVertical;
  /**
   * Typed recipient reference (U10/KTD18): senior objectives may carry a
   * recipientPlanKey ref; childcare objectives a childId+householdId ref
   * (IDs + display label only — never child PII, R57). Optional/additive —
   * legacy objectives have no ref.
   */
  recipientRef?: TypedCareRecipientRef;
  /** Child objectives pin the authority version used when work was created. */
  authorityBinding?: {
    childId: string;
    scope: "view";
    accessVersion: number;
  };
}

// ── Transition matrix (R13/R18) ──────────────────────────────────────────────
// Terminal states have no exits. "completed" is reachable only through
// applyTransition's completion gate below.

const ALLOWED_TRANSITIONS: Record<ObjectiveStatus, readonly ObjectiveStatus[]> = {
  active:           ["waiting_user", "waiting_external", "blocked", "paused", "completed", "cancelled", "expired", "failed"],
  waiting_user:     ["active", "blocked", "paused", "cancelled", "expired", "failed"],
  waiting_external: ["active", "blocked", "paused", "cancelled", "expired", "failed"],
  blocked:          ["active", "paused", "cancelled", "expired", "failed"],
  paused:           ["active", "cancelled", "expired"],
  completed:        [],
  cancelled:        [],
  expired:          [],
  failed:           [],
};

export function canTransition(from: ObjectiveStatus, to: ObjectiveStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Steps that count toward completion: everything not explicitly skipped. */
function incompleteMandatorySteps(steps: ObjectiveStep[]): ObjectiveStep[] {
  return steps.filter((s) => s.status !== "done" && s.status !== "skipped");
}

/**
 * Pure transition: validates the matrix, enforces the completion gate (R18 —
 * all mandatory steps done, no missing inputs, no unresolved expected reply),
 * bumps the version, and stamps terminal metadata. Throws on violations so a
 * caller can never silently corrupt the ledger.
 */
export function applyTransition(
  objective: AgentObjective,
  to: ObjectiveStatus,
  opts?: { reason?: string; now?: Date },
): AgentObjective {
  const from = objective.status;
  if (!canTransition(from, to)) {
    throw new Error(`objectiveLedger: illegal transition ${from} -> ${to} (${objective.objectiveId})`);
  }
  if (to === "completed") {
    const open = incompleteMandatorySteps(objective.steps);
    if (open.length > 0) {
      throw new Error(`objectiveLedger: cannot complete with ${open.length} unfinished step(s): ${open.map((s) => s.id).join(", ")}`);
    }
    if (objective.missingInputs.length > 0) {
      throw new Error(`objectiveLedger: cannot complete with missing inputs: ${objective.missingInputs.join(", ")}`);
    }
    if (objective.expectedReply) {
      throw new Error("objectiveLedger: cannot complete while a user reply is still expected");
    }
  }
  const nowIso = (opts?.now ?? new Date()).toISOString();
  return {
    ...objective,
    status: to,
    version: objective.version + 1,
    updatedAt: nowIso,
    terminalReason: TERMINAL_STATUSES.has(to) ? (opts?.reason ?? objective.terminalReason ?? to) : objective.terminalReason,
  };
}

// ── Deterministic foreground selection (R13) ─────────────────────────────────
// Multiple nonterminal objectives may coexist; exactly one is foreground per
// turn. Rank: status priority, then most recently updated, then objectiveId
// (stable tie-break so two servers always agree).

const FOREGROUND_PRIORITY: Record<ObjectiveStatus, number> = {
  active: 0,
  waiting_user: 1,
  waiting_external: 2,
  blocked: 3,
  paused: 4,
  completed: 99, cancelled: 99, expired: 99, failed: 99,
};

export function selectForegroundObjective(objectives: AgentObjective[]): AgentObjective | null {
  const nonterminal = objectives.filter((o) => !TERMINAL_STATUSES.has(o.status));
  if (nonterminal.length === 0) return null;
  return [...nonterminal].sort((a, b) =>
    (FOREGROUND_PRIORITY[a.status] - FOREGROUND_PRIORITY[b.status])
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.objectiveId.localeCompare(b.objectiveId),
  )[0];
}

/** Nonterminal + past expiry = eligible for an explicit `expired` transition.
 *  Never deletion: unresolved work is transitioned, not erased (retention). */
export function isExpiryEligible(objective: AgentObjective, now: Date = new Date()): boolean {
  return !TERMINAL_STATUSES.has(objective.status)
    && !!objective.expiresAt
    && Date.parse(objective.expiresAt) <= now.getTime();
}

// ── Firestore operations (server-only; thin over the pure functions) ─────────

export interface CreateObjectiveInput {
  userId: string;
  seniorId?: string;
  role: AgentObjective["role"];
  channel: AgentObjective["channel"];
  intent: string;
  description?: string;
  steps?: ObjectiveStep[];
  missingInputs?: string[];
  expectedReply?: ExpectedReply;
  affectedRecipients?: string[];
  sourceTurnKey?: string;
  expiresAt?: string;
  /** Vertical stamp — childcare writers pass "child" (U4); absent = legacy senior. */
  careVertical?: CareVertical;
  /** Typed recipient ref (U10) — see AgentObjective.recipientRef. */
  recipientRef?: TypedCareRecipientRef;
  authorityBinding?: AgentObjective["authorityBinding"];
  /**
   * Deterministic objective ID for idempotent creates (e.g. one family
   * childcare-enrollment objective per adult — AE15 duplicate-first-inbound).
   * When set, creation uses `create()` semantics: a concurrent duplicate
   * fails with ALREADY_EXISTS instead of overwriting (see ensureObjective).
   */
  objectiveId?: string;
}

export async function createObjective(
  input: CreateObjectiveInput,
  opts?: { db?: admin.firestore.Firestore; now?: Date },
): Promise<AgentObjective> {
  const db = opts?.db ?? admin.firestore();
  const nowIso = (opts?.now ?? new Date()).toISOString();
  const ref = input.objectiveId
    ? db.collection(OBJECTIVES_COLLECTION).doc(input.objectiveId)
    : db.collection(OBJECTIVES_COLLECTION).doc();
  if (input.recipientRef && isChildRecipientRef(input.recipientRef)) {
    if (
      input.careVertical !== "child" ||
      !input.authorityBinding ||
      input.authorityBinding.childId !== input.recipientRef.childId ||
      input.authorityBinding.scope !== "view" ||
      !Number.isFinite(Number(input.authorityBinding.accessVersion))
    ) {
      throw new Error("objectiveLedger: child objective requires a matching authority binding");
    }
  }
  const objective: AgentObjective = {
    objectiveId: ref.id,
    userId: input.userId,
    seniorId: input.seniorId,
    role: input.role,
    channel: input.channel,
    sourceTurnKey: input.sourceTurnKey,
    intent: input.intent,
    // Defense in depth: even the short label passes the prompt sanitizer so a
    // ledger record can never smuggle instruction-shaped text forward (R14).
    description: input.description ? sanitizePromptContext(input.description, 200) : undefined,
    status: "active",
    steps: input.steps ?? [],
    missingInputs: input.missingInputs ?? [],
    expectedReply: input.expectedReply,
    affectedRecipients: input.affectedRecipients,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: input.expiresAt,
    careVertical: input.careVertical,
    recipientRef: input.recipientRef,
    authorityBinding: input.authorityBinding,
  };
  // Firestore rejects undefined field values; strip them.
  const doc = Object.fromEntries(Object.entries(objective).filter(([, v]) => v !== undefined));
  if (input.objectiveId) {
    // Deterministic ID ⇒ create-once semantics (idempotency belongs to the
    // caller via ensureObjective; a raw duplicate create throws).
    await ref.create(doc);
  } else {
    await ref.set(doc);
  }
  return objective;
}

/**
 * Idempotent create for deterministic-ID objectives (U4): first caller wins,
 * every retry/duplicate converges on the SAME persisted objective (AE15).
 * Never overwrites — a lost race reads the winner's record back.
 */
export async function ensureObjective(
  input: CreateObjectiveInput & { objectiveId: string },
  opts?: { db?: admin.firestore.Firestore; now?: Date },
): Promise<{ objective: AgentObjective; created: boolean }> {
  const db = opts?.db ?? admin.firestore();
  try {
    const objective = await createObjective(input, { ...opts, db });
    return { objective, created: true };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const alreadyExists =
      code === 6 || code === "already-exists" ||
      /already exists/i.test(String((err as Error)?.message ?? ""));
    if (!alreadyExists) throw err;
    const snap = await db.collection(OBJECTIVES_COLLECTION).doc(input.objectiveId).get();
    if (!snap.exists) throw err; // create raced a delete — surface the original error
    return { objective: snap.data() as AgentObjective, created: false };
  }
}

/**
 * Optimistic-concurrency transition: the transaction re-reads the objective,
 * verifies the caller saw the current version (a stale retry can never apply
 * a duplicate transition — R25), then persists the pure transition result.
 */
export async function transitionObjective(
  objectiveId: string,
  to: ObjectiveStatus,
  expectedVersion: number,
  opts?: {
    db?: admin.firestore.Firestore;
    reason?: string;
    now?: Date;
    bypassAuthorityCheck?: boolean;
  },
): Promise<AgentObjective> {
  const db = opts?.db ?? admin.firestore();
  const ref = db.collection(OBJECTIVES_COLLECTION).doc(objectiveId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`objectiveLedger: objective ${objectiveId} not found`);
    const current = snap.data() as AgentObjective;
    if (current.version !== expectedVersion) {
      throw new Error(`objectiveLedger: version conflict on ${objectiveId} (expected ${expectedVersion}, found ${current.version})`);
    }
    if (
      !opts?.bypassAuthorityCheck &&
      current.careVertical === "child" &&
      current.recipientRef &&
      isChildRecipientRef(current.recipientRef)
    ) {
      const binding = current.authorityBinding;
      if (!binding || binding.childId !== current.recipientRef.childId) {
        throw new Error(`objectiveLedger: missing child authority binding on ${objectiveId}`);
      }
      const authoritySnap = await tx.get(
        db.collection("guardian_authorities").doc(
          authorityDocId(binding.childId, current.userId),
        ),
      );
      const authority = authoritySnap.data() ?? {};
      const nowMs = (opts?.now ?? new Date()).getTime();
      const expired =
        typeof authority.expiresAt === "string" &&
        authority.expiresAt &&
        Date.parse(authority.expiresAt) <= nowMs;
      if (
        !authoritySnap.exists ||
        authority.state !== "active" ||
        expired ||
        !Array.isArray(authority.scopes) ||
        !authority.scopes.includes(binding.scope) ||
        Number(authority.accessVersion) !== Number(binding.accessVersion)
      ) {
        throw new Error(`objectiveLedger: child authority changed on ${objectiveId}`);
      }
    }
    const next = applyTransition(current, to, { reason: opts?.reason, now: opts?.now });
    const doc = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
    tx.set(ref, doc);
    return next;
  });
}

/**
 * Nonterminal objectives for a user, newest first (contract Q28). Callers pass
 * the result to selectForegroundObjective for the per-turn focus.
 */
export async function loadOpenObjectives(
  userId: string,
  opts?: { db?: admin.firestore.Firestore; limit?: number },
): Promise<AgentObjective[]> {
  const db = opts?.db ?? admin.firestore();
  const snap = await db.collection(OBJECTIVES_COLLECTION)
    .where("userId", "==", userId)
    .where("status", "in", ["active", "waiting_user", "waiting_external", "blocked", "paused"])
    .orderBy("updatedAt", "desc")
    .limit(opts?.limit ?? 10)
    .get();
  const objectives = snap.docs.map((d) => d.data() as AgentObjective);
  const visible = await Promise.all(objectives.map(async (objective) => {
    if (
      objective.careVertical !== "child" ||
      !objective.recipientRef ||
      !isChildRecipientRef(objective.recipientRef)
    ) {
      return objective;
    }
    const binding = objective.authorityBinding;
    if (!binding || binding.childId !== objective.recipientRef.childId) return null;
    const authoritySnap = await db
      .collection("guardian_authorities")
      .doc(authorityDocId(binding.childId, objective.userId))
      .get();
    const authority = authoritySnap.data() ?? {};
    const expired =
      typeof authority.expiresAt === "string" &&
      authority.expiresAt &&
      Date.parse(authority.expiresAt) <= Date.now();
    return authoritySnap.exists &&
      authority.state === "active" &&
      !expired &&
      Array.isArray(authority.scopes) &&
      authority.scopes.includes(binding.scope) &&
      Number(authority.accessVersion) === Number(binding.accessVersion)
      ? objective
      : null;
  }));
  return visible.filter((objective): objective is AgentObjective => objective !== null);
}
