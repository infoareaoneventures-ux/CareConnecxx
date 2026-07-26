// Runtime-enforced confirmation gate for irreversible tool calls.
//
// Today Evia is *told* in the system prompt to confirm before
// cancel_appointment, delete_reminder, etc. — but if she forgets or is
// prompt-injected, the action fires immediately. One bad incident in
// eldercare is irrecoverable, so we enforce confirmation in the runtime.
//
// Flow:
//   1. Claude calls a high-risk tool inside the qa loop.
//   2. MCP dispatcher routes through this module instead of executing.
//   3. proposePendingAction() writes a Firestore doc with the tool name,
//      args, and a 15-min TTL, and returns a structured stub for Claude.
//   4. Claude reads the stub, generates a confirmation message to the family.
//   5. Family replies. approvalHandler classifies YES / NO / QUESTION.
//   6. On YES, the MCP gate re-runs the tool with _confirmedActionId set,
//      which bypasses this gate and executes normally.
//   7. On NO, the action is marked rejected.
//   8. On timeout / 15-min expiry, the action is unusable; a subsequent YES
//      from the family won't re-trigger anything.

import * as admin from "firebase-admin";
import { createHash } from "crypto";

const db = admin.firestore();

export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface PendingChildAuthorityBinding {
  childId: string;
  scope: "cancellation";
  accessVersion: number;
}

export interface PendingOperationIdentity {
  schema: "pending-operation-v1";
  operationId: string;
  principalId: string;
  careVertical: "senior" | "child";
  objectType: string;
  objectId: string;
  actionName: string;
  actionSchemaVersion: 1;
  sourceTurnKey: string;
  expiresAt: string;
}

export interface PendingAction {
  id:           string;
  phone:        string;
  userId?:      string;
  toolName:     string;
  toolInput:    Record<string, unknown>;
  preview:      string;
  proposedAt:   string; // ISO
  expiresAt:    string; // ISO — proposedAt + TTL
  status:       "awaiting" | "approved" | "executing" | "rejected" | "expired" | "executed" | "failed";
  resolvedAt?:  string;
  // Truncated executed-result preview for debugging; not the full payload.
  executionPreview?: string;
  // ── Healthcare approver routing (H-U4) ──────────────────────────────────────
  // For healthcare write actions the doc's `phone` field is set to the account
  // holder's phone (approverPhone) so getAllPending(senderPhone) matches when the
  // ACCOUNT HOLDER replies — the fix for the cross-phone bug. triggeredByPhone is
  // the requester (a secondary member may have started it) for the completion notice.
  approverPhone?:    string;
  triggeredByPhone?: string;
  // ── Exactly-once (H-U5) ─────────────────────────────────────────────────────
  // Set when the action is claimed (awaiting → executing) just before dispatch.
  executingStartedAt?: string;
  /** New actions are partitioned by vertical; legacy rows without this field are senior. */
  careVertical?: "senior" | "child";
  childcareBookingId?: string;
  childAuthorityBindings?: PendingChildAuthorityBinding[];
  operation?: PendingOperationIdentity;
  terminalEvidence?: {
    operationId: string;
    status: "executed" | "failed";
    safeClaimCode?: string;
    evidenceStatus?: string;
    targetRef?: string;
    settledAt: string;
  };
}

// Set of tool names that ALWAYS require confirmation regardless of args.
// Mirrors the qaAgent.ts system-prompt list. Adding a tool here is a
// production-safety change; review the prompt's confirmation guidance too.
const ALWAYS_CONFIRM = new Set<string>([
  "cancel_appointment",
  "delete_reminder",
  "remove_family_member",
  "cancel_subscription",
  "restore_care_plan_version",
  "block_user",
  "report_user",
  "cancel_job_post",
  // U9: financial commit via the agent loop — a refund moves money and must be
  // family-confirmed. (The cascade refundHandler has its own confirm step and does
  // not route through this gate.)
  "create_refund_request",
  // U7: destructive CRUD — deleting a review or hiding a care-journal entry is
  // family-visible and not casually reversible, so require explicit confirmation.
  "delete_review",
  "delete_care_journal_entry",
  // CRUD-completeness tools (2026-07-03): archiving a senior ends active care
  // visibility, and deleting a memory file destroys content + its search index.
  "archive_senior_profile",
  "delete_memory_file",
  // Childcare U10 (R51/R52): cancelling a childcare booking revokes provider
  // safety/conversation access and triggers the cancellation-fee policy —
  // always round-trip an explicit family YES.
  "cancel_childcare_booking",
]);

