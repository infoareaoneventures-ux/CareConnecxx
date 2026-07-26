// ── Childcare booking state machine (plan 2026-07-22-002, U7 / R36-R40) ──────
//
// PURE policy: no Firestore, no provider calls. bookingCallables.ts owns the
// async gates (guardian authority, provider eligibility rechecks, conflict
// queries, transactions) and applies transitions through this module so the
// graph, actor rules, payment gate, and idempotency semantics live in exactly
// one place.
//
// STRUCTURAL CONTRACTS:
//   • R36 order: family request → provider acceptance → conflict check →
//     CURRENT gates re-checked → payment authorization → confirmed exactly
//     once with postcondition evidence. `confirm` is a SYSTEM transition that
//     hard-requires paymentAuthorization.state === "authorized" — there is no
//     code path to "confirmed" that skips it.
//   • AE14: payment authorization BEFORE provider acceptance never advances
//     state — describeChildcareBookingStatus never says "confirmed" for a
//     requested/accepted booking regardless of payment state.
//   • KTD12: childcare bookings live in the shared booking_requests
//     collection as ADDITIVE careVertical:"child" docs with deterministic
//     create-once IDs; senior consumers select their own status vocabulary
//     ("pending"/"accepted") and additionally guard on the vertical stamp.
//   • Idempotency (AE15): every transition carries a transitionKey; replaying
//     an applied key is a no-op that converges to the same state.
//   • Stale-state protection: an optional expectedStateVersion (from a link /
//     stale UI) mismatching the live stateVersion fails closed.
//   • U8 SEAM (documented): this unit persists payment authorization STATE +
//     correlation IDs only. The actual Stripe authorize/capture/refund flows
//     are U8 — they will call bookingCallables.recordChildcareBookingPayment
//     Authorization() with a provider correlation ID. Nothing here talks to
//     Stripe.

// ── Status / event vocabulary ────────────────────────────────────────────────

/**
 * Childcare booking statuses. Deliberately DISJOINT from the senior
 * booking_requests vocabulary at the entry state ("requested", never
 * "pending") so the senior create-notification trigger can never fire for a
 * childcare doc even before its vertical guard. "accepted" (shared word with
 * senior) is why every senior consumer of status=="accepted" gains an
 * explicit careVertical guard in this unit.
 *
 * Substitution is an EVENT, not a status: a substituted booking continues in
 * its current active status with a new assigned caregiver; the substitution
 * record + safety access re-version carry the variant (KTD13/AE6).
 */
export const CHILDCARE_BOOKING_STATUSES = [
  "requested",
  "accepted",
  "confirmed",
  "in_progress",
  "completed",
  "declined",
  "canceled",
] as const;
export type ChildcareBookingStatus = (typeof CHILDCARE_BOOKING_STATUSES)[number];

export type ChildcareBookingEvent =
  | "accept"
  | "decline"
  | "confirm"
  | "check_in"
  | "check_out"
  | "check_out_visit"
  | "cancel";

export type ChildcareBookingActor = "family" | "provider" | "system";

/** Statuses in which the assigned caregiver holds live safety/file access. */
export const SAFETY_ACCESS_STATUSES: readonly ChildcareBookingStatus[] = [
  "accepted",
  "confirmed",
  "in_progress",
];

/** Statuses that occupy the caregiver's calendar for conflict purposes. */
export const CONFLICT_BLOCKING_STATUSES: readonly ChildcareBookingStatus[] = [
  "requested",
  "accepted",
  "confirmed",
  "in_progress",
];

// ── Payment authorization substate (U8 seam — state only, no Stripe here) ────

export type ChildcarePaymentAuthorizationState =
  | "none"
  | "pending"
  | "authorized"
  | "canceled";

export interface ChildcarePaymentAuthorization {
  state: ChildcarePaymentAuthorizationState;
  /** Provider correlation ID (e.g. a Stripe PaymentIntent id, U8). Never an amount decision. */
  correlationId: string | null;
  updatedAt: string;
}

// ── Schedule shapes ──────────────────────────────────────────────────────────

