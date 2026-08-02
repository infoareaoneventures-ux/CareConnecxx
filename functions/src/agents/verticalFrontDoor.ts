// ── The authoritative role × vertical front door (childcare Stage 1) ─────────
//
// Design note: docs/architecture/childcare-front-door-design.md.
//
// R-FD2 in one module: the classifier PROPOSES, this module DECIDES, and only
// linq/webhooks.ts (a registered ingress consumer) performs the write. Nothing
// here reads Firestore or the model — every input is passed in, so the whole
// decision table is unit-testable and the same decision is reachable from SMS,
// web chat, and any future channel without duplicating policy.
//
// The three properties this module exists to guarantee:
//
//   1. AE19 / R49 — user text cannot grant anything. `sessionPatch` is a
//      CLOSED field set (see VERTICAL_PATCH_FIELDS): vertical stamps, the
//      unresolved posture, and a noted interest. It can never contain an
//      approval, a role escalation, a tool grant, or a uid.
//   2. R-FD8 — flags gate everything. A confident "child" with childcare
//      disabled resolves to `unavailable` (the U4 waitlist state), never a
//      senior fallthrough and never a bypass.
//   3. R-FD1 — unresolved is a real state. `ask` / `dual_ask` stamp
//      `verticalIntent: "pending"`, which memory/memoryEligibility already
//      treats as a denial (`pending_classification`) and which exposes no
//      recipient tools because the session never reaches the senior loop.

import type { CareRole, CareVertical, RoleVerticalClassification } from "./verticalClassifier";

export type { CareRole, CareVertical } from "./verticalClassifier";

/** Unresolved-classification sentinel shared with memory/memoryEligibility. */
export const VERTICAL_INTENT_PENDING = "pending";

/**
 * Marker meaning "both verticals were mentioned". Stored on a dual ask and
 * narrowed to the concrete OTHER vertical once the person picks one.
 */
export const DUAL_NOTED_INTEREST = "both";

/** Session step that owns the clarifying question (never a senior step). */
export const STEP_ASK_VERTICAL = "ask_vertical";

/** Session step that holds a detected-but-unconfirmed vertical switch (R-FD7). */
export const STEP_CONFIRM_VERTICAL_SWITCH = "confirm_vertical_switch";

/**
 * The COMPLETE set of session fields this module is ever allowed to write.
 * Pinned by verticalFrontDoor.test.ts (AE19): if a future change tries to
 * smuggle an approval or a role escalation through the front door, the test
 * fails before the code ships.
 */
export const VERTICAL_PATCH_FIELDS = [
  "careVertical",
  "verticalIntent",
  "verticalNotedInterest",
  "verticalPendingRole",
  "verticalAskAttempts",
  "pendingVerticalSwitch",
] as const;

export type VerticalFrontDoorOutcome =
  /** Senior — the live path. Callers MUST fall through to existing behavior. */
  | "senior"
  /** Childcare, authoritative. Stamp + route to the childcare ingress. */
  | "child"
  /** Childcare intent with childcare disabled → the U4 waitlist state (R-FD8). */
  | "unavailable"
  /** Vertical unresolved → ONE clarifying question, session held pending. */
  | "ask"
  /** Both verticals present → ask which to set up first; note the other. */
  | "dual_ask";

export interface VerticalFrontDoorDecision {
  outcome: VerticalFrontDoorOutcome;
  /** Authoritative vertical, or null while unresolved. */
  vertical: CareVertical | null;
  /** Role the server will act on, or null while unresolved. */
  role: CareRole | null;
  /** EXACTLY the session fields to merge. Never anything else (AE19). */
  sessionPatch: Record<string, unknown>;
  /** The one question to send, for `ask` / `dual_ask`. */
  question?: string;
  /** Machine-stable reason, safe to log. */
  reason: string;
}

export interface ResolveVerticalFrontDoorArgs {
  classification: RoleVerticalClassification;
  /** Role the server already knows (bridge doc / session), if any. */
  knownRole?: CareRole | null;
  /** Live childcare flag read. Callers MUST fail closed (`false`) on error. */
  childcareEnabled: boolean;
  /** How many times the clarifying question has already been asked. */
  askAttempts?: number;
}

