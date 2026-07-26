// ── Childcare incident case policy (plan 2026-07-22-002, U12 / R53, R55-R57,
//    AE24) ────────────────────────────────────────────────────────────────────
//
// Deterministic, human-owned incident case management over U10's typed seam
// (childcare/incidentSignal.ts): serious-incident markers on agent_sessions
// (`childcareIncidentMarker` + `childcareIncidentAt`) and direct operator
// reports become ONE restricted case each in `childcare_incidents` (AE24 —
// dedupe on the marker via a deterministic case id, so the system path and an
// operator "create from escalation" click converge on the same doc).
//
// STRUCTURAL CONTRACTS:
//   • The case doc stores REFERENCES to evidence (booking/message/file/shift/
//     session ids) — never copies of child data (R57). The bounded operator
//     summary is restricted-case content served only through the
//     childSafetyOperator + reason detail callable.
//   • Status workflow is a deterministic transition map (open → investigating
//     → resolved/escalated, plus appeal/correction states). Every transition
//     appends an immutable in-doc history entry AND an audit-log row. Model
//     text can never move a case (R53) — only these server functions do.
//   • Suspected-party exclusion feeds U9: the suspect's uid is unioned into
//     the booking's `excludedUids` set, which every childcare notification
//     fan-out consults (conversationPolicy.filterExcludedNotificationRecipients,
//     AE24 — no generic broadcast reaches a suspected unsafe party).
//   • Payout hold reuses U8's holdChildcareShiftPayout (money stops before it
//     moves; already-paid-out escalates, never claws back).
//   • Litigation hold reuses U3's child legal hold
//     (childProfileRepository.setChildLegalHold) — an active hold blocks
//     delete/redact lifecycle requests until cleared (evidence preservation).
//   • Firestore posture: childcare_incidents is FULLY server-only — browser
//     reads are denied even to admins; the queue and detail flow exclusively
//     through the U12 callables (sanitized queue rows are a pinned key set).
//
// EMERGENCY-OFF: none of these functions consult the childcare runtime flags —
// safety operations are never dark (U3 lifecycle-worker carve-out class).
//
// Injectable-db module in the guardianAuthority.ts idiom (defaultDb lazily —
// never a module-load admin.firestore() binding).

import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { logAudit } from "../observability/auditLog";
import {
  CHILDCARE_INCIDENT_CATEGORIES,
  type ChildcareIncidentCategory,
} from "./incidentSignal";

export const CHILDCARE_INCIDENTS_COLLECTION = "childcare_incidents";

// ── Categories ────────────────────────────────────────────────────────────────
//
// U10's deterministic classifier categories + the operator-created categories
// (deterministic allowlist — free-form categories are rejected, R53).

export const CHILDCARE_INCIDENT_OPERATOR_CATEGORIES = [
  "identity_mismatch",
  "policy_violation",
  "serious_complaint",
  "other_serious",
] as const;

export const ALL_CHILDCARE_INCIDENT_CATEGORIES: readonly string[] = [
  ...CHILDCARE_INCIDENT_CATEGORIES,
  ...CHILDCARE_INCIDENT_OPERATOR_CATEGORIES,
];

export function isChildcareIncidentCategory(value: unknown): value is string {
  return typeof value === "string" && ALL_CHILDCARE_INCIDENT_CATEGORIES.includes(value);
}

// ── Status workflow (deterministic transition map) ───────────────────────────

export type ChildcareIncidentStatus =
  | "open"
  | "investigating"
  | "resolved"
  | "escalated"
  | "appealed"
  | "corrected";

export const CHILDCARE_INCIDENT_STATUS_TRANSITIONS: Record<
  ChildcareIncidentStatus,
  readonly ChildcareIncidentStatus[]
> = {
  open: ["investigating"],
  investigating: ["resolved", "escalated"],
  // External escalation (law enforcement / counsel) returns to investigation
  // or resolves; it never silently closes.
  escalated: ["investigating", "resolved"],
  // Appeal/correction states (R56): a resolved case can be appealed; an appeal
  // either re-resolves (upheld) or produces a correction (terminal, audited).
  resolved: ["appealed"],
  appealed: ["resolved", "corrected"],
  corrected: [],
};

