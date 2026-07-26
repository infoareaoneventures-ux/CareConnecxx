// Handles inbound family/caregiver replies when a pending irreversible
// action is awaiting confirmation. Runs BEFORE the main intent classifier
// in the webhook dispatch order, because once Evia has proposed
// "cancel Tuesday's visit — yes or no?", the natural-language flexibility
// of the reply ("yeah", "go ahead", "actually no", "wait what time was
// it") needs a focused classifier instead of the 50-intent generalist.
//
// Returns "handled" when the message was a clear YES or NO (the caller
// should NOT continue to the QA agent). Returns "fallthrough" when the
// reply isn't a clear decision (e.g. a follow-up question) so the caller
// can run the normal QA agent path with the pending action surfaced as
// system context.

import { quickComplete } from "../utils/openaiClient";
import { sendMessage } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import {
  type PendingAction,
  resolvePendingAction,
  claimPendingAction,
  logHealthcareAudit,
} from "./pendingActions";
import { handleToolCall, handleToolCallForCaregiver } from "../mcp/server";
import { logAgentAction } from "../observability/actionLedger";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";

export type ApprovalDecision = "YES" | "NO" | "QUESTION";

// Trivial fast paths — common single-word answers we can classify without
// an LLM call. Saves 300–500ms on the common case.
const TRIVIAL_YES = new Set(["YES", "Y", "YEAH", "YEP", "YUP", "OK", "OKAY", "SURE", "CONFIRM", "CONFIRMED", "GO AHEAD", "DO IT", "GO", "PROCEED", "APPROVED"]);
const TRIVIAL_NO  = new Set(["NO", "N", "NOPE", "NAH", "STOP", "WAIT", "CANCEL", "DON'T", "DONT", "NEVER MIND", "NEVERMIND", "ACTUALLY NO", "FORGET IT"]);

export async function classifyApproval(text: string, actionPreview: string): Promise<ApprovalDecision> {
  const trimmed = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  if (TRIVIAL_YES.has(trimmed)) return "YES";
  if (TRIVIAL_NO.has(trimmed))  return "NO";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const raw = await quickComplete(
      "You classify a family member's reply to a confirmation prompt from a care assistant. " +
      `The assistant asked them to confirm this irreversible action: "${actionPreview}". ` +
      "Reply with exactly one word: YES, NO, or QUESTION. " +
      "YES = clear approval to proceed (e.g. 'yes', 'go ahead', 'sounds right', 'do it'). " +
      "NO = clear refusal or change of mind (e.g. 'no', 'wait', 'actually don't', 'never mind'). " +
      "QUESTION = anything else, including clarifying questions, hedged replies, off-topic messages, " +
      "or requests for more info. If you are unsure, prefer QUESTION over YES — confirming an irreversible " +
      "action by accident is much worse than asking again.",
      text,
      { maxTokens: 5, signal: controller.signal },
    );
    clearTimeout(timer);
    const label = raw.trim().toUpperCase();
    if (label === "YES" || label === "NO" || label === "QUESTION") return label;
    return "QUESTION";
  } catch (err) {
    clearTimeout(timer);
    console.warn("classifyApproval: error, defaulting to QUESTION", err instanceof Error ? err.message : err);
    return "QUESTION"; // fail-safe — never auto-execute on classifier failure
  }
}

export type ApprovalResult =
  | { outcome: "handled" }
  | { outcome: "fallthrough"; reason: "question" | "expired" };