// ── Copy (static templates — no LLM, no interpolated user text) ──────────────

/**
 * Attempt 1 is natural prose; a second ask is an explicit either/or (the
 * founder's 3-tier voice policy: a categorical choice gets a binary once the
 * natural ask did not land). It NEVER degrades to a senior default.
 */
export function verticalQuestion(askAttempts = 0): string {
  return askAttempts >= 1
    ? "I want to make sure I point you the right way — is this care for an ADULT, or CHILDCARE for kids? " +
        "Just reply with adult or kids."
    : "Happy to help — quick thing so I get you to the right place: are you looking for care for an adult, " +
        "or childcare for kids?";
}

/** Dual intent — one objective at a time; the other is noted, not started. */
export function dualVerticalQuestion(): string {
  return "Sounds like there's care needed on both sides — for an adult and for kids. I can set up either one, " +
    "and I'll hold onto the other so nothing gets lost. Which should we start with: the adult, or the kids?";
}

/** Confirmation ask for a detected mid-flow vertical switch (R-FD7). */
export function buildVerticalSwitchConfirmation(switchTo: CareVertical): string {
  return switchTo === "child"
    ? "Just so I don't get this wrong — do you want to switch this over to childcare for your kids? " +
        "If so I'll start that fresh, since the questions are different. Reply yes to switch."
    : "Just so I don't get this wrong — do you want to switch this over to care for an adult? " +
        "If so I'll start that fresh, since the questions are different. Reply yes to switch.";
}

// ── The decision ─────────────────────────────────────────────────────────────