export interface ChildcareBookingDate {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM 24h */
  startTime: string;
  /** HH:MM 24h */
  endTime: string;
}

export interface ChildcareRecurringRule {
  /** Lowercase day names ("monday"...). */
  days: string[];
  startTime: string;
  endTime: string;
}

export interface ChildcareBookingSchedule {
  dates: ChildcareBookingDate[];
  recurring: ChildcareRecurringRule | null;
}

// ── The booking doc (booking_requests/{bookingId}, careVertical:"child") ─────

export interface ChildcareBookingTransitionRecord {
  event: "request" | ChildcareBookingEvent | "substitute" | "change";
  byUid: string;
  actor: ChildcareBookingActor;
  transitionKey: string;
  at: string;
}

export interface ChildcareBookingDoc {
  careVertical: "child";
  bookingId: string;
  clientId: string;
  caregiverId: string;
  /** Adult provider display name — never child data. */
  caregiverName: string;
  householdId: string;
  /** Typed recipient REFERENCES (R33/R46) — IDs only. */
  childIds: string[];
  recipientRef: { careVertical: "child"; householdId: string; childIds: string[] };
  /** Age-band-safe display label(s), joined — the only display field. */
  recipientLabel: string;
  status: ChildcareBookingStatus;
  /** Monotonic per transition — stale links/UIs pin it and fail closed. */
  stateVersion: number;
  schedule: ChildcareBookingSchedule;
  hourlyRate: number | null;
  jobId: string | null;
  applicationId: string | null;
  paymentAuthorization: ChildcarePaymentAuthorization;
  /** Last provider-eligibility recheck evidence (R29). */
  eligibilitySnapshot: {
    context: string;
    eligibilityVersion: string;
    evidenceVersion: number;
    at: string;
  } | null;
  /** Safety-projection access version currently granted (null = none). */
  safetyAccessVersion: number | null;
  lastTransition: ChildcareBookingTransitionRecord | null;
  /** Bounded applied-transition ledger (idempotent replay converges). */
  appliedTransitionKeys: string[];
  /** Postcondition evidence summary (agents/actionEvidence.ts pattern). */
  lastTransitionEvidence: {
    actionName: string;
    status: string;
    safeClaimCode: string;
    verifiedAt: string;
  } | null;
  substitution: {
    state: "none" | "revoked_pending_replacement";
    previousCaregiverUid: string | null;
    revokedAt: string | null;
  };
  pendingChange: {
    schedule: ChildcareBookingSchedule;
    requestedByUid: string;
    requestedAt: string;
    changeKey: string;
  } | null;
  /**
   * U9/AE24 suspected-unsafe-party exclusion hook: uids on this set receive
   * NO notification from any childcare fan-out touching this booking (in-app,
   * SMS, push). Absent by default; populated by U12's incident-hold policy.
   */
  excludedUids?: string[];
  canceledByUid?: string | null;
  cancelActor?: ChildcareBookingActor | null;
  declinedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type BookingPolicyErrorCode =
  | "invalid_input"
  | "invalid_transition"
  | "actor_not_allowed"
  | "stale_state_version"
  | "payment_not_authorized"
  | "overnight_category_blocked";

export class BookingPolicyError extends Error {
  code: BookingPolicyErrorCode;
  constructor(code: BookingPolicyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BookingPolicyError";
    this.code = code;
  }
}

// ── Transition table (WHO may trigger WHAT from WHERE) ───────────────────────

interface TransitionSpec {
  from: readonly ChildcareBookingStatus[];
  to: ChildcareBookingStatus;
  actors: readonly ChildcareBookingActor[];
  /** Gates the CALLER must re-check before applying (documentation + tests). */
  gates: readonly string[];
}

export const CHILDCARE_BOOKING_TRANSITIONS: Record<ChildcareBookingEvent, TransitionSpec> = {
  accept: {
    from: ["requested"],
    to: "accepted",
    actors: ["provider"],
    gates: ["provider_eligibility:acceptance", "conflict_recheck", "flags"],
  },
  decline: {
    from: ["requested"],
    to: "declined",
    actors: ["provider"],
    gates: ["flags"],
  },
  confirm: {
    from: ["accepted"],
    to: "confirmed",
    actors: ["system"],
    gates: ["payment_authorized", "family_gates_current", "provider_eligibility:acceptance"],
  },
  check_in: {
    from: ["confirmed"],
    to: "in_progress",
    actors: ["provider"],
    gates: ["assigned_caregiver", "provider_eligibility:check_in", "safety_access_current"],
  },
  check_out: {
    from: ["in_progress"],
    to: "completed",
    actors: ["provider"],
    gates: ["assigned_caregiver"],
  },
  /** Interim visit of a multi-visit/recurring booking: back to confirmed. */
  check_out_visit: {
    from: ["in_progress"],
    to: "confirmed",
    actors: ["provider"],
    gates: ["assigned_caregiver"],
  },
  cancel: {
    from: ["requested", "accepted", "confirmed"],
    to: "canceled",
    actors: ["family", "provider"],
    gates: ["cancellation_scope_or_assigned", "revoke_safety_first"],
  },
};

// ── Pure transition application ──────────────────────────────────────────────

export interface ApplyTransitionParams {
  event: ChildcareBookingEvent;
  actor: ChildcareBookingActor;
  byUid: string;
  transitionKey: string;
  now: Date;
  /** Optional optimistic-concurrency pin from a link/UI — mismatch fails closed. */
  expectedStateVersion?: number | null;
}

export interface ApplyTransitionResult {
  next: ChildcareBookingDoc;
  /** false = idempotent replay (transitionKey already applied) — no write needed. */
  changed: boolean;
}

const APPLIED_KEYS_LIMIT = 20;

/**
 * Apply one transition to an in-memory booking doc. Pure and synchronous —
 * callers run it inside a Firestore transaction against a fresh read, then
 * persist `next` exactly once (KTD23).
 */
export function applyChildcareBookingTransition(
  booking: ChildcareBookingDoc,
  params: ApplyTransitionParams,
): ApplyTransitionResult {
  const { event, actor, byUid, transitionKey, now } = params;
  if (!byUid || !transitionKey || transitionKey.length > 160) {
    throw new BookingPolicyError("invalid_input", "byUid and a bounded transitionKey are required");
  }
  const spec = CHILDCARE_BOOKING_TRANSITIONS[event];
  if (!spec) throw new BookingPolicyError("invalid_input", `unknown event "${event}"`);

  // Idempotent replay: same transitionKey converges without re-applying.
  if ((booking.appliedTransitionKeys ?? []).includes(transitionKey)) {
    return { next: booking, changed: false };
  }

  if (
    params.expectedStateVersion !== undefined &&
    params.expectedStateVersion !== null &&
    params.expectedStateVersion !== booking.stateVersion
  ) {
    throw new BookingPolicyError(
      "stale_state_version",
      `expected stateVersion ${params.expectedStateVersion} but booking is at ${booking.stateVersion}`,
    );
  }

  if (!spec.actors.includes(actor)) {
    throw new BookingPolicyError("actor_not_allowed", `actor "${actor}" may not trigger "${event}"`);
  }
  if (!spec.from.includes(booking.status)) {
    throw new BookingPolicyError(
      "invalid_transition",
      `cannot "${event}" from status "${booking.status}"`,
    );
  }

  // R36/AE14: confirmation REQUIRES an authorized payment state. No bypass.
  if (event === "confirm" && booking.paymentAuthorization?.state !== "authorized") {
    throw new BookingPolicyError(
      "payment_not_authorized",
      "confirmation requires paymentAuthorization.state === 'authorized'",
    );
  }

  const ts = now.toISOString();
  const record: ChildcareBookingTransitionRecord = {
    event,
    byUid,
    actor,
    transitionKey,
    at: ts,
  };
  const appliedTransitionKeys = [...(booking.appliedTransitionKeys ?? []), transitionKey].slice(
    -APPLIED_KEYS_LIMIT,
  );

  const next: ChildcareBookingDoc = {
    ...booking,
    status: spec.to,
    stateVersion: Number(booking.stateVersion ?? 0) + 1,
    lastTransition: record,
    appliedTransitionKeys,
    ...(event === "decline" ? { declinedAt: ts } : {}),
    ...(event === "check_out" ? { completedAt: ts } : {}),
    ...(event === "cancel" ? { canceledByUid: byUid, cancelActor: actor } : {}),
    updatedAt: ts,
  };
  return { next, changed: true };
}

// ── Truthful status copy (AE14) ──────────────────────────────────────────────

/**
 * User-facing status description. Requested/accepted bookings are PENDING —
 * never described as confirmed care, no matter what the payment state says.
 */
export function describeChildcareBookingStatus(
  status: ChildcareBookingStatus,
  payment?: ChildcarePaymentAuthorizationState,
): string {
  switch (status) {
    case "requested":
      return payment === "authorized" || payment === "pending"
        ? "Booking request pending — waiting for the caregiver to accept. Payment is set aside but care is not confirmed yet."
        : "Booking request pending — waiting for the caregiver to accept.";
    case "accepted":
      return "Caregiver accepted — finalizing payment authorization. Care is not confirmed yet.";
    case "confirmed":
      return "Booking confirmed.";
    case "in_progress":
      return "Care visit in progress.";
    case "completed":
      return "Care visit completed.";
    case "declined":
      return "The caregiver declined this request.";
    case "canceled":
      return "This booking was canceled.";
  }
}

// ── Schedule validation + overnight detection (deferred-category block) ──────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_DAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);
export const MAX_BOOKING_DATES = 30;

export function normalizeChildcareBookingSchedule(raw: unknown): ChildcareBookingSchedule {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawDates = Array.isArray(r.dates) ? r.dates : [];
  const rawRecurring = r.recurring as Record<string, unknown> | null | undefined;

  const dates: ChildcareBookingDate[] = [];
  for (const entry of rawDates) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const date = String(e.date ?? "").trim();
    const startTime = String(e.startTime ?? "").trim();
    const endTime = String(e.endTime ?? "").trim();
    if (!DATE_RE.test(date) || !TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
      throw new BookingPolicyError("invalid_input", "each date needs date/startTime/endTime");
    }
    dates.push({ date, startTime, endTime });
  }
  if (dates.length > MAX_BOOKING_DATES) {
    throw new BookingPolicyError("invalid_input", `at most ${MAX_BOOKING_DATES} dates per booking`);
  }