// Care-plan fields that are harmless note-like additions — free-text context
// the caregiver reads, not data that drives clinical decisions. Everything
// else on the care plan (medications, careNeeds, doctorContacts,
// specialInstructions — and any future/unknown field, fail-safe) is clinical
// and MUST round-trip an explicit family confirmation before it changes.
const CARE_PLAN_NOTE_FIELDS = new Set(["notes", "dietaryNotes"]);

// Tools whose risk depends on an argument value. The predicate inspects the
// input and returns true when this specific call is irreversible.
const CONDITIONAL_CONFIRM: Record<string, (input: Record<string, unknown>) => boolean> = {
  // Only cancel — pause and resume are reversible.
  manage_recurring_schedule: (input) => input.action === "cancel",
  // Rejecting an applicant is irreversible (caregiver sees the decline).
  // Accept is also high-stakes but happens via a separate hire flow.
  respond_to_job_application: (input) => input.decision === "reject",
  // Clinical care-plan edits (medications, careNeeds, etc.) require
  // confirmation — a wrong medication entry is a patient-safety incident.
  // Note-like fields skip the gate so "add a note that mom prefers tea"
  // doesn't need a confirmation round-trip.
  update_care_plan: (input) => !CARE_PLAN_NOTE_FIELDS.has(String(input.field)),
  // U9: approving a timesheet via the agent loop releases payment to the caregiver
  // — gate the approve path. Disputing is reversible (goes to admin review) and
  // stays ungated.
  review_shift_hours: (input) => input.action === "approve" || input.decision === "approve",
  // Real-world healthcare browser actions: booking an appointment or requesting
  // a refill submits on a third-party portal and is irreversible — gate it.
  // Appointment booking is two-pass (H-U3): the FIRST call (no chosenSlot) is
  // read-only discovery and stays ungated; only the COMMIT call (carrying the
  // approved chosenSlot) is gated. Refill is single-pass → always gated.
  // insurance_check is read-only (account-holder-scoped, KTD-8) → NOT gated.
  perform_web_action: (input) =>
    input.loginAction === "pharmacy_refill" ||
    (input.loginAction === "schedule_appointment" && !!input.chosenSlot),
};

export function isHighRisk(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (ALWAYS_CONFIRM.has(toolName)) return true;
  const pred = CONDITIONAL_CONFIRM[toolName];
  return pred ? pred(toolInput) : false;
}