export function isValidIncidentTransition(
  from: ChildcareIncidentStatus,
  to: ChildcareIncidentStatus,
): boolean {
  return (CHILDCARE_INCIDENT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export const INCIDENT_EVIDENCE_KINDS = [
  "booking",
  "message",
  "file",
  "shift",
  "session",
  "review",
] as const;
export type IncidentEvidenceKind = (typeof INCIDENT_EVIDENCE_KINDS)[number];

/** Evidence REFERENCE — an opaque pointer, never a copy of the record (R57). */
export interface IncidentEvidenceRef {
  kind: IncidentEvidenceKind;
  ref: string;
  addedByUid: string;
  addedAt: string;
}

export interface IncidentTransitionEntry {
  from: ChildcareIncidentStatus;
  to: ChildcareIncidentStatus;
  byUid: string;
  at: string;
  note: string | null;
}

export interface ChildcareIncidentCaseDoc {
  caseId: string;
  careVertical: "child";
  category: string;
  source: "marker" | "operator_report";
  /** AE24 dedupe key for marker-created cases (null for direct reports). */
  markerKey: string | null;
  reporterUid: string | null;
  status: ChildcareIncidentStatus;
  /** Case owner (deterministic ownership — R53). Null until assigned. */
  ownerUid: string | null;
  /** Bounded operator summary — restricted-case content, detail-only surface. */
  summary: string | null;
  /** Opaque correlation refs (ids only — never child facts). */
  subject: {
    bookingId: string | null;
    sessionPhone: string | null;
    householdId: string | null;
  };
  evidenceRefs: IncidentEvidenceRef[];
  suspectedPartyUids: string[];
  payoutHolds: Array<{ appointmentId: string; heldAt: string; alreadyPaidOut: boolean }>;
  litigationHolds: Array<{ childId: string; active: boolean; changedAt: string }>;
  transitions: IncidentTransitionEntry[];
  createdAt: string;
  updatedAt: string;
}

export type ChildcareIncidentErrorCode =
  | "invalid_input"
  | "case_not_found"
  | "invalid_transition"
  | "marker_not_found";

export class ChildcareIncidentError extends Error {
  constructor(
    public readonly code: ChildcareIncidentErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ChildcareIncidentError";
  }
}

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

function defaultDb(): Db {
  return admin.firestore();
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function caseRef(db: Db, caseId: string) {
  return db.collection(CHILDCARE_INCIDENTS_COLLECTION).doc(caseId);
}

// ── Deterministic case ids (AE24) ─────────────────────────────────────────────

/** ONE case per marker: same phone + marker timestamp always converge. */
export function incidentCaseIdFromMarker(phone: string, markerAtIso: string): string {
  const sha = createHash("sha1").update(`childcare-incident-marker:${phone}:${markerAtIso}`).digest("hex");
  return `cinc_${sha}`;
}

/** Direct reports converge per (reporter, idempotencyKey). */
export function incidentCaseIdFromReport(reporterUid: string, idempotencyKey: string): string {
  const sha = createHash("sha1").update(`childcare-incident-report:${reporterUid}:${idempotencyKey}`).digest("hex");
  return `cinc_${sha}`;
}

// ── Case creation ─────────────────────────────────────────────────────────────

const MAX_ID = 128;
const MAX_SUMMARY = 2000;

function cleanId(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v || v.length > MAX_ID) return null;
  return v;
}

async function createCaseOnce(
  db: Db,
  doc: ChildcareIncidentCaseDoc,
): Promise<{ caseDoc: ChildcareIncidentCaseDoc; created: boolean }> {
  const ref = caseRef(db, doc.caseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      // AE24: duplicate marker / duplicate report submit → the ONE existing case.
      return { caseDoc: (snap.data() ?? {}) as ChildcareIncidentCaseDoc, created: false };
    }
    tx.set(ref, doc);
    return { caseDoc: doc, created: true };
  });
}

/**
 * System path: create the restricted case from U10's typed marker on the
 * agent session (childcareIncidentMarker/childcareIncidentAt written by
 * incidentSignal.escalateChildcareIncident). Deduped on the marker (AE24).
 */