function patch(fields: Record<string, unknown>): Record<string, unknown> {
  // Defence in depth for AE19: drop anything not on the closed list, even if a
  // caller (or a future edit) tries to add it.
  const allowed = new Set<string>(VERTICAL_PATCH_FIELDS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (allowed.has(k)) out[k] = v;
  return out;
}

/**
 * Turn an advisory classification into the authoritative front-door decision.
 *
 * PURE. Deterministic. The caller applies `sessionPatch` and routes on
 * `outcome`; it must never stamp a vertical from the classification directly.
 */
export function resolveVerticalFrontDoor(
  args: ResolveVerticalFrontDoorArgs,
): VerticalFrontDoorDecision {
  const { classification: c, childcareEnabled } = args;
  const askAttempts = Math.max(0, args.askAttempts ?? 0);
  // The server's role view wins over the model's when it has one (bridge doc
  // role, existing session userType) — model text never re-roles an account.
  const role: CareRole | null = args.knownRole ?? c.role ?? null;

  // Dual first: it is a conflict, so it must not be read as either vertical.
  if (c.dual) {
    return {
      outcome: "dual_ask",
      vertical: null,
      role,
      sessionPatch: patch({
        verticalIntent: VERTICAL_INTENT_PENDING,
        verticalAskAttempts: askAttempts + 1,
        // "both" is the marker that BOTH verticals were mentioned. Which one
        // becomes the noted interest is only knowable once they choose, so
        // resolvePendingVerticalAnswer narrows it to the OTHER vertical then.
        // A note, never a second objective (Stage 1 scope).
        verticalNotedInterest: DUAL_NOTED_INTEREST,
        ...(role ? { verticalPendingRole: role } : {}),
      }),
      question: dualVerticalQuestion(),
      reason: "dual_vertical",
    };
  }

  if (c.ambiguous || !c.vertical) {
    return {
      outcome: "ask",
      vertical: null,
      role,
      sessionPatch: patch({
        verticalIntent: VERTICAL_INTENT_PENDING,
        verticalAskAttempts: askAttempts + 1,
        ...(role ? { verticalPendingRole: role } : {}),
      }),
      question: verticalQuestion(askAttempts),
      reason: c.reason,
    };
  }

  if (c.vertical === "child") {
    // R-FD8: classification is never a bypass. Flags off → the waitlist state,
    // still STAMPED child so the U4 ingress owns the turn and the senior funnel
    // never sees this person.
    if (!childcareEnabled) {
      return {
        outcome: "unavailable",
        vertical: "child",
        role,
        sessionPatch: patch({ careVertical: "child", verticalIntent: "child" }),
        reason: "childcare_disabled",
      };
    }
    return {
      outcome: "child",
      vertical: "child",
      role,
      sessionPatch: patch({ careVertical: "child", verticalIntent: "child" }),
      reason: c.reason,
    };
  }

  // Senior. Deliberately NO patch: the live senior path must stay byte-identical
  // (no new fields on senior sessions, so every existing characterization test,
  // memory decision, and downstream reader is untouched).
  return {
    outcome: "senior",
    vertical: "senior",
    role,
    sessionPatch: {},
    reason: c.reason,
  };
}

// ── Resolving the answer to the clarifying question ──────────────────────────

export interface PendingVerticalAnswerArgs {
  classification: RoleVerticalClassification;
  knownRole?: CareRole | null;
  childcareEnabled: boolean;
  askAttempts?: number;
  /**
   * What the session already carries in `verticalNotedInterest`: a concrete
   * vertical, or DUAL_NOTED_INTEREST ("both") from a dual ask.
   */
  notedInterest?: CareVertical | typeof DUAL_NOTED_INTEREST | null;
}

/**
 * The reply to the clarifying question. Resolution is the SAME decision path —
 * so a resolved answer lands on the identical stamp/routing as a first-message
 * resolution, and an answer that still does not resolve asks again (R-FD1: it
 * never falls back to senior just because the user was vague twice).
 */
export function resolvePendingVerticalAnswer(
  args: PendingVerticalAnswerArgs,
): VerticalFrontDoorDecision {
  const decision = resolveVerticalFrontDoor({
    classification: args.classification,
    knownRole: args.knownRole ?? null,
    childcareEnabled: args.childcareEnabled,
    askAttempts: args.askAttempts ?? 0,
  });

  if (decision.outcome === "ask" || decision.outcome === "dual_ask") {
    // Still unresolved: carry an existing note forward rather than dropping it.
    return args.notedInterest
      ? {
          ...decision,
          sessionPatch: patch({ ...decision.sessionPatch, verticalNotedInterest: args.notedInterest }),
        }
      : decision;
  }

  // Resolved: clear the pending posture. A dual ask's "both" marker narrows to
  // the OTHER vertical — a NOTE only, never a second objective (Stage 1 scope).
  const resolvedPatch: Record<string, unknown> = {
    ...decision.sessionPatch,
    verticalIntent: decision.vertical === "child" ? "child" : "senior",
    verticalAskAttempts: 0,
  };
  const other: CareVertical = decision.vertical === "child" ? "senior" : "child";
  if (args.notedInterest === other || args.notedInterest === DUAL_NOTED_INTEREST) {
    resolvedPatch.verticalNotedInterest = other;
  } else if (args.notedInterest === decision.vertical) {
    // A note about the vertical they just chose is meaningless — drop it.
    resolvedPatch.verticalNotedInterest = null;
  }

  return { ...decision, sessionPatch: patch(resolvedPatch) };
}

// ── Mid-flow vertical switch: detect → CONFIRM → re-stamp (R-FD7) ────────────

/** Collected-state keys that are vertical-specific and must NOT carry over. */
export const SENIOR_ONLY_COLLECTED_FIELDS = [
  "seniorName",
  "age",
  "relationship",
  "conditions",
  "careNeeds",
  "mobility",
  "medications",
  "recipients",
] as const;

/**
 * A parked switch expires. Without a TTL an ignored confirmation would pin a
 * live signup behind a question forever — the same wedge the repo's other
 * awaiting steps guard with `isFlowStale`.
 */
export const VERTICAL_SWITCH_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/** Max confirmation re-asks before the hold is abandoned (deny-by-default). */
export const VERTICAL_SWITCH_MAX_ASKS = 2;

export interface VerticalSwitchHold {
  switchTo: CareVertical;
  askedAt: string;
  asks: number;
}

/**
 * The session patch that PARKS a detected switch awaiting confirmation. It does
 * NOT move `careVertical` — that is the whole point of R-FD7.
 */
export function buildVerticalSwitchHold(
  switchTo: CareVertical,
  now: Date = new Date(),
  asks = 1,
): Record<string, unknown> {
  return patch({
    pendingVerticalSwitch: { switchTo, askedAt: now.toISOString(), asks },
  });
}

/** Read a stored hold, or null when absent / malformed / expired. */
export function readVerticalSwitchHold(
  raw: unknown,
  now: Date = new Date(),
): VerticalSwitchHold | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as { switchTo?: unknown; askedAt?: unknown; asks?: unknown };
  const switchTo = h.switchTo === "child" ? "child" : h.switchTo === "senior" ? "senior" : null;
  if (!switchTo) return null;
  const askedAtMs = Date.parse(String(h.askedAt ?? ""));
  if (Number.isFinite(askedAtMs) && now.getTime() - askedAtMs > VERTICAL_SWITCH_HOLD_TTL_MS) {
    return null; // expired — the caller clears it and carries on unchanged
  }
  const asks = Number(h.asks);
  return {
    switchTo,
    askedAt: String(h.askedAt ?? now.toISOString()),
    asks: Number.isFinite(asks) && asks > 0 ? asks : 1,
  };
}