// Build a short human-readable preview of the action so support / debugging
// can see what was proposed without parsing the raw input JSON. Falls back
// to a generic summary when no special-cased shape applies.
export function buildActionPreview(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "cancel_appointment":
      return `Cancel appointment ${String(toolInput.appointmentId ?? "?")}`;
    case "delete_reminder":
      return `Delete reminder ${String(toolInput.reminderId ?? "?")}`;
    case "remove_family_member":
      return `Remove family member ${String(toolInput.memberPhone ?? toolInput.memberId ?? "?")}`;
    case "cancel_subscription":
      return `Cancel Evia subscription`;
    case "restore_care_plan_version":
      return `Restore care plan to version ${String(toolInput.versionId ?? "?")}`;
    case "block_user":
      return `Block user ${String(toolInput.targetUserId ?? toolInput.targetPhone ?? "?")}`;
    case "report_user":
      return `Report user ${String(toolInput.targetUserId ?? toolInput.targetPhone ?? "?")}`;
    case "cancel_job_post":
      return `Cancel job post ${String(toolInput.jobId ?? "?")}`;
    case "manage_recurring_schedule":
      return `${String(toolInput.action ?? "modify")} recurring schedule ${String(toolInput.scheduleId ?? "")}`.trim();
    case "respond_to_job_application":
      return `${String(toolInput.decision ?? "respond to")} application ${String(toolInput.applicationId ?? "")}`.trim();
    case "update_care_plan":
      return `${String(toolInput.action ?? "set")} care plan ${String(toolInput.field ?? "?")}`;
    case "create_refund_request": {
      // U9: surface the amount + target so the family approves the specific refund.
      const amt = toolInput.amount != null ? `$${toolInput.amount}` : "a refund";
      const forWhat = toolInput.invoiceId ? ` for invoice ${toolInput.invoiceId}`
        : toolInput.visitId ? ` for visit ${toolInput.visitId}` : "";
      return `Request ${amt}${forWhat}`;
    }
    case "review_shift_hours": {
      // U9: name the hours/amount/caregiver so an approval isn't a blind "approve".
      const decision = String(toolInput.action ?? toolInput.decision ?? "review");
      const hours    = toolInput.hours != null ? `${toolInput.hours}h` : "submitted hours";
      const who      = toolInput.caregiverName ? ` for ${toolInput.caregiverName}` : "";
      const amt      = toolInput.amount != null ? ` ($${toolInput.amount})` : "";
      return `${decision} ${hours}${amt}${who}`;
    }
    case "perform_web_action": {
      // Real-world healthcare actions — state the EXACT thing being approved (R2).
      if (toolInput.loginAction === "schedule_appointment") {
        const slot = (toolInput.chosenSlot ?? {}) as { provider?: string; datetime?: string; location?: string };
        const provider = slot.provider ?? (toolInput.doctorName as string | undefined) ?? "your doctor";
        const when     = slot.datetime ? ` on ${slot.datetime}` : "";
        const where    = slot.location ? ` at ${slot.location}` : "";
        return `Book appointment with ${provider}${when}${where}`;
      }
      if (toolInput.loginAction === "pharmacy_refill") {
        const med      = (toolInput.medicationName as string | undefined) ?? (toolInput.rxNumber ? `Rx ${toolInput.rxNumber}` : "your prescription");
        const pharmacy = (toolInput.pharmacyService as string | undefined) ?? "your pharmacy";
        return `Request refill of ${med} at ${pharmacy}`;
      }
      return `${String(toolInput.loginAction ?? "perform")} web action`;
    }
    default:
      return `${toolName} (irreversible)`;
  }
}

// Write a new pending action and return the doc. The id is generated by
// Firestore; callers use it to bypass the gate on the approval re-run.
function isHealthcareWriteAction(toolName: string, toolInput: Record<string, unknown>): boolean {
  return toolName === "perform_web_action" &&
    (toolInput.loginAction === "schedule_appointment" || toolInput.loginAction === "pharmacy_refill");
}

function resolveOperationObject(
  toolName: string,
  input: Record<string, unknown>,
): { type: string; id: string } {
  const candidates: Array<[string, string]> = [
    ["childcare_booking", String(input.bookingId ?? "")],
    ["appointment", String(input.appointmentId ?? "")],
    ["reminder", String(input.reminderId ?? "")],
    ["subscription", String(input.subscriptionId ?? input.userId ?? "")],
    ["review", String(input.reviewId ?? "")],
    ["job", String(input.jobId ?? "")],
    ["shift", String(input.shiftId ?? "")],
    ["user", String(input.targetUserId ?? input.memberId ?? "")],
  ];
  const match = candidates.find(([, id]) => id.trim().length > 0);
  return match
    ? { type: match[0], id: match[1].trim() }
    : { type: "account", id: toolName };
}