export async function createIncidentCaseFromMarker(
  params: { phone: string; actorUid?: string | null },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ caseDoc: ChildcareIncidentCaseDoc; created: boolean }> {
  const db = opts.db ?? defaultDb();
  const phone = cleanId(params.phone);
  if (!phone) throw new ChildcareIncidentError("invalid_input");

  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  const session = (sessionSnap.data() ?? {}) as Record<string, unknown>;
  const category = session.childcareIncidentMarker;
  const markerAt = session.childcareIncidentAt;
  if (
    !sessionSnap.exists ||
    typeof category !== "string" ||
    !CHILDCARE_INCIDENT_CATEGORIES.includes(category as ChildcareIncidentCategory) ||
    typeof markerAt !== "string" ||
    !markerAt
  ) {
    throw new ChildcareIncidentError("marker_not_found");
  }

  const ts = nowIso(opts.now);
  const caseId = incidentCaseIdFromMarker(phone, markerAt);
  const doc: ChildcareIncidentCaseDoc = {
    caseId,
    careVertical: "child",
    category,
    source: "marker",
    markerKey: `${phone}:${markerAt}`,
    reporterUid: params.actorUid ?? null,
    status: "open",
    ownerUid: null,
    summary: null,
    subject: {
      bookingId: null,
      sessionPhone: phone,
      householdId: null,
    },
    evidenceRefs: [
      { kind: "session", ref: phone, addedByUid: params.actorUid ?? "system", addedAt: ts },
    ],
    suspectedPartyUids: [],
    payoutHolds: [],
    litigationHolds: [],
    transitions: [],
    createdAt: ts,
    updatedAt: ts,
  };

  const result = await createCaseOnce(db, doc);
  if (result.created) {
    await logAudit({
      eventType: "childcare_incident_case_created",
      userId: params.actorUid ?? "system",
      data: { caseId, category, source: "marker" },
    }).catch(() => {});
  }
  return result;
}

/** Operator/direct-report path (idempotent per reporter + key). */
export async function createIncidentCaseFromReport(
  params: {
    category: string;
    reporterUid: string;
    idempotencyKey: string;
    bookingId?: string | null;
    sessionPhone?: string | null;
    householdId?: string | null;
    summary?: string | null;
  },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ caseDoc: ChildcareIncidentCaseDoc; created: boolean }> {
  const db = opts.db ?? defaultDb();
  const reporterUid = cleanId(params.reporterUid);
  const idempotencyKey = cleanId(params.idempotencyKey);
  if (!reporterUid || !idempotencyKey || !isChildcareIncidentCategory(params.category)) {
    throw new ChildcareIncidentError("invalid_input");
  }
  const bookingId = params.bookingId == null ? null : cleanId(params.bookingId);
  const sessionPhone = params.sessionPhone == null ? null : cleanId(params.sessionPhone);
  const householdId = params.householdId == null ? null : cleanId(params.householdId);
  // A PROVIDED-but-invalid (empty/oversized) id is invalid input — never
  // silently dropped.
  if (
    (params.bookingId != null && bookingId === null) ||
    (params.sessionPhone != null && sessionPhone === null) ||
    (params.householdId != null && householdId === null)
  ) {
    throw new ChildcareIncidentError("invalid_input");
  }
  const summary =
    params.summary == null ? null : String(params.summary).trim().slice(0, MAX_SUMMARY) || null;

  const ts = nowIso(opts.now);
  const caseId = incidentCaseIdFromReport(reporterUid, idempotencyKey);
  const doc: ChildcareIncidentCaseDoc = {
    caseId,
    careVertical: "child",
    category: params.category,
    source: "operator_report",
    markerKey: null,
    reporterUid,
    status: "open",
    ownerUid: null,
    summary,
    subject: { bookingId, sessionPhone, householdId },
    evidenceRefs: bookingId
      ? [{ kind: "booking", ref: bookingId, addedByUid: reporterUid, addedAt: ts }]
      : [],
    suspectedPartyUids: [],
    payoutHolds: [],
    litigationHolds: [],
    transitions: [],
    createdAt: ts,
    updatedAt: ts,
  };

  const result = await createCaseOnce(db, doc);
  if (result.created) {
    await logAudit({
      eventType: "childcare_incident_case_created",
      userId: reporterUid,
      data: { caseId, category: params.category, source: "operator_report" },
    }).catch(() => {});
  }
  return result;
}