  let recurring: ChildcareRecurringRule | null = null;
  if (rawRecurring && typeof rawRecurring === "object") {
    const days = Array.isArray(rawRecurring.days)
      ? rawRecurring.days.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean)
      : [];
    const startTime = String(rawRecurring.startTime ?? "").trim();
    const endTime = String(rawRecurring.endTime ?? "").trim();
    if (
      days.length === 0 || days.length > 7 ||
      days.some((d) => !VALID_DAYS.has(d)) ||
      !TIME_RE.test(startTime) || !TIME_RE.test(endTime)
    ) {
      throw new BookingPolicyError("invalid_input", "recurring rule needs valid days/startTime/endTime");
    }
    recurring = { days: [...new Set(days)], startTime, endTime };
  }

  if (dates.length === 0 && !recurring) {
    throw new BookingPolicyError("invalid_input", "a booking needs at least one date or a recurring rule");
  }
  return { dates, recurring };
}

/**
 * Overnight detection: any window that crosses midnight (end <= start) is an
 * overnight booking. The CATEGORY is hard-blocked by U1 policy (deferred) —
 * the caller asserts assertEnableableChildcareCategory("overnight_care"),
 * which fails closed end to end.
 */
export function isOvernightSchedule(schedule: ChildcareBookingSchedule): boolean {
  const crossesMidnight = (start: string, end: string) => end <= start;
  if (schedule.dates.some((d) => crossesMidnight(d.startTime, d.endTime))) return true;
  if (schedule.recurring && crossesMidnight(schedule.recurring.startTime, schedule.recurring.endTime)) {
    return true;
  }
  return false;
}