export async function proposePendingAction(params: {
  phone:     string;
  userId?:   string;
  toolName:  string;
  toolInput: Record<string, unknown>;
  careVertical?: "senior" | "child";
  sourceTurnKey?: string;
}): Promise<PendingAction> {
  const now = Date.now();
  const expiresAt = new Date(now + PENDING_ACTION_TTL_MS).toISOString();
  const careVertical = params.careVertical === "child" ? "child" : "senior";

  // Healthcare write actions must be approved by the ACCOUNT HOLDER, not whoever
  // triggered them (H-U4). Key the doc under the approver's phone so their YES
  // matches getAllPending(approverPhone) — the cross-phone fix. Fail CLOSED if we
  // can't resolve the account holder (never fall back to the triggering phone).
  let approverPhone:    string | undefined;
  let triggeredByPhone: string | undefined;
  let docPhone = params.phone;
  if (isHealthcareWriteAction(params.toolName, params.toolInput)) {
    if (!params.userId) {
      throw new Error("pendingActions: healthcare action requires a userId to resolve the account holder");
    }
    const { resolvePrimaryPhone } = await import("./familyGroupManager");
    approverPhone = await resolvePrimaryPhone(params.userId);
    if (!approverPhone) {
      throw new Error("pendingActions: could not resolve account-holder phone — refusing to propose");
    }
    triggeredByPhone = params.phone;
    docPhone = approverPhone;
  }

  let childBinding:
    | {
        careVertical: "child";
        childcareBookingId: string;
        childAuthorityBindings: PendingChildAuthorityBinding[];
      }
    | undefined;
  if (params.toolName === "cancel_childcare_booking") {
    if (careVertical !== "child") {
      throw new Error("pendingActions: childcare action proposed outside the child vertical");
    }
    const bookingId = String(params.toolInput.bookingId ?? "").trim();
    if (!params.userId || !bookingId) {
      throw new Error("pendingActions: childcare cancellation requires userId and bookingId");
    }
    const bookingSnap = await db.collection("booking_requests").doc(bookingId).get();
    const booking = bookingSnap.data() ?? {};
    const childIds = Array.isArray(booking.childIds)
      ? booking.childIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : [];
    if (
      !bookingSnap.exists ||
      booking.careVertical !== "child" ||
      booking.clientId !== params.userId ||
      childIds.length === 0
    ) {
      throw new Error("pendingActions: childcare booking is not authorized for this user");
    }
    const bindings: PendingChildAuthorityBinding[] = [];
    for (const childId of childIds) {
      const authoritySnap = await db
        .collection("guardian_authorities")
        .doc(`${childId}__${params.userId}`)
        .get();
      const authority = authoritySnap.data() ?? {};
      if (
        !authoritySnap.exists ||
        authority.state !== "active" ||
        !Array.isArray(authority.scopes) ||
        !authority.scopes.includes("cancellation") ||
        !Number.isFinite(Number(authority.accessVersion))
      ) {
        throw new Error("pendingActions: childcare authority denied");
      }
      bindings.push({
        childId,
        scope: "cancellation",
        accessVersion: Number(authority.accessVersion),
      });
    }
    childBinding = {
      careVertical: "child",
      childcareBookingId: bookingId,
      childAuthorityBindings: bindings,
    };
  }

  const object = resolveOperationObject(params.toolName, params.toolInput);
  const principalId = String(params.userId ?? params.phone).trim();
  const sourceTurnKey = String(
    params.sourceTurnKey ??
      `direct:${createHash("sha256")
        .update(`${params.phone}|${params.toolName}|${JSON.stringify(params.toolInput)}`)
        .digest("hex")
        .slice(0, 24)}`,
  ).trim();
  if (!principalId) throw new Error("pendingActions: immutable principal is required");
  const operationSeed = [
    "pending-operation-v1",
    principalId,
    careVertical,
    object.type,
    object.id,
    params.toolName,
    sourceTurnKey,
    expiresAt,
  ].join("|");
  const operation: PendingOperationIdentity = {
    schema: "pending-operation-v1",
    operationId: `op_${createHash("sha256").update(operationSeed).digest("hex").slice(0, 40)}`,
    principalId,
    careVertical,
    objectType: object.type,
    objectId: object.id,
    actionName: params.toolName,
    actionSchemaVersion: 1,
    sourceTurnKey,
    expiresAt,
  };

  const action: Omit<PendingAction, "id"> = {
    phone:      docPhone,
    userId:     params.userId,
    toolName:   params.toolName,
    toolInput:  params.toolInput,
    preview:    buildActionPreview(params.toolName, params.toolInput),
    proposedAt: new Date(now).toISOString(),
    expiresAt,
    status:     "awaiting",
    ...(approverPhone ? { approverPhone } : {}),
    ...(triggeredByPhone ? { triggeredByPhone } : {}),
    ...(childBinding ?? {}),
    careVertical,
    operation,
  };
  const ref = await db.collection("pending_actions").add(action);
  const created = { id: ref.id, ...action };

  // Audit: proposed (H-U8) — PHI-minimized (no provider/medication names).
  // Awaited so the audit write isn't dropped when the Cloud Function returns.
  await logHealthcareAudit(created, "proposed");
  return created;
}