// ── Case mutations (every one audited; immutable in-doc history) ──────────────

/** Minimal structural transaction type — works with real + fake Firestores. */
interface TxLike {
  get(ref: unknown): Promise<{ exists: boolean; data(): unknown }>;
  set(ref: unknown, data: unknown): void;
  update(ref: unknown, data: unknown): void;
}

async function loadCaseInTx(tx: TxLike, db: Db, caseId: string): Promise<ChildcareIncidentCaseDoc> {
  const snap = await tx.get(caseRef(db, caseId));
  if (!snap.exists) throw new ChildcareIncidentError("case_not_found");
  return (snap.data() ?? {}) as ChildcareIncidentCaseDoc;
}

export async function assignIncidentOwner(
  params: { caseId: string; ownerUid: string; actorUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareIncidentCaseDoc> {
  const db = opts.db ?? defaultDb();
  const caseId = cleanId(params.caseId);
  const ownerUid = cleanId(params.ownerUid);
  if (!caseId || !ownerUid) throw new ChildcareIncidentError("invalid_input");
  const ts = nowIso(opts.now);

  const updated = await db.runTransaction(async (tx) => {
    const doc = await loadCaseInTx(tx, db, caseId);
    const next: ChildcareIncidentCaseDoc = { ...doc, ownerUid, updatedAt: ts };
    tx.set(caseRef(db, caseId), next);
    return next;
  });

  await logAudit({
    eventType: "childcare_incident_assigned",
    userId: params.actorUid,
    data: { caseId, ownerUid },
  }).catch(() => {});
  return updated;
}

export async function transitionIncidentStatus(
  params: {
    caseId: string;
    to: ChildcareIncidentStatus;
    actorUid: string;
    note?: string | null;
  },
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareIncidentCaseDoc> {
  const db = opts.db ?? defaultDb();
  const caseId = cleanId(params.caseId);
  if (!caseId || !Object.prototype.hasOwnProperty.call(CHILDCARE_INCIDENT_STATUS_TRANSITIONS, params.to)) {
    throw new ChildcareIncidentError("invalid_input");
  }
  const ts = nowIso(opts.now);
  const note = params.note == null ? null : String(params.note).trim().slice(0, 500) || null;

  const updated = await db.runTransaction(async (tx) => {
    const doc = await loadCaseInTx(tx, db, caseId);
    if (!isValidIncidentTransition(doc.status, params.to)) {
      throw new ChildcareIncidentError(
        "invalid_transition",
        `Cannot move a ${doc.status} case to ${params.to}.`,
      );
    }
    const entry: IncidentTransitionEntry = {
      from: doc.status,
      to: params.to,
      byUid: params.actorUid,
      at: ts,
      note,
    };
    const next: ChildcareIncidentCaseDoc = {
      ...doc,
      status: params.to,
      transitions: [...(doc.transitions ?? []), entry], // append-only history
      updatedAt: ts,
    };
    tx.set(caseRef(db, caseId), next);
    return next;
  });

  await logAudit({
    eventType: "childcare_incident_status_changed",
    userId: params.actorUid,
    data: { caseId, from: updated.transitions[updated.transitions.length - 1]?.from, to: params.to },
  }).catch(() => {});
  return updated;
}

export async function addIncidentEvidence(
  params: { caseId: string; kind: string; ref: string; actorUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareIncidentCaseDoc> {
  const db = opts.db ?? defaultDb();
  const caseId = cleanId(params.caseId);
  const ref = typeof params.ref === "string" ? params.ref.trim() : "";
  if (
    !caseId ||
    !ref ||
    ref.length > 256 ||
    !(INCIDENT_EVIDENCE_KINDS as readonly string[]).includes(params.kind)
  ) {
    // Evidence is a REFERENCE (opaque id/path string) — anything else (an
    // object payload, an oversized blob) is rejected: never copies (R57).
    throw new ChildcareIncidentError("invalid_input");
  }
  const ts = nowIso(opts.now);

  const updated = await db.runTransaction(async (tx) => {
    const doc = await loadCaseInTx(tx, db, caseId);
    const exists = (doc.evidenceRefs ?? []).some((e) => e.kind === params.kind && e.ref === ref);
    if (exists) return doc; // idempotent
    const next: ChildcareIncidentCaseDoc = {
      ...doc,
      evidenceRefs: [
        ...(doc.evidenceRefs ?? []),
        { kind: params.kind as IncidentEvidenceKind, ref, addedByUid: params.actorUid, addedAt: ts },
      ],
      updatedAt: ts,
    };
    tx.set(caseRef(db, caseId), next);
    return next;
  });

  await logAudit({
    eventType: "childcare_incident_evidence_added",
    userId: params.actorUid,
    data: { caseId, kind: params.kind }, // ref deliberately NOT logged (R57)
  }).catch(() => {});
  return updated;
}

/**
 * Suspected-party exclusion (AE24): records the suspect on the case AND unions
 * their uid into the booking's `excludedUids` set — the field U9's every
 * childcare notification fan-out consults
 * (conversationPolicy.filterExcludedNotificationRecipients). Fail-closed on a
 * non-childcare booking: senior bookings never grow this field.
 */
export async function excludeSuspectedParty(
  params: { caseId: string; suspectUid: string; bookingId?: string | null; actorUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareIncidentCaseDoc> {
  const db = opts.db ?? defaultDb();
  const caseId = cleanId(params.caseId);
  const suspectUid = cleanId(params.suspectUid);
  if (!caseId || !suspectUid) throw new ChildcareIncidentError("invalid_input");
  const bookingId = params.bookingId == null ? null : cleanId(params.bookingId);
  if (params.bookingId != null && bookingId === null) {
    throw new ChildcareIncidentError("invalid_input");
  }
  const ts = nowIso(opts.now);

  const updated = await db.runTransaction(async (rawTx) => {
    const tx = rawTx as unknown as TxLike;
    const doc = await loadCaseInTx(tx, db, caseId);

    // Booking-side exclusion (U9 seam) — read + write inside the same tx.
    const targetBookingId = bookingId ?? doc.subject?.bookingId ?? null;
    if (targetBookingId) {
      const bookingRef = db.collection("booking_requests").doc(targetBookingId);
      const bookingSnap = await tx.get(bookingRef);
      const booking = (bookingSnap.data() ?? {}) as { careVertical?: unknown; excludedUids?: unknown };
      if (bookingSnap.exists && booking.careVertical === "child") {
        const current = Array.isArray(booking.excludedUids)
          ? booking.excludedUids.map((u) => String(u ?? "").trim()).filter(Boolean)
          : [];
        if (!current.includes(suspectUid)) {
          tx.update(bookingRef, {
            excludedUids: [...current, suspectUid],
            updatedAt: ts,
          });
        }
      }
    }

    const suspects = Array.isArray(doc.suspectedPartyUids) ? doc.suspectedPartyUids : [];
    const next: ChildcareIncidentCaseDoc = {
      ...doc,
      suspectedPartyUids: suspects.includes(suspectUid) ? suspects : [...suspects, suspectUid],
      updatedAt: ts,
    };
    tx.set(caseRef(db, caseId), next);
    return next;
  });

  await logAudit({
    eventType: "childcare_incident_party_excluded",
    userId: params.actorUid,
    data: { caseId, suspectUid, bookingId: bookingId ?? updated.subject?.bookingId ?? null },
  }).catch(() => {});
  return updated;
}

/**
 * Booking/payout hold via U8's rail (holdChildcareShiftPayout — refuses to
 * charge/transfer a held row; already-paid-out escalates to admins). Lazy
 * import keeps the payments module graph out of this policy module's tests.
 */
export async function applyIncidentPayoutHold(
  params: { caseId: string; appointmentId: string; actorUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ caseDoc: ChildcareIncidentCaseDoc; held: boolean; alreadyPaidOut: boolean }> {
  const db = opts.db ?? defaultDb();
  const caseId = cleanId(params.caseId);
  const appointmentId = cleanId(params.appointmentId);
  if (!caseId || !appointmentId) throw new ChildcareIncidentError("invalid_input");
  const ts = nowIso(opts.now);

  const { holdChildcareShiftPayout } = await import("./shiftPayments");
  const hold = await holdChildcareShiftPayout(appointmentId, `incident:${caseId}`, {
    db: db as never,
    now: opts.now,
  });

  const caseDoc = await db.runTransaction(async (tx) => {
    const doc = await loadCaseInTx(tx, db, caseId);
    const holds = Array.isArray(doc.payoutHolds) ? doc.payoutHolds : [];
    const next: ChildcareIncidentCaseDoc = {
      ...doc,
      payoutHolds: [
        ...holds,
        { appointmentId, heldAt: ts, alreadyPaidOut: hold.alreadyPaidOut },
      ],
      updatedAt: ts,
    };
    tx.set(caseRef(db, caseId), next);
    return next;
  });

  await logAudit({
    eventType: "childcare_incident_payout_hold",
    userId: params.actorUid,
    data: { caseId, appointmentId, held: hold.held, alreadyPaidOut: hold.alreadyPaidOut },
  }).catch(() => {});
  return { caseDoc, held: hold.held, alreadyPaidOut: hold.alreadyPaidOut };
}

/**
 * Litigation/evidence hold via U3's child legal hold — while active, the
 * lifecycle state machine refuses delete/redact for the child (dataLifecycle
 * createLifecycleRequest + firestore_delete both check legalHold.active).
 */
export async function setIncidentLitigationHold(
  params: { caseId: string; childId: string; active: boolean; actorUid: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareIncidentCaseDoc> {
  const db = opts.db ?? defaultDb();
  const caseId = cleanId(params.caseId);
  const childId = cleanId(params.childId);
  if (!caseId || !childId) throw new ChildcareIncidentError("invalid_input");
  const ts = nowIso(opts.now);

  const { setChildLegalHold } = await import("../data/childProfileRepository");
  await setChildLegalHold(
    childId,
    params.active
      ? { active: true, reason: `childcare_incident:${caseId}`, placedByUid: params.actorUid }
      : null,
    { db: db as never, now: opts.now },
  );

  const caseDoc = await db.runTransaction(async (tx) => {
    const doc = await loadCaseInTx(tx, db, caseId);
    const holds = Array.isArray(doc.litigationHolds) ? doc.litigationHolds : [];
    const next: ChildcareIncidentCaseDoc = {
      ...doc,
      litigationHolds: [...holds, { childId, active: params.active, changedAt: ts }],
      updatedAt: ts,
    };
    tx.set(caseRef(db, caseId), next);
    return next;
  });

  await logAudit({
    eventType: "childcare_incident_litigation_hold",
    userId: params.actorUid,
    data: { caseId, childId, active: params.active },
  }).catch(() => {});
  return caseDoc;
}

// ── Sanitized projections (AE18/R57) ─────────────────────────────────────────

/**
 * The EXACT keys a queue row exposes (pinned by tests): category / status /
 * timestamps / ownership + counts. NO child details, NO phone, NO booking id,
 * NO summary — those are detail-callable content (childSafetyOperator +
 * reason).
 */
export const CHILDCARE_INCIDENT_QUEUE_ROW_KEYS = [
  "caseId",
  "category",
  "status",
  "source",
  "ownerUid",
  "createdAt",
  "updatedAt",
  "evidenceCount",
  "suspectedPartyCount",
  "hasPayoutHold",
  "hasLitigationHold",
] as const;

export interface ChildcareIncidentQueueRow {
  caseId: string;
  category: string;
  status: ChildcareIncidentStatus;
  source: string;
  ownerUid: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceCount: number;
  suspectedPartyCount: number;
  hasPayoutHold: boolean;
  hasLitigationHold: boolean;
}

export function sanitizeIncidentQueueRow(doc: ChildcareIncidentCaseDoc): ChildcareIncidentQueueRow {
  const row: ChildcareIncidentQueueRow = {
    caseId: String(doc.caseId ?? ""),
    category: String(doc.category ?? ""),
    status: (doc.status ?? "open") as ChildcareIncidentStatus,
    source: String(doc.source ?? ""),
    ownerUid: doc.ownerUid ?? null,
    createdAt: String(doc.createdAt ?? ""),
    updatedAt: String(doc.updatedAt ?? ""),
    evidenceCount: Array.isArray(doc.evidenceRefs) ? doc.evidenceRefs.length : 0,
    suspectedPartyCount: Array.isArray(doc.suspectedPartyUids) ? doc.suspectedPartyUids.length : 0,
    hasPayoutHold: Array.isArray(doc.payoutHolds) && doc.payoutHolds.length > 0,
    hasLitigationHold:
      Array.isArray(doc.litigationHolds) && doc.litigationHolds.some((h) => h.active),
  };
  // Structural guard (reviewCallables idiom): a new field must be added to the
  // pinned key set deliberately — it would ship into the operator queue.
  for (const key of Object.keys(row)) {
    if (!(CHILDCARE_INCIDENT_QUEUE_ROW_KEYS as readonly string[]).includes(key)) {
      throw new ChildcareIncidentError("invalid_input", "queue row contract violation");
    }
  }
  return row;
}

/** Detail view (childSafetyOperator + reason surface) — the full case record. */
export function sanitizeIncidentDetail(doc: ChildcareIncidentCaseDoc): ChildcareIncidentCaseDoc {
  return {
    caseId: String(doc.caseId ?? ""),
    careVertical: "child",
    category: String(doc.category ?? ""),
    source: (doc.source ?? "operator_report") as ChildcareIncidentCaseDoc["source"],
    markerKey: doc.markerKey ?? null,
    reporterUid: doc.reporterUid ?? null,
    status: (doc.status ?? "open") as ChildcareIncidentStatus,
    ownerUid: doc.ownerUid ?? null,
    summary: doc.summary ?? null,
    subject: {
      bookingId: doc.subject?.bookingId ?? null,
      sessionPhone: doc.subject?.sessionPhone ?? null,
      householdId: doc.subject?.householdId ?? null,
    },
    evidenceRefs: Array.isArray(doc.evidenceRefs) ? doc.evidenceRefs : [],
    suspectedPartyUids: Array.isArray(doc.suspectedPartyUids) ? doc.suspectedPartyUids : [],
    payoutHolds: Array.isArray(doc.payoutHolds) ? doc.payoutHolds : [],
    litigationHolds: Array.isArray(doc.litigationHolds) ? doc.litigationHolds : [],
    transitions: Array.isArray(doc.transitions) ? doc.transitions : [],
    createdAt: String(doc.createdAt ?? ""),
    updatedAt: String(doc.updatedAt ?? ""),
  };
}

// ── Queue read (single-equality query — no composite index required) ─────────

export async function listIncidentCases(
  params: { status?: ChildcareIncidentStatus | null; limit?: number } = {},
  opts: { db?: Db } = {},
): Promise<ChildcareIncidentQueueRow[]> {
  const db = opts.db ?? defaultDb();
  const max = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);

  // Deliberately a SINGLE-equality filter with in-memory ordering: incident
  // volume is operator-scale, and this keeps the collection out of the
  // composite-index surface entirely (no new firestore.indexes.json entry).
  interface QueryLike {
    where(field: string, op: string, value: unknown): QueryLike;
    get(): Promise<{ docs: Array<{ data(): unknown }> }>;
  }
  let query = db.collection(CHILDCARE_INCIDENTS_COLLECTION) as unknown as QueryLike;
  if (params.status) {
    query = query.where("status", "==", params.status);
  }
  const snap = await query.get();
  const rows = snap.docs
    .map((d) => sanitizeIncidentQueueRow((d.data() ?? {}) as ChildcareIncidentCaseDoc))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return rows.slice(0, max);
}

export async function getIncidentCase(
  caseId: string,
  opts: { db?: Db } = {},
): Promise<ChildcareIncidentCaseDoc> {
  const db = opts.db ?? defaultDb();
  const id = cleanId(caseId);
  if (!id) throw new ChildcareIncidentError("invalid_input");
  const snap = await caseRef(db, id).get();
  if (!snap.exists) throw new ChildcareIncidentError("case_not_found");
  return sanitizeIncidentDetail((snap.data() ?? {}) as ChildcareIncidentCaseDoc);
}
