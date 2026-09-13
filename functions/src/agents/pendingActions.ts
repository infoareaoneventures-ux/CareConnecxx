// Runtime-enforced confirmation gate for irreversible tool calls.
//
// Today Evia is *told* in the system prompt to confirm before
// remove_family_member, cancel_job_post, etc. — but if she forgets or is
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

const db = admin.firestore();

export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
}

// Set of tool names that ALWAYS require confirmation regardless of args.
// Mirrors the qaAgent.ts system-prompt list. Adding a tool here is a
// production-safety change; review the prompt's confirmation guidance too.
const ALWAYS_CONFIRM = new Set<string>([
  "remove_family_member",
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
  // Deleting the account is permanent (cancels billing, wipes Firestore data,
  // removes the login) — never fire without an explicit family confirmation.
  "delete_account",
  // 2026-09-09 live incident: cancel_interview's own tool description already
  // says "Confirm before calling" — prompt-only, same unenforced gap this
  // module exists to close. A family's bare "Yes." confirming a cancellation
  // was swallowed by the toolless quick-reply fast path (see the
  // isTrivialQuickReply fix in qaAgent.ts, same incident) and Evia falsely
  // claimed the interview was cancelled without ever calling this tool.
  // Runtime-enforcing it here means the confirm step no longer depends on the
  // model remembering to ask AND the family's reply reaching the tool loop —
  // this module's own approvalHandler intercepts the reply before either can
  // go wrong.
  "cancel_interview",
  // NOTE: schedule_interview does NOT go through this generic upfront gate —
  // it needs its own access-gate/ambiguous-name/NOT_FOUND validation to run
  // BEFORE asking for confirmation (this gate intercepts before ANY
  // tool-specific code runs, which would mask those specific errors behind a
  // generic PERMISSION_DENIED). See schedule_interview's own confirm-before-
  // commit logic in mcp/server.ts, built for the same 2026-09-12 incident
  // this gate protects against elsewhere (wrong caregiver id despite correct
  // context) — just implemented locally so existing validation still runs
  // first, unchanged.
]);

// Care-plan fields that are harmless note-like additions — free-text context
// the caregiver reads, not data that changes what care is being requested.
// Everything else on the care plan (careNeeds, emergencyContacts, accessCodes
// — and any future/unknown field, fail-safe) MUST round-trip an explicit
// family confirmation before it changes.
const CARE_PLAN_NOTE_FIELDS = new Set(["notes"]);

// Tools whose risk depends on an argument value. The predicate inspects the
// input and returns true when this specific call is irreversible.
const CONDITIONAL_CONFIRM: Record<string, (input: Record<string, unknown>) => boolean> = {
  // Only cancel — pause and resume are reversible.
  manage_recurring_schedule: (input) => input.action === "cancel",
  // Rejecting an applicant is irreversible (caregiver sees the decline).
  // Accept is also high-stakes but happens via a separate hire flow.
  respond_to_job_application: (input) => input.decision === "reject",
  // Care-plan edits that change what's requested (careNeeds, emergency
  // contacts, access codes) require confirmation. Note-like fields skip the
  // gate so "add a note that mom prefers tea" doesn't need a confirmation
  // round-trip.
  update_care_plan: (input) => !CARE_PLAN_NOTE_FIELDS.has(String(input.field)),
  // block_user + unblock_user + report_user were merged into one tool
  // (2026-08-31, to free tool slots under OpenAI's 128-tool cap) — block and
  // report are high-stakes (both were ALWAYS_CONFIRM before the merge);
  // unblock was never gated and must stay that way.
  set_block_status: (input) => input.action === "block" || input.action === "report",
  // cancel_subscription + reactivate_subscription merged the same way
  // (2026-09-02, to make room for delete_account) — cancel was ALWAYS_CONFIRM
  // before the merge; reactivate was never gated and must stay that way.
  set_subscription_status: (input) => input.action === "cancel",
  // U9: approving a timesheet (or accepting a caregiver's counter-proposal —
  // 2026-08-31, same payment-releasing effect as approve, added when
  // accept_counter/escalate were built) via the agent loop releases payment
  // to the caregiver — gate both. propose_correction/escalate are reversible
  // (go to a correction cycle or admin review) and stay ungated.
  review_shift_hours: (input) => input.action === "approve" || input.action === "accept_counter",
};

export function isHighRisk(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (ALWAYS_CONFIRM.has(toolName)) return true;
  const pred = CONDITIONAL_CONFIRM[toolName];
  return pred ? pred(toolInput) : false;
}

