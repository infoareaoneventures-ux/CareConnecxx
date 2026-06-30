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
    super("Cara action requires approval before execution");
    this.name = "CaraActionApprovalRequiredError";
    this.approvalKey = approvalKey;
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
    const claim = await claimCaraActionExecution(idempotencyKey);
    if (claim.cached) {
      const cached = action.outputSchema.safeParse(claim.result);
      if (!cached.success) {
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