// ── Time-overlap primitives (conflict checks, both verticals) ────────────────

export function timesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Do any of the booking's concrete dates overlap the given window? */
export function scheduleConflictsWith(
  schedule: ChildcareBookingSchedule,
  target: ChildcareBookingDate,
): boolean {
  for (const d of schedule.dates) {
    if (d.date === target.date && timesOverlap(d.startTime, d.endTime, target.startTime, target.endTime)) {
      return true;
    }
  }
  if (schedule.recurring) {
    const dayName = dayNameOf(target.date);
    if (
      dayName &&
      schedule.recurring.days.includes(dayName) &&
      timesOverlap(schedule.recurring.startTime, schedule.recurring.endTime, target.startTime, target.endTime)
    ) {
      return true;
    }
  }
  return false;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function dayNameOf(date: string): string | null {
  const d = new Date(`${date}T12:00:00`);
  return Number.isFinite(d.getTime()) ? DAY_NAMES[d.getDay()] : null;
}

/**
 * Expand a recurring rule to concrete dates in [fromDate, toDate] (inclusive,
 * YYYY-MM-DD). Mirrors scheduled/shiftGenerator.ts week-walk semantics.
 */
export function expandRecurringDates(
  rule: ChildcareRecurringRule,
  fromDate: string,
  toDate: string,
): ChildcareBookingDate[] {
  const out: ChildcareBookingDate[] = [];
  const start = new Date(`${fromDate}T12:00:00`);
  const end = new Date(`${toDate}T12:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return out;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayName = DAY_NAMES[d.getDay()];
    if (rule.days.includes(dayName)) {
      out.push({
        date: d.toISOString().split("T")[0],
        startTime: rule.startTime,
        endTime: rule.endTime,
      });
    }
  }
  return out;
}

// ── Doc construction ─────────────────────────────────────────────────────────

export interface CreateBookingDocParams {
  bookingId: string;
  clientId: string;
  caregiverId: string;
  caregiverName: string;
  householdId: string;
  childIds: string[];
  recipientLabel: string;
  schedule: ChildcareBookingSchedule;
  hourlyRate: number | null;
  jobId?: string | null;
  applicationId?: string | null;
  requestTransitionKey: string;
  eligibilitySnapshot: ChildcareBookingDoc["eligibilitySnapshot"];
  now: Date;
}

export function buildChildcareBookingDoc(params: CreateBookingDocParams): ChildcareBookingDoc {
  const ts = params.now.toISOString();
  return {
    careVertical: "child",
    bookingId: params.bookingId,
    clientId: params.clientId,
    caregiverId: params.caregiverId,
    caregiverName: String(params.caregiverName ?? "").trim().slice(0, 80) || "Caregiver",
    householdId: params.householdId,
    childIds: [...params.childIds],
    recipientRef: {
      careVertical: "child",
      householdId: params.householdId,
      childIds: [...params.childIds],
    },
    recipientLabel: String(params.recipientLabel ?? "").trim().slice(0, 120) || "your child",
    status: "requested",
    stateVersion: 1,
    schedule: params.schedule,
    hourlyRate: typeof params.hourlyRate === "number" && isFinite(params.hourlyRate)
      ? params.hourlyRate
      : null,
    jobId: params.jobId ?? null,
    applicationId: params.applicationId ?? null,
    paymentAuthorization: { state: "none", correlationId: null, updatedAt: ts },
    eligibilitySnapshot: params.eligibilitySnapshot,
    safetyAccessVersion: null,
    lastTransition: {
      event: "request",
      byUid: params.clientId,
      actor: "family",
      transitionKey: params.requestTransitionKey,
      at: ts,
    },
    appliedTransitionKeys: [params.requestTransitionKey],
    lastTransitionEvidence: null,
    substitution: { state: "none", previousCaregiverUid: null, revokedAt: null },
    pendingChange: null,
    canceledByUid: null,
    cancelActor: null,
    declinedAt: null,
    completedAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}