// Resolves a caregiverId to a real name for a confirmation preview — reused
// across every tool where Evia picks a specific caregiver by id and the
// family needs to SEE who that resolved to before anything commits. This is
// the actual safety net for a live-caught bug (2026-09-12): the family asked
// to interview "Basra Yousuf" from a list Evia had just shown them (each
// entry correctly paired with its real id in Evia's own context), but the
// model's schedule_interview call carried a DIFFERENT caregiver's id anyway —
// a tool-argument selection mistake, not a data bug. Showing the family the
// real resolved name before committing catches this even when the model's
// own reasoning slips, the same way cancel_interview's enforced confirmation
// already catches a forgotten/skipped confirmation.
// "HH:MM" → minutes since midnight, or null if malformed. Deliberately a
// local duplicate of mcp/server.ts's bookingTimeToMinutes (not imported —
// server.ts imports FROM this file, so importing back would be circular);
// this is a trivial, pure one-liner, safe to keep in sync by inspection.
function previewHHMMToMinutes(t: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

async function resolveCaregiverNameForPreview(caregiverId: unknown): Promise<string> {
  if (typeof caregiverId !== "string" || !caregiverId) return "an unspecified caregiver";
  try {
    const snap = await db.collection("publicCaregiverProfiles").doc(caregiverId).get();
    const name = snap.data()?.name as string | undefined;
    return name || `caregiver ${caregiverId}`;
  } catch {
    return `caregiver ${caregiverId}`;
  }
}

// Build a short human-readable preview of the action so support / debugging
// can see what was proposed without parsing the raw input JSON, AND so the
// family sees exactly who/what is about to happen before confirming. Falls
// back to a generic summary when no special-cased shape applies.
export async function buildActionPreview(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
  switch (toolName) {
    case "schedule_interview": {
      const name = await resolveCaregiverNameForPreview(toolInput.caregiverId);
      const when = [toolInput.preferredDate, toolInput.preferredTime].filter(Boolean).join(" at ");
      return `Schedule an interview with ${name}${when ? ` for ${when}` : ""}`;
    }
    case "request_booking": {
      // Full recap, matching the website's own "Review and edit before
      // sending" modal — the family should see everything before a real,
      // caregiver-facing booking commits.
      const name = await resolveCaregiverNameForPreview(toolInput.caregiverId);
      const rate = toolInput.agreedRate ? `$${toolInput.agreedRate}/hr` : undefined;
      // Total cost — computed HERE, fresh, from the SAME schedule/rate this
      // pending action actually carries (2026-09-13). Deliberately NOT
      // carried over from anything discussed earlier in conversation: if
      // the family changes the days/times while finalizing, a stated-earlier
      // number goes stale immediately — this recomputes from whatever is
      // actually about to be booked, so it can never drift from what commits.
      const hourlyRateNum = Number(toolInput.agreedRate);
      const hasRate = Number.isFinite(hourlyRateNum) && hourlyRateNum > 0;
      let totalLine: string | undefined;
      let scheduleLine: string;
      if (toolInput.recurring) {
        const dst = (toolInput.dayShiftTimes ?? {}) as Record<string, { start?: string; end?: string }>;
        const days = Object.entries(dst)
          .map(([d, t]) => `${d} ${t.start ?? "?"}-${t.end ?? "?"}`)
          .join(", ");
        const span = toolInput.ongoing ? "ongoing" : `through ${toolInput.endDate ?? "?"}`;
        scheduleLine = `${days} (${span})`;
        if (hasRate) {
          const weeklyHours = Object.values(dst).reduce((sum, t) => {
            const mins = previewHHMMToMinutes(t.end) !== null && previewHHMMToMinutes(t.start) !== null
              ? previewHHMMToMinutes(t.end)! - previewHHMMToMinutes(t.start)!
              : 0;
            return sum + Math.max(0, mins) / 60;
          }, 0);
          if (weeklyHours > 0) totalLine = `≈ $${Math.round(weeklyHours * hourlyRateNum * 100) / 100}/week`;
        }
      } else {
        const dateList = Array.isArray(toolInput.dates) ? (toolInput.dates as string[]) : [String(toolInput.dates ?? "")].filter(Boolean);
        scheduleLine = `${dateList.join(", ")}, ${toolInput.startTime ?? "?"}-${toolInput.endTime ?? "?"}`;
        if (hasRate && dateList.length) {
          const startMin = previewHHMMToMinutes(toolInput.startTime);
          const endMin   = previewHHMMToMinutes(toolInput.endTime);
          if (startMin !== null && endMin !== null && endMin > startMin) {
            const durationHours = (endMin - startMin) / 60;
            totalLine = `≈ $${Math.round(durationHours * hourlyRateNum * dateList.length * 100) / 100} total`;
          }
        }
      }
      const recipients = Array.isArray(toolInput.recipientFirstNames) && toolInput.recipientFirstNames.length
        ? (toolInput.recipientFirstNames as string[]).join(" & ")
        : (toolInput.recipientFirstName ? String(toolInput.recipientFirstName) : undefined);
      const careNeeds = Array.isArray(toolInput.careNeeds) && toolInput.careNeeds.length
        ? `care needs: ${(toolInput.careNeeds as string[]).join(", ")}` : undefined;
      const lifestyle = Array.isArray(toolInput.lifestylePreferences) && toolInput.lifestylePreferences.length
        ? (toolInput.lifestylePreferences as string[]).join(", ") : undefined;
      const ec = toolInput.emergencyContact as { name?: string; phone?: string } | undefined;
      const emergencyContact = ec?.phone ? `emergency contact: ${ec.name ?? "on file"} (${ec.phone})` : undefined;
      const parts = [
        `Book ${name}`,
        rate,
        scheduleLine,
        totalLine,
        toolInput.careLocation ? `at ${toolInput.careLocation}${lifestyle ? ` (${lifestyle})` : ""}` : undefined,
        recipients ? `for ${recipients}` : undefined,
        careNeeds,
        emergencyContact,
        toolInput.message ? `note: "${toolInput.message}"` : undefined,
      ].filter(Boolean);
      return parts.join(" — ");
    }
    case "remove_family_member":
      return `Remove family member ${String(toolInput.memberPhone ?? toolInput.memberId ?? "?")}`;
    case "set_subscription_status":
      return toolInput.action === "reactivate" ? `Reactivate Evia subscription` : `Cancel Evia subscription`;
    case "delete_account":
      return `Permanently delete this Evia account`;
    case "set_block_status": {
      const who = String(toolInput.targetUserId ?? toolInput.targetPhone ?? "?");
      if (toolInput.action === "unblock") return `Unblock user ${who}`;
      if (toolInput.action === "report") return `Report user ${who}`;
      return `Block user ${who}`;
    }
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
    default:
      return `${toolName} (irreversible)`;
  }
}

// Write a new pending action and return the doc. The id is generated by
// Firestore; callers use it to bypass the gate on the approval re-run.
export async function proposePendingAction(params: {
  phone:     string;
  userId?:   string;
  toolName:  string;
  toolInput: Record<string, unknown>;
}): Promise<PendingAction> {
  const now = Date.now();

  const action: Omit<PendingAction, "id"> = {
    phone:      params.phone,
    userId:     params.userId,
    toolName:   params.toolName,
    toolInput:  params.toolInput,
    preview:    await buildActionPreview(params.toolName, params.toolInput),
    proposedAt: new Date(now).toISOString(),
    expiresAt:  new Date(now + PENDING_ACTION_TTL_MS).toISOString(),
    status:     "awaiting",
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
export async function getLatestPending(phone: string): Promise<PendingAction | null> {
  const snap = await db.collection("pending_actions")
    .where("phone",  "==", phone)
    .where("status", "==", "awaiting")
    .orderBy("proposedAt", "desc")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc  = snap.docs[0];
  const data = doc.data() as Omit<PendingAction, "id">;

  if (new Date(data.expiresAt).getTime() < Date.now()) {
    // Lazily expire — keeps the read fast at the cost of one write per stale doc.
    await doc.ref.update({
      status:     "expired",
      resolvedAt: new Date().toISOString(),
    }).catch(() => {});
    return null;
  }
  return { id: doc.id, ...data };
}

// All unresolved pending actions for a phone, newest first. Same query and
// lazy-expiry behavior as getLatestPending, without the limit. Used by the
// webhook to detect the multi-pending case (batch confirmation).
export async function getAllPending(phone: string): Promise<PendingAction[]> {
  const snap = await db.collection("pending_actions")
    .where("phone",  "==", phone)
    .where("status", "==", "awaiting")
    .orderBy("proposedAt", "desc")
    .get();
  const now = Date.now();
  const live: PendingAction[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Omit<PendingAction, "id">;
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
  "_confirmedActionId", "phone", "chatId", "clientId", "userId", "sourceMessageId", "role",
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
): boolean {
  if (
    !(pending !== null &&
      // 2026-09-06 fix: "executing" MUST be accepted here — approvalHandler's
      // executeConfirmedAction calls claimPendingAction (awaiting → executing,
      // a single-fire transaction) BEFORE dispatching to the MCP gate with
      // _confirmedActionId set, so the legitimate re-run ALWAYS sees status
      // "executing" by the time this check runs, never "awaiting". Rejecting
      // "executing" here meant EVERY confirmed high-risk action in the product
      // failed unconditionally with PERMISSION_DENIED ("This confirmation is
      // no longer valid") — found via a live test where a family confirmed
      // declining a job applicant and got exactly that error. claimPendingAction's
      // own transaction (checks status !== "awaiting" inside the transaction)
      // already provides the single-fire/no-double-dispatch guarantee — this
      // check exists to reject a forged/expired/wrong-tool/wrong-phone/
      // tampered-input id, not to re-police a claim that already succeeded.
      (pending.status === "awaiting" || pending.status === "approved" || pending.status === "executing") &&
      new Date(pending.expiresAt).getTime() > nowMs &&
      pending.toolName === toolName &&
      pending.phone === phone)
  ) {
    return false;
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
  opts: { executionPreview?: string } = {},
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