// Claim an action for execution (awaiting → executing) in a transaction, so a
// duplicate YES / retry can't double-dispatch (H-U5). Returns "claimed" only for
// the first caller; later callers see executing/executed/expired and get
// "not_claimable" (no second dispatch).
export async function claimPendingAction(id: string): Promise<"claimed" | "not_claimable"> {
  const ref = db.collection("pending_actions").doc(id);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return "not_claimable";
      const data = snap.data() as PendingAction;
      if (data.status !== "awaiting") return "not_claimable";
      if (new Date(data.expiresAt).getTime() < Date.now()) return "not_claimable";
      if (data.careVertical === "child") {
        const bookingId = String(data.childcareBookingId ?? "").trim();
        const bindings = data.childAuthorityBindings ?? [];
        if (!bookingId || !data.userId || bindings.length === 0) return "not_claimable";
        if (
          !data.operation ||
          data.operation.schema !== "pending-operation-v1" ||
          data.operation.operationId.length < 10 ||
          data.operation.principalId !== data.userId ||
          data.operation.careVertical !== "child" ||
          data.operation.actionName !== data.toolName ||
          data.operation.objectId !== bookingId ||
          data.operation.expiresAt !== data.expiresAt
        ) {
          return "not_claimable";
        }
        const flagsSnap = await tx.get(db.collection("childcare_flags").doc("global"));
        const flags = flagsSnap.data() ?? {};
        if (
          !flagsSnap.exists ||
          flags.CHILDCARE_ENABLED !== true ||
          flags.CHILDCARE_WRITES_ENABLED !== true
        ) {
          return "not_claimable";
        }
        const bookingSnap = await tx.get(db.collection("booking_requests").doc(bookingId));
        const booking = bookingSnap.data() ?? {};
        const bookingChildIds = Array.isArray(booking.childIds)
          ? booking.childIds.map((childId: unknown) => String(childId))
          : [];
        if (
          !bookingSnap.exists ||
          booking.careVertical !== "child" ||
          booking.clientId !== data.userId ||
          booking.status === "canceled" ||
          booking.status === "completed" ||
          bookingChildIds.length !== bindings.length
        ) {
          return "not_claimable";
        }
        for (const binding of bindings) {
          if (!bookingChildIds.includes(binding.childId)) return "not_claimable";
          const authoritySnap = await tx.get(
            db.collection("guardian_authorities").doc(`${binding.childId}__${data.userId}`),
          );
          const authority = authoritySnap.data() ?? {};
          if (
            !authoritySnap.exists ||
            authority.state !== "active" ||
            !Array.isArray(authority.scopes) ||
            !authority.scopes.includes(binding.scope) ||
            Number(authority.accessVersion) !== Number(binding.accessVersion)
          ) {
            return "not_claimable";
          }
        }
      }
      tx.update(ref, { status: "executing", executingStartedAt: new Date().toISOString() });
      return "claimed";
    });
  } catch {
    return "not_claimable"; // fail closed — never dispatch on an uncertain claim
  }
}