// Execute one confirmed action: dispatch the tool with the bypass flag set,
// then mark the pending doc executed/failed. resolvePendingAction is
// transactional and single-fire, so a duplicate YES racing through here
// can't double-resolve; the dispatch carries _confirmedActionId so the MCP
// gate executes instead of re-proposing (see mcp/server.ts).
// Returns succeeded=true when the tool reported success. `skipped` is true when
// the action wasn't claimable (a duplicate/already-processed/expired confirmation)
// — that is NOT an execution failure and must not be reported to the user as one.
// On a real failure, alertFlagged reports whether the ops alert actually
// persisted, so the caller only tells the user "I've flagged it for review" when
// that's true.
async function executeConfirmedAction(params: {
  phone:    string;
  chatId:   string;
  userId?:  string;
  userType: "client" | "caregiver";
  pending:  PendingAction;
}): Promise<{
  succeeded: boolean;
  alertFlagged: boolean;
  skipped: boolean;
  safeClaimCode?: string;
}> {
  const { phone, chatId, userId, userType, pending } = params;

  console.info("approvalHandler.execute", {
    phone,
    actionId: pending.id,
    toolName: pending.toolName,
  });

  // H-U5: claim BEFORE dispatch (awaiting → executing) so a duplicate YES / retry
  // can't double-dispatch. A second confirmation finds it already executing/
  // executed and no-ops here.
  let claim: Awaited<ReturnType<typeof claimPendingAction>>;
  try {
    claim = await claimPendingAction(pending.id);
  } catch (err) {
    const executionPreview = `approval denied: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    await resolvePendingAction(pending.id, "failed", { executionPreview }).catch((resolveErr) => {
      console.error("approvalHandler: failed to settle denied action", { actionId: pending.id, resolveErr });
    });
    try {
      await logHealthcareAudit(pending, "failed", executionPreview);
    } catch {
      // The denied action is already terminal; audit failure is surfaced by the ops alert below.
    }
    const alertFlagged = await createCaraOpsAlert({
      type: "cara_pending_action_failed",
      severity: "high",
      phone,
      userId: userId ?? pending.userId,
      role: userType,
      source: "approvalHandler",
      actionId: pending.id,
      toolName: pending.toolName,
      targetCollection: "pending_actions",
      targetDocId: pending.id,
      message: `Evia denied an approved action after the live authorization recheck: ${pending.preview}`,
      reason: executionPreview,
      context: {
        preview: pending.preview,
        careVertical: pending.careVertical ?? "senior",
      },
    }).catch(() => false);
    return {
      succeeded: false,
      alertFlagged,
      skipped: false,
      safeClaimCode: "denied_live_recheck",
    };
  }
  if (claim !== "claimed") {
    console.info("approvalHandler.execute: action not claimable (duplicate/expired) — skipping", { actionId: pending.id });
    return {
      succeeded: false,
      alertFlagged: true,
      skipped: true,
      safeClaimCode: pending.terminalEvidence?.safeClaimCode,
    };
  }
  await logHealthcareAudit(pending, "confirmed");
  logAgentAction({
    actionType:       "pending_action",
    status:           "confirmed",
    userId:           userId ?? pending.userId ?? "",
    phone,
    role:             userType,
    toolName:         pending.toolName,
    targetCollection: "pending_actions",
    targetDocId:      pending.id,
    metadata: {
      preview:          pending.preview,
      triggeredByPhone: pending.triggeredByPhone ?? "",
      approverPhone:    pending.approverPhone ?? "",
    },
  }).catch((err) => console.warn("approvalHandler: logAgentAction (confirmed) ledger write failed", { actionId: pending.id, err }));

  // TODO(runTool-migration): Once all tools are migrated to ToolHandler descriptors,
  // replace this dispatch with runTool() so confirmed actions get the
  // toolExecutionLedger idempotency guarantee (U5). Until then, double-execution
  // is prevented by claimPendingAction's single-fire Firestore transaction above
  // (line ~97) — correct but a different mechanism than the ledger.
  // See: functions/src/mcp/runTool.ts, functions/src/mcp/toolExecutionLedger.ts
  const dispatch = userType === "caregiver" ? handleToolCallForCaregiver : handleToolCall;
  // Strip any _confirmedActionId that rode in on the stored tool input (e.g.
  // injected via extracted portal text) — only THIS direct dispatch may set it.
  const {
    _confirmedActionId: _injected,
    _operationId: _injectedOperation,
    ...safeToolInput
  } = pending.toolInput as Record<string, unknown>;
  void _injected;
  void _injectedOperation;
  // Inject identifiers + the bypass flag so the MCP gate executes instead of
  // re-proposing. _confirmedActionId is read by the MCP gate; see mcp/server.ts.
  const enrichedInput: Record<string, unknown> = {
    ...safeToolInput,
    phone,
    chatId,
    ...(userId ? { clientId: userId, userId } : {}),
    _confirmedActionId: pending.id,
    ...(pending.operation ? { _operationId: pending.operation.operationId } : {}),
  };

  let executionPreview = "";
  let succeeded = false;
  let executionEvidence:
    | { safeClaimCode?: unknown; status?: unknown; targetRef?: unknown }
    | undefined;
  try {
    const result = await dispatch(pending.toolName, enrichedInput);
    succeeded = !(result as { _toolError?: boolean; error?: unknown })?._toolError &&
                !(result as { error?: unknown })?.error;
    executionPreview = JSON.stringify(result).slice(0, 500);
    const evidence = (result as { evidence?: unknown })?.evidence;
    if (evidence && typeof evidence === "object") {
      executionEvidence = evidence as {
        safeClaimCode?: unknown;
        status?: unknown;
        targetRef?: unknown;
      };
    }
  } catch (err) {
    console.error("approvalHandler: tool execution failed", { actionId: pending.id, err });
    executionPreview = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
  }

  await resolvePendingAction(
    pending.id,
    succeeded ? "executed" : "failed",
    { executionPreview, evidence: executionEvidence },
  );
  await logHealthcareAudit(pending, succeeded ? "executed" : "failed", succeeded ? undefined : executionPreview);
  logAgentAction({
    actionType:       "pending_action",
    status:           succeeded ? "executed" : "failed",
    userId:           userId ?? pending.userId ?? "",
    phone,
    role:             userType,
    toolName:         pending.toolName,
    targetCollection: "pending_actions",
    targetDocId:      pending.id,
    ...(succeeded ? {} : { errorReason: executionPreview.slice(0, 200) }),
    metadata: {
      preview:          pending.preview,
      triggeredByPhone: pending.triggeredByPhone ?? "",
      approverPhone:    pending.approverPhone ?? "",
    },
  }).catch((err) => console.warn("approvalHandler: logAgentAction (executed/failed) ledger write failed", { actionId: pending.id, err }));

  let alertFlagged = true; // irrelevant on success; set below on failure
  if (!succeeded) {
    alertFlagged = await createCaraOpsAlert({
      type:             "cara_pending_action_failed",
      severity:         "high",
      phone,
      userId:           userId ?? pending.userId,
      role:             userType,
      source:           "approvalHandler",
      actionId:         pending.id,
      toolName:         pending.toolName,
      targetCollection: "pending_actions",
      targetDocId:      pending.id,
      message:          `Evia could not complete an approved action: ${pending.preview}`,
      reason:           executionPreview,
      context: {
        preview:          pending.preview,
        triggeredByPhone: pending.triggeredByPhone ?? "",
        approverPhone:    pending.approverPhone ?? "",
      },
    });
  }

  // H-U4: tell the requester (if a secondary member triggered it) the outcome.
  if (pending.triggeredByPhone && pending.triggeredByPhone !== phone) {
    const verified = executionEvidence?.safeClaimCode === "completed_verified";
    await sendMessage(pending.triggeredByPhone, succeeded
      ? verified || pending.careVertical !== "child"
        ? `Update: the account holder approved "${pending.preview}" and it's done.`
        : `Update: the account holder approved "${pending.preview}". The request ran, but I couldn't verify the final state yet.`
      : `Update: "${pending.preview}" couldn't be completed. The account holder has been notified.`,
    ).catch(() => {});
  }

  return {
    succeeded,
    alertFlagged,
    skipped: false,
    safeClaimCode:
      typeof executionEvidence?.safeClaimCode === "string"
        ? executionEvidence.safeClaimCode
        : undefined,
  };
}

