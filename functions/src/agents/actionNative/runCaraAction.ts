import { createHash } from "crypto";
import { logAgentAction } from "../../observability/actionLedger";
import { claimCaraActionExecution, settleCaraActionExecution } from "./actionExecutionLedger";
import { safePreview } from "./redaction";
import type { CaraActionContext, CaraActionDefinition } from "./caraActionTypes";

export class CaraActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaraActionValidationError";
  }
}

export class CaraActionAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaraActionAccessError";
  }
}

export class CaraActionApprovalRequiredError extends Error {
  readonly approvalKey: string;

  constructor(approvalKey: string) {
    super("Evia action requires approval before execution");
    this.name = "CaraActionApprovalRequiredError";
    this.approvalKey = approvalKey;
  }
}

export class CaraActionInProgressError extends Error {
  constructor(actionName: string) {
    super(`${actionName}: action is already running for this idempotency key`);
    this.name = "CaraActionInProgressError";
  }
}

export async function runCaraAction<TInput, TOutput>(
  action: CaraActionDefinition<TInput, TOutput>,
  rawInput: unknown,
  ctx: CaraActionContext,
): Promise<TOutput> {
  if (action.adminOnly && ctx.role !== "admin") {
    throw new CaraActionAccessError(`${action.name}: admin role required`);
  }
  if (action.allowedRoles?.length && !action.allowedRoles.includes(ctx.role)) {
    throw new CaraActionAccessError(`${action.name}: role ${ctx.role} is not allowed`);
  }

  const inputParsed = action.inputSchema.safeParse(rawInput);
  if (!inputParsed.success) {
    throw new CaraActionValidationError(`${action.name}: invalid input`);
  }
  const input = inputParsed.data;

  const needsApproval =
    typeof action.approvalRequired === "function"
      ? await action.approvalRequired(input, ctx)
      : action.approvalRequired === true;
  const approvalKey = createApprovalKey(action.name, input, ctx);
  if (needsApproval && !ctx.approvedActionKeys?.includes(approvalKey)) {
    await logAgentAction({
      actionType: action.audit?.actionType ?? action.name,
      status: "proposed",
      userId: ctx.uid,
      phone: ctx.phone,
      role: ctx.role,
      sourceMessageId: ctx.sourceMessageId,
      toolName: action.name,
      targetCollection: action.audit?.targetCollection,
      metadata: {
        approvalKey,
        caller: ctx.caller,
        inputPreview: safePreview(input),
      },
    });
    throw new CaraActionApprovalRequiredError(approvalKey);
  }

  const idempotencyKey = !action.readOnly ? action.idempotencyKey?.(input, ctx) : undefined;
  if (idempotencyKey) {
    let claim;
    try {
      claim = await claimCaraActionExecution(idempotencyKey, { failClosed: action.failClosed });
    } catch (err) {
      // Fail-closed refusal (ledger unavailable) — make it ops-visible before
      // rethrowing, or a sustained ledger outage silently blocks money actions.
      await logAgentAction({
        actionType: action.audit?.actionType ?? action.name,
        status: "failed",
        userId: ctx.uid,
        phone: ctx.phone,
        role: ctx.role,
        sourceMessageId: ctx.sourceMessageId,
        toolName: action.name,
        targetCollection: action.audit?.targetCollection,
        errorReason: "duplicate-protection claim unavailable — fail-closed refusal",
        metadata: { caller: ctx.caller, idempotencyKey },
      }).catch(() => {});
      throw err;
    }
    if ("inProgress" in claim && claim.inProgress) {
      await logAgentAction({
        actionType: action.audit?.actionType ?? action.name,
        status: "duplicate_blocked",
        userId: ctx.uid,
        phone: ctx.phone,
        role: ctx.role,
        sourceMessageId: ctx.sourceMessageId,
        toolName: action.name,
        targetCollection: action.audit?.targetCollection,
        metadata: {
          caller: ctx.caller,
          idempotencyKey,
          reason: "in_progress",
        },
      });
      throw new CaraActionInProgressError(action.name);
    }

    if (claim.cached) {
      const cached = action.outputSchema.safeParse(claim.result);
      if (!cached.success) {
        // Reachable when a prior run settled raw output after its own
        // output-validation failure: every retry in the TTL window lands here.
        // Log it so ops can see retrying is futile instead of a silent loop.
        await logAgentAction({
          actionType: action.audit?.actionType ?? action.name,
          status: "failed",
          userId: ctx.uid,
          phone: ctx.phone,
          role: ctx.role,
          sourceMessageId: ctx.sourceMessageId,
          toolName: action.name,
          targetCollection: action.audit?.targetCollection,
          errorReason: "cached output invalid — prior run's side effect completed but failed output validation",
          metadata: { caller: ctx.caller, idempotencyKey },
        }).catch(() => {});
        throw new CaraActionValidationError(`${action.name}: cached output is invalid`);
      }
      await logAgentAction({
        actionType: action.audit?.actionType ?? action.name,
        status: "duplicate_blocked",
        userId: ctx.uid,
        phone: ctx.phone,
        role: ctx.role,
        sourceMessageId: ctx.sourceMessageId,
        toolName: action.name,
        targetCollection: action.audit?.targetCollection,
        metadata: {
          caller: ctx.caller,
          idempotencyKey,
        },
      });
      return cached.data;
    }
  }

  if (!action.readOnly) {
    await logAgentAction({
      actionType: action.audit?.actionType ?? action.name,
      status: "confirmed",
      userId: ctx.uid,
      phone: ctx.phone,
      role: ctx.role,
      sourceMessageId: ctx.sourceMessageId,
      toolName: action.name,
      targetCollection: action.audit?.targetCollection,
      metadata: {
        caller: ctx.caller,
        idempotencyKey: idempotencyKey ?? null,
        inputPreview: safePreview(input),
      },
    });
  }

  let output: TOutput;
  try {
    output = await action.run(input, ctx);
  } catch (err) {
    if (!action.readOnly) {
      await logAgentAction({
        actionType: action.audit?.actionType ?? action.name,
        status: "failed",
        userId: ctx.uid,
        phone: ctx.phone,
        role: ctx.role,
        sourceMessageId: ctx.sourceMessageId,
        toolName: action.name,
        targetCollection: action.audit?.targetCollection,
        errorReason: err instanceof Error ? err.message : String(err),
        metadata: { caller: ctx.caller },
      });
    }
    if (idempotencyKey) await settleCaraActionExecution(idempotencyKey, { ok: false });
    throw err;
  }

  const outputParsed = action.outputSchema.safeParse(output);
  if (!outputParsed.success) {
    // The side effect already ran — settle the claim with the raw output so a
    // retry inside the duplicate-protection window cannot re-execute it, and
    // leave an audit trail. Settling { ok: false } would DELETE the claim and
    // invite an immediate duplicate of a side effect that already happened.
    if (!action.readOnly && idempotencyKey) {
      await settleCaraActionExecution(idempotencyKey, { ok: true, result: toJsonSafe(output) });
    }
    if (!action.readOnly) {
      await logAgentAction({
        actionType: action.audit?.actionType ?? action.name,
        status: "failed",
        userId: ctx.uid,
        phone: ctx.phone,
        role: ctx.role,
        sourceMessageId: ctx.sourceMessageId,
        toolName: action.name,
        targetCollection: action.audit?.targetCollection,
        errorReason: "output validation failed after side effect executed",
        metadata: { caller: ctx.caller, idempotencyKey: idempotencyKey ?? null },
      });
    }
    throw new CaraActionValidationError(`${action.name}: invalid output`);
  }

  if (!action.readOnly) {
    if (idempotencyKey) await settleCaraActionExecution(idempotencyKey, { ok: true, result: outputParsed.data });
    await logAgentAction({
      actionType: action.audit?.actionType ?? action.name,
      status: "executed",
      userId: ctx.uid,
      phone: ctx.phone,
      role: ctx.role,
      sourceMessageId: ctx.sourceMessageId,
      toolName: action.name,
      targetCollection: action.audit?.targetCollection,
      targetDocId: action.audit?.targetDocId?.(input, outputParsed.data),
      metadata: {
        caller: ctx.caller,
        idempotencyKey: idempotencyKey ?? null,
        outputPreview: safePreview(outputParsed.data),
      },
    });
  }

  return outputParsed.data;
}

export function createApprovalKey(
  actionName: string,
  input: unknown,
  ctx: Pick<CaraActionContext, "uid" | "phone" | "role">,
): string {
  const normalized = stableStringify({
    actionName,
    input,
    uid: ctx.uid ?? null,
    phone: ctx.phone ?? null,
    role: ctx.role,
  });
  return createHash("sha1").update(normalized).digest("hex").slice(0, 24);
}

function toJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortValue((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}