// PHI-minimized audit emitter for the healthcare action lifecycle (H-U8/KTD-9):
// only non-identifying codes (loginAction, pharmacy/portal key, pending id) —
// never provider or medication names (those stay in browser_sessions).
async function logHealthcareAudit(
  action: Pick<PendingAction, "id" | "toolName" | "toolInput" | "userId">,
  status: "proposed" | "confirmed" | "executed" | "failed",
  errorReason?: string,
): Promise<void> {
  if (action.toolName !== "perform_web_action") return;
  try {
    const { logAgentAction } = await import("../observability/actionLedger");
    await logAgentAction({
      actionType:  "healthcare_action",
      status,
      userId:      action.userId ?? "",
      toolName:    action.toolName,
      targetDocId: action.id,
      ...(errorReason ? { errorReason: errorReason.slice(0, 200) } : {}),
      metadata: {
        loginAction: String(action.toolInput.loginAction ?? ""),
        portal:      String(action.toolInput.pharmacyService ?? action.toolInput.portalService ?? ""),
      },
    });
  } catch { /* non-fatal */ }
}

export { logHealthcareAudit };

// Look up the most recent unresolved pending action for a phone, or null.
// "Unresolved" = status === "awaiting" AND expiresAt > now.
// Auto-expires stale awaiting docs so they don't accumulate.
export async function getLatestPending(
  phone: string,
  careVertical?: "senior" | "child",
): Promise<PendingAction | null> {
  const live = await getAllPending(phone, careVertical);
  return live[0] ?? null;
}

// All unresolved pending actions for a phone, newest first. Same query and
// lazy-expiry behavior as getLatestPending, without the limit. Used by the
// webhook to detect the multi-pending case (batch confirmation).
export async function getAllPending(
  phone: string,
  careVertical?: "senior" | "child",
): Promise<PendingAction[]> {
  const snap = await db.collection("pending_actions")
    .where("phone",  "==", phone)
    .where("status", "==", "awaiting")
    .orderBy("proposedAt", "desc")
    .get();
  const now = Date.now();
  const live: PendingAction[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Omit<PendingAction, "id">;
    const storedVertical = data.careVertical ?? "senior";
    if (careVertical && storedVertical !== careVertical) continue;
    if (new Date(data.expiresAt).getTime() < now) {
      // Lazily expire — keeps the read fast at the cost of one write per stale doc.
      await doc.ref.update({
        status:     "expired",
        resolvedAt: new Date().toISOString(),
      }).catch(() => {});
      continue;
    }
    live.push({ id: doc.id, ...data });
  }
  return live;
}

export async function getPendingActionById(id: string): Promise<PendingAction | null> {
  const snap = await db.collection("pending_actions").doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as Omit<PendingAction, "id">) };
}

// Transport/identity fields the dispatcher re-injects on every call — they are
// NOT part of the semantic action and must be excluded when comparing the
// confirmed input against the stored pending input (approvalHandler rebuilds
// these from the authenticated approver, so they legitimately differ/repeat).
const NON_SEMANTIC_INPUT_FIELDS = new Set([
  "_confirmedActionId", "_operationId", "_boundOperationId", "_sourceTurnKey",
  "phone", "chatId", "clientId", "userId", "sourceMessageId", "role",
]);

// Stable canonical JSON of the semantic tool input (sorted keys, transport
// fields stripped) so two inputs that differ only in field order or transport
// metadata compare equal — but a changed appointmentId / decision / etc. does not.
function canonicalizeToolInput(input: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (NON_SEMANTIC_INPUT_FIELDS.has(k)) continue;
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = norm(val);
    }
    return out;
  };
  return JSON.stringify(norm(input));
}