// Main entry point. Loads or accepts the pending action, classifies the
// reply, and executes / rejects / falls through as appropriate.
export async function handlePendingApproval(params: {
  phone:       string;
  chatId:      string;
  text:        string;
  userId?:     string;
  userType?:   "client" | "caregiver";
  pending:     PendingAction;
}): Promise<ApprovalResult> {
  const { phone, chatId, text, userId, userType = "client", pending } = params;

  // H-U4: only the account holder can approve a healthcare write action. The
  // approver-keyed pending doc means a non-approver's reply usually won't even
  // match this doc, but guard explicitly: a YES from a non-approver does NOT
  // execute and the action stays awaiting the account holder.
  if (pending.approverPhone && phone !== pending.approverPhone) {
    const decisionForApprover = await classifyApproval(text, pending.preview);
    if (decisionForApprover === "YES") {
      await sendMessage(chatId, await generateCaraMessage({
        audience: userType === "caregiver" ? "caregiver" : "family",
        language: "en",
        context: "Someone who isn't the primary account holder tried to approve an action that needs the account holder's sign-off. Warmly explain only the primary account holder can approve this, and that you've asked them to confirm.",
        fallback: "Only the primary account holder can approve this — I've asked them to confirm.",
        maxTokens: 70,
      })).catch(() => {});
      return { outcome: "handled" };
    }
    return { outcome: "fallthrough", reason: "question" };
  }

  const decision = await classifyApproval(text, pending.preview);

  if (decision === "QUESTION") {
    // Don't resolve the pending action — let the QA agent answer the question
    // and re-prompt for confirmation. The webhook caller treats this as a
    // normal QA turn but should inject context about the pending action
    // so Evia knows what's still awaiting confirmation.
    return { outcome: "fallthrough", reason: "question" };
  }

  if (decision === "NO") {
    await resolvePendingAction(pending.id, "rejected");
    await sendMessage(chatId, "Got it — leaving things as they are.").catch((err) => {
      console.error("handlePendingApproval: sendMessage (NO) failed", err);
    });
    return { outcome: "handled" };
  }

  // decision === "YES" — execute the tool with the bypass flag set.
  const {
    succeeded,
    alertFlagged,
    skipped,
    safeClaimCode,
  } = await executeConfirmedAction({ phone, chatId, userId, userType, pending });

  // Acknowledge to the family. Keep it short — the tool itself may have
  // already sent richer downstream notifications (e.g. caregiver SMS). A
  // `skipped` result means a duplicate/already-handled confirmation, not a
  // failure — never tell the user it "didn't go through". Only claim it was
  // "flagged for review" when the ops alert actually persisted.
  const ackMessage = succeeded
    ? pending.careVertical === "child" && safeClaimCode !== "completed_verified"
      ? "I completed the request, but I couldn't verify the final state yet. Please check the childcare booking before relying on it."
      : "Done."
    : skipped
      ? "That's already been taken care of — nothing more needed."
      : alertFlagged
        ? "I tried, but it didn't go through. I've flagged it for review."
        : "I tried, but it didn't go through, and I couldn't log it for review automatically. Text me what happened and I can try the next step here.";
  await sendMessage(chatId, ackMessage).catch((err) => {
    console.error("handlePendingApproval: sendMessage (YES) failed", err);
  });

  return { outcome: "handled" };
}