/** The patch that ABANDONS a hold without re-stamping anything. */
export function clearVerticalSwitchHold(): Record<string, unknown> {
  return patch({ pendingVerticalSwitch: null });
}

export interface VerticalSwitchConfirmationResult {
  /** True only on an explicit affirmative. */
  confirmed: boolean;
  vertical: CareVertical | null;
  /** Session fields to merge (the re-stamp, or the hold clear on a decline). */
  sessionPatch: Record<string, unknown>;
  /**
   * Vertical-specific onboardingData keys to DELETE. Senior answers must never
   * be carried into a childcare profile (or the reverse) — R-FD7.
   */
  clearCollectedFields: readonly string[];
  reason: string;
}

/**
 * Apply the user's answer to a parked switch. `affirmative` comes from the
 * caller's existing yes/no classifier (the repo's shared awaiting-reply
 * classification), keeping this module model-free.
 */
export function resolveVerticalSwitchConfirmation(args: {
  switchTo: CareVertical;
  affirmative: boolean;
  childcareEnabled: boolean;
}): VerticalSwitchConfirmationResult {
  if (!args.affirmative) {
    return {
      confirmed: false,
      vertical: null,
      // Clear the hold so the next turn is a normal turn again.
      sessionPatch: patch({ pendingVerticalSwitch: null }),
      clearCollectedFields: [],
      reason: "switch_declined",
    };
  }
  // R-FD8 again: confirming a switch INTO childcare while childcare is off
  // lands on the waitlist state, never on a half-switched senior session.
  if (args.switchTo === "child" && !args.childcareEnabled) {
    return {
      confirmed: true,
      vertical: "child",
      sessionPatch: patch({
        careVertical: "child",
        verticalIntent: "child",
        pendingVerticalSwitch: null,
      }),
      clearCollectedFields: SENIOR_ONLY_COLLECTED_FIELDS,
      reason: "switch_confirmed_childcare_disabled",
    };
  }
  return {
    confirmed: true,
    vertical: args.switchTo,
    sessionPatch: patch({
      careVertical: args.switchTo,
      verticalIntent: args.switchTo,
      pendingVerticalSwitch: null,
    }),
    // child → senior has no symmetric list BY DESIGN: R-FD4 forbids the
    // childcare conversation from collecting any child detail into
    // onboardingData, so there is nothing childcare-specific to clear. The
    // caller still resets the childcare STEP (routing state, not collected
    // state) when it re-stamps.
    clearCollectedFields:
      args.switchTo === "child" ? SENIOR_ONLY_COLLECTED_FIELDS : [],
    reason: "switch_confirmed",
  };
}