// Validate a _confirmedActionId at the MCP gate so the gate's safety lives in
// CODE, not in caller discipline: the confirmation must reference a real,
// still-awaiting (the legit re-run dispatches before resolving), unexpired
// action for the SAME phone and tool — AND, when the current input is supplied,
// the same semantic parameters as the stored proposal. This stops a valid
// confirmation id from being reused to commit a DIFFERENT action.
export function isConfirmedActionValid(
  pending:      PendingAction | null,
  toolName:     string,
  phone:        string | undefined,
  nowMs:        number = Date.now(),
  currentInput?: Record<string, unknown>,
  operationId?: string,
): boolean {
  if (
    !(pending !== null &&
      (pending.status === "awaiting" ||
        pending.status === "approved" ||
        (pending.status === "executing" &&
          !!pending.operation &&
          operationId === pending.operation.operationId)) &&
      new Date(pending.expiresAt).getTime() > nowMs &&
      pending.toolName === toolName &&
      pending.phone === phone)
  ) {
    return false;
  }
  if (pending.operation) {
    const currentVertical = currentInput?.careVertical === "child" ? "child" : "senior";
    const currentObject = resolveOperationObject(toolName, currentInput ?? {});
    if (
      operationId !== pending.operation.operationId ||
      pending.operation.schema !== "pending-operation-v1" ||
      pending.operation.actionSchemaVersion !== 1 ||
      pending.operation.actionName !== toolName ||
      pending.operation.careVertical !== currentVertical ||
      pending.operation.objectType !== currentObject.type ||
      pending.operation.objectId !== currentObject.id ||
      pending.operation.expiresAt !== pending.expiresAt ||
      pending.operation.sourceTurnKey !== String(currentInput?._sourceTurnKey ?? "") ||
      pending.operation.principalId !== String(
        currentInput?.userId ?? currentInput?.clientId ?? phone ?? "",
      )
    ) {
      return false;
    }
  }
  // Compare semantic params only when we have both the current input and a
  // stored toolInput to compare against (real proposals always store one).
  if (currentInput && pending.toolInput && typeof pending.toolInput === "object") {
    return canonicalizeToolInput(currentInput) === canonicalizeToolInput(pending.toolInput);
  }
  return true;
}

// Mark resolved with the given status. Idempotent — calling twice with the
// same status is a no-op; calling with a different status logs a warning so
// downstream race conditions surface.
export async function resolvePendingAction(
  id: string,
  status: Exclude<PendingAction["status"], "awaiting">,
  opts: {
    executionPreview?: string;
    evidence?: {
      safeClaimCode?: unknown;
      status?: unknown;
      targetRef?: unknown;
    };
  } = {},
): Promise<void> {
  const ref = db.collection("pending_actions").doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data() as PendingAction;
    // Allow settling from "awaiting" (legacy direct settle) or "executing" (the
    // H-U5 claim-before-dispatch path); idempotent re-settle to the same status.
    if (current.status !== "awaiting" && current.status !== "executing" && current.status !== status) {
      console.warn("pendingActions.resolve: status conflict", {
        id,
        currentStatus: current.status,
        requestedStatus: status,
      });
      return;
    }
    tx.update(ref, {
      status,
      resolvedAt: new Date().toISOString(),
      ...(opts.executionPreview ? { executionPreview: opts.executionPreview.slice(0, 500) } : {}),
      ...(current.operation && (status === "executed" || status === "failed")
        ? {
            terminalEvidence: {
              operationId: current.operation.operationId,
              status,
              ...(typeof opts.evidence?.safeClaimCode === "string"
                ? { safeClaimCode: opts.evidence.safeClaimCode.slice(0, 64) }
                : {}),
              ...(typeof opts.evidence?.status === "string"
                ? { evidenceStatus: opts.evidence.status.slice(0, 32) }
                : {}),
              ...(typeof opts.evidence?.targetRef === "string"
                ? { targetRef: opts.evidence.targetRef.slice(0, 240) }
                : {}),
              settledAt: new Date().toISOString(),
            },
          }
        : {}),
    });
  });
}

// Stub returned to Claude in place of the real tool result. Claude reads
// this and generates a confirmation prompt for the family.
export function buildPendingActionStub(action: PendingAction): {
  _pending_action: true;
  actionId:        string;
  toolName:        string;
  preview:         string;
  expires_in_minutes: number;
  guidance:        string;
} {
  const minutes = Math.max(1, Math.ceil((new Date(action.expiresAt).getTime() - Date.now()) / 60_000));
  return {
    _pending_action: true,
    actionId:        action.id,
    toolName:        action.toolName,
    preview:         action.preview,
    expires_in_minutes: minutes,
    guidance:
      "This action is irreversible. Tell the family in plain English exactly what you are about to do, " +
      "then ask for an explicit YES before proceeding. Do NOT call this tool again until they confirm. " +
      "If they decline, acknowledge and stop. If they ask a question instead, answer it and re-ask for confirmation.",
  };
}