function parseNumberedApproval(
  text: string,
  count: number,
): { index: number; decision: "YES" | "NO" } | null {
  const normalized = text.trim().toLowerCase();
  const numeric = normalized.match(/(?:^|\s|#)(\d+)(?:\s|$|[.,!?])/);
  const ordinalWords: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
  };
  const ordinal = Object.entries(ordinalWords).find(([word]) =>
    new RegExp(`\\b${word}\\b`).test(normalized),
  )?.[1];
  const selected = numeric ? Number(numeric[1]) : ordinal;
  if (!selected || selected < 1 || selected > count) return null;

  if (/\b(no|nope|reject|skip|leave)\b|do not|don't/.test(normalized)) {
    return { index: selected - 1, decision: "NO" };
  }
  if (/\b(yes|approve|confirm|proceed)\b|go ahead|do it/.test(normalized)) {
    return { index: selected - 1, decision: "YES" };
  }
  return null;
}

// Multiple pending actions require a numbered operation choice. Approval text
// alone is not a stable operation identity and must never execute a batch.
export async function handlePendingApprovals(params: {
  phone:       string;
  chatId:      string;
  text:        string;
  userId?:     string;
  userType?:   "client" | "caregiver";
  pendings:    PendingAction[];
}): Promise<ApprovalResult> {
  const { phone, chatId, text, userId, userType = "client", pendings } = params;

  if (pendings.length === 0) return { outcome: "fallthrough", reason: "expired" };
  if (pendings.length === 1) {
    return handlePendingApproval({ phone, chatId, text, userId, userType, pending: pendings[0] });
  }

  // getAllPending returns newest-first; show and execute in proposal order
  // so "1." matches what Evia asked about first.
  const ordered = [...pendings].reverse();
  const combinedPreview = ordered.map((p, i) => `${i + 1}. ${p.preview}`).join("  ");
  const selected = parseNumberedApproval(text, ordered.length);
  if (selected) {
    return handlePendingApproval({
      phone,
      chatId,
      text: selected.decision === "YES" ? "yes" : "no",
      userId,
      userType,
      pending: ordered[selected.index],
    });
  }
  const decision = await classifyApproval(text, combinedPreview);

  if (decision === "QUESTION") {
    return { outcome: "fallthrough", reason: "question" };
  }

  if (decision === "NO") {
    for (const pending of ordered) {
      await resolvePendingAction(pending.id, "rejected");
    }
    await sendMessage(chatId, "Got it — leaving everything as it is.").catch((err) => {
      console.error("handlePendingApprovals: sendMessage (NO) failed", err);
    });
    return { outcome: "handled" };
  }

  // A YES without a unique operation reference must not execute anything.
  await sendMessage(
    chatId,
    `I have more than one action waiting. Reply "yes to 1" or "yes to 2" for exactly one action: ${combinedPreview}`,
  ).catch((err) => {
    console.error("handlePendingApprovals: sendMessage (ambiguous YES) failed", err);
  });

  return { outcome: "handled" };
}
