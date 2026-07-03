import { isHighRisk, proposePendingAction, buildPendingActionStub } from "../agents/pendingActions";
import { claimToolExecution, settleToolExecution, toolExecutionKey } from "./toolExecutionLedger";

/**
 * runTool — the deep module behind Evia's tool execution.
 *
 * Every MCP tool used to re-implement the same cross-cutting bands inline in a
 * ~3,000-line switch: field injection, ownership checks, the confirmation gate,
 * and audit — applied inconsistently (ownership on ~47% of handlers, audit on
 * ~70%). `runTool` owns those bands so a tool becomes just its `run` body plus a
 * small descriptor declaring what it needs.
 *
 * The runner is pure orchestration: it touches no Firestore directly. The
 * confirmation gate it applies is byte-for-byte the one that lived at the top of
 * `handleToolCall` (server.ts) — `_confirmedActionId` bypass, `isHighRisk` →
 * `proposePendingAction` → `buildPendingActionStub`, refuse high-risk without a
 * phone — so a migrated tool's gate behavior is identical to today's.
 *
 * Adapter-first (KTD-1): during migration a tool's `run` may simply call the
 * existing `handleToolCall`; tools are peeled into descriptors one at a time
 * (U6). Nothing routes through `runTool` until U6, so this module has zero
 * production impact on its own.
 */

/** Error shape — mirrors server.ts `toolError` so migrated tools are wire-identical. */
export type ToolErrorCode =
  | "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"
  | "UNAVAILABLE" | "CONFLICT" | "FORBIDDEN";

export function toolError(code: ToolErrorCode, message: string) {
  return { _toolError: true, success: false, code, message };
}

/** Session-derived context the runner injects into every tool call. */
export interface RunToolContext {
  phone?:       string;
  chatId?:      string;
  /** Client/family user id; injected as both `clientId` and `userId`. */
  userId?:      string;
  caregiverId?: string;
  /** "client" | "caregiver" — selects which actor's tool surface is in play. */
  actor?:       "client" | "caregiver";
}

/**
 * A tool expressed as data + a thin `run`. The runner applies the bands around
 * `run`; the handler body does only the actual work.
 */
export interface ToolHandler {
  /** Tool name — must match the registered MCP tool and the confirm-gate tables. */
  name: string;
  /**
   * Which session fields this tool needs injected. The runner merges the named
   * context fields into the input before ownership/run. `userId` injects both
   * `clientId` and `userId` (the codebase uses them interchangeably at call
   * sites). Defaults to all available fields when omitted.
   */
  injects?: Array<"phone" | "chatId" | "userId" | "caregiverId">;
  /**
   * Ownership / authorization check. Return a toolError to deny; return null to
   * allow. Runs AFTER injection and BEFORE the confirmation gate.
   */
  ownership?: (input: Record<string, unknown>, ctx: RunToolContext) => Promise<ReturnType<typeof toolError> | null>;
  /**
   * Set on tools whose side effect must fire at most once per confirmation
   * (anything that moves money or is otherwise non-idempotent). When a CONFIRMED
   * action runs, the runner claims a ledger key (confirmedActionId + name +
   * input hash); a replay of the same confirmed action returns the cached result
   * instead of re-running. Read tools and naturally-idempotent writes leave this
   * unset and skip the ledger entirely.
   */
  idempotent?: boolean;
  /** The actual tool work. Receives the injected input. */
  run: (input: Record<string, unknown>, ctx: RunToolContext) => Promise<unknown>;
  /** Fired best-effort after a successful run. Never blocks or throws into the result. */
  audit?: (input: Record<string, unknown>, result: unknown, ctx: RunToolContext) => void | Promise<void>;
}

/** Merge the requested session fields into the tool input (qaAgent's manual enrichment, centralized). */
function injectFields(
  input: Record<string, unknown>,
  ctx:   RunToolContext,
  injects?: ToolHandler["injects"],
): Record<string, unknown> {
  const want = injects ?? ["phone", "chatId", "userId", "caregiverId"];
  const out: Record<string, unknown> = { ...input };
  if (want.includes("phone")  && ctx.phone  !== undefined) out.phone  = ctx.phone;
  if (want.includes("chatId") && ctx.chatId !== undefined) out.chatId = ctx.chatId;
  if (want.includes("userId") && ctx.userId !== undefined) { out.clientId = ctx.userId; out.userId = ctx.userId; }
  if (want.includes("caregiverId") && ctx.caregiverId !== undefined) out.caregiverId = ctx.caregiverId;
  return out;
}

/**
 * Run a tool through the cross-cutting bands:
 *   inject → ownership → confirmation gate → run → audit.
 *
 * The confirmation gate is identical to handleToolCall's: a present
 * `_confirmedActionId` bypasses it (and is stripped); otherwise a high-risk tool
 * is turned into a pending-action stub (refused outright if no phone is present).
 */
export async function runTool(
  handler: ToolHandler,
  rawInput: Record<string, unknown>,
  ctx: RunToolContext,
): Promise<unknown> {
  // 1. Inject session fields.
  const input = injectFields(rawInput, ctx, handler.injects);

  // 2. Ownership / authorization.
  if (handler.ownership) {
    const denied = await handler.ownership(input, ctx);
    if (denied) return denied;
  }

  // 3. Confirmation gate (identical semantics to handleToolCall).
  const confirmedActionId = input._confirmedActionId as string | undefined;
  if (confirmedActionId) {
    delete input._confirmedActionId;
  } else if (isHighRisk(handler.name, input)) {
    const phone = input.phone as string | undefined;
    if (!phone) {
      console.warn("runTool gate: high-risk tool called without phone — refusing", { name: handler.name });
      return toolError("PERMISSION_DENIED", "This action requires explicit confirmation and cannot be executed without an SMS session.");
    }
    const action = await proposePendingAction({
      phone,
      userId:    input.userId as string | undefined,
      toolName:  handler.name,
      toolInput: input,
    });
    console.info("runTool gate: proposed pending action", { phone, actionId: action.id, toolName: handler.name });
    return buildPendingActionStub(action);
  }

  // 4. Run the actual tool body — idempotently for confirmed, money-moving tools.
  //    A confirmed action keyed on (confirmedActionId + name + input hash) runs
  //    at most once: a replay returns the cached result instead of re-firing.
  let result: unknown;
  if (confirmedActionId && handler.idempotent) {
    const key = toolExecutionKey(confirmedActionId, handler.name, input);
    const claim = await claimToolExecution(key);
    if (claim.cached) return claim.result; // exact replay — do NOT re-run the side effect
    try {
      result = await handler.run(input, ctx);
    } catch (err) {
      await settleToolExecution(key, { ok: false }); // failed → clear claim so a retry can re-drive
      throw err;
    }
    // A tool that returns an error shape is retryable; only cache real successes.
    const isErr = !!(result && typeof result === "object" && (result as { _toolError?: boolean })._toolError);
    await settleToolExecution(key, isErr ? { ok: false } : { ok: true, result });
  } else {
    result = await handler.run(input, ctx);
  }

  // 5. Audit, best-effort (never affects the result or throws out).
  if (handler.audit) {
    try { await handler.audit(input, result, ctx); } catch { /* audit is best-effort */ }
  }

  return result;
}
