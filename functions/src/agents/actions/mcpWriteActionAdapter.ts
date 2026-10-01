import { z } from "zod";
import { defineCaraAction } from "../actionNative/defineCaraAction";
import { runCaraAction } from "../actionNative/runCaraAction";
import type { CaraActionContext, CaraActionRole } from "../actionNative/caraActionTypes";

const anyObjectOutput = z.object({}).passthrough();
const stringValue = z.string().min(1);

const writeActionConfigs = {
  review_shift_hours: {
    role: "client",
    // 2026-08-31 (Payments/Timesheets audit): matches reviewShiftHours
    // (functions/src/shiftHours.ts) exactly — action, not decision; a
    // correction is independent start/end times, not a single hours number;
    // accept_counter/escalate added (this tool previously had no way to
    // resolve a caregiver's counter-proposal at all).
    inputSchema: z.object({
      clientId: stringValue,
      appointmentId: stringValue,
      action: z.enum(["approve", "propose_correction", "accept_counter", "escalate"]),
    }).passthrough(),
    auditType: "shift_hours_reviewed",
    targetCollection: "shiftHours",
    idempotencyKey: (input: Record<string, unknown>) =>
      `review_shift_hours:${input.clientId}:${input.appointmentId}:${input.action}:${input.proposedStartTime ?? ""}:${input.proposedEndTime ?? ""}`,
    failClosed: true,
  },
  respond_to_booking_request: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      bookingRequestId: stringValue.optional(),
      number: z.union([z.number(), z.string()]).optional(),
      decision: z.enum(["accept", "decline"]),
    }).passthrough(),
    auditType: "booking_request_responded",
    targetCollection: "booking_requests",
    idempotencyKey: (input: Record<string, unknown>) =>
      `respond_to_booking_request:${input.caregiverId}:${input.bookingRequestId ?? input.number ?? "shown"}:${input.decision}`,
  },
  // The Bookings page's per-visit buttons (agents/inShift.ts, 2026-09-28):
  // shifts only — shiftId optional, today's visit is resolved inside.
  start_shift: {
    role: "caregiver",
    inputSchema: z.object({ caregiverId: stringValue, shiftId: z.string().optional() }).passthrough(),
    auditType: "shift_started",
    targetCollection: "shifts",
    idempotencyKey: (input: Record<string, unknown>) =>
      `start_shift:${input.caregiverId}:${input.shiftId ?? "today"}`,
  },
  complete_shift: {
    role: "caregiver",
    inputSchema: z.object({ caregiverId: stringValue, shiftId: z.string().optional() }).passthrough(),
    auditType: "shift_completed",
    targetCollection: "shifts",
    idempotencyKey: (input: Record<string, unknown>) =>
      `complete_shift:${input.caregiverId}:${input.shiftId ?? "in_progress"}`,
  },
  update_shift_task: {
    role: "caregiver",
    inputSchema: z.object({ caregiverId: stringValue, shiftId: z.string().optional(), taskKey: z.string().optional() }).passthrough(),
    auditType: "shift_task_updated",
    targetCollection: "shifts",
    idempotencyKey: (input: Record<string, unknown>) =>
      `update_shift_task:${input.caregiverId}:${input.shiftId ?? "in_progress"}:${JSON.stringify(input.numbers ?? input.taskKeys ?? input.taskKey ?? "")}:${input.completed ?? "toggle"}`,
  },
  create_caregiver_referral: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      phone: stringValue,
      referredName: stringValue,
      referredPhone: stringValue,
    }).passthrough(),
    auditType: "caregiver_referral_invited",
    targetCollection: "referrals",
    idempotencyKey: (input: Record<string, unknown>) =>
      `create_caregiver_referral:${input.caregiverId}:${input.referredPhone}`,
  },
} as const;

type SupportedMcpWriteAction = keyof typeof writeActionConfigs;

export function isSupportedMcpWriteAction(name: string): name is SupportedMcpWriteAction {
  return name in writeActionConfigs;
}

export async function runMcpWriteCaraAction(
  name: SupportedMcpWriteAction,
  input: Record<string, unknown>,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  const config = writeActionConfigs[name];
  const role: CaraActionRole = config.role;
  const action = defineCaraAction({
    name,
    description: `Execute the ${name} MCP write through Evia's action contract.`,
    // The 15 per-action ZodObjects are a union TS can't unify into one TInput;
    // the adapter already treats parsed input as Record<string, unknown> and
    // the runtime schema (which does the real validation) is unchanged.
    inputSchema: config.inputSchema as z.ZodType<Record<string, unknown>>,
    outputSchema: anyObjectOutput,
    readOnly: false,
    modelVisible: true,
    webVisible: true,
    adminOnly: false,
    publicAllowed: false,
    allowedRoles: [role],
    audit: {
      actionType: config.auditType,
      targetCollection: config.targetCollection,
      targetDocId: (_input, output) => targetDocIdFromResult(output),
    },
    // U5 (R23-R24): generic fresh-read postcondition for adapter-wrapped
    // writes — the written target document must actually exist afterward.
    // Outputs without a recognizable doc id THROW (→ unverifiable/
    // unconfirmed, same claim strength as before), never a false mismatch.
    postcondition: {
      kind: "fresh_read",
      description: `${config.targetCollection}/{id} exists after write`,
      targetRef: (_input, output) => {
        const id = targetDocIdFromResult(output);
        return id ? `${config.targetCollection}/${id}` : undefined;
      },
      verify: async (_input, output, { db }) => {
        const id = targetDocIdFromResult(output);
        if (!id) throw new Error("no target doc id in output — cannot verify");
        const snap = await db.collection(config.targetCollection).doc(id).get();
        return { ok: snap.exists, observed: { exists: snap.exists } };
      },
    },
    idempotencyKey: "idempotencyKey" in config
      ? parsed => config.idempotencyKey(parsed as Record<string, unknown>)
      : undefined,
    failClosed: "failClosed" in config ? config.failClosed : undefined,
    run: execute,
  });

  const result = await runCaraAction(action, input, contextForMcpAction(role, input));

  return result;
}

function contextForMcpAction(role: CaraActionRole, input: Record<string, unknown>): CaraActionContext {
  return {
    caller: "mcp",
    role,
    uid: stringFromInput(input, "clientId") ?? stringFromInput(input, "caregiverId") ?? stringFromInput(input, "userId"),
    phone: stringFromInput(input, "phone") ?? stringFromInput(input, "memberPhone"),
    chatId: stringFromInput(input, "chatId"),
  };
}

function stringFromInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}


function targetDocIdFromResult(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const record = output as Record<string, unknown>;
  for (const key of [
    "ticketId",
    "alertId",
    "appointmentId",
    "shiftId",
    "taskId",
    "referralId",
    "entryId",
    "bookingRequestId", // respond_to_booking_request — 2026-09-28: an unverifiable receipt made the agent ask for confirmation twice
  ]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
