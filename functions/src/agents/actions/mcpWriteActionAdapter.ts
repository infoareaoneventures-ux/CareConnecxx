import { z } from "zod";
import { defineCaraAction } from "../actionNative/defineCaraAction";
import { runCaraAction } from "../actionNative/runCaraAction";
import type { CaraActionContext, CaraActionRole } from "../actionNative/caraActionTypes";

const anyObjectOutput = z.object({}).passthrough();
const stringValue = z.string().min(1);

const writeActionConfigs = {
  trigger_emergency_alert: {
    role: "client",
    inputSchema: z.object({ clientId: stringValue }).passthrough(),
    auditType: "emergency_alert_raised",
    targetCollection: "emergency_alerts",
  },
  add_family_member: {
    role: "client",
    inputSchema: z.object({
      seniorId: stringValue,
      clientId: stringValue,
      name: stringValue,
      memberPhone: stringValue,
    }).passthrough(),
    auditType: "family_member_add",
    targetCollection: "family_group_members",
    idempotencyKey: (input: Record<string, unknown>) =>
      `add_family_member:${input.clientId}:${input.seniorId}:${input.memberPhone}`,
  },
  remove_family_member: {
    role: "client",
    inputSchema: z.object({
      seniorId: stringValue,
      clientId: stringValue,
      memberPhone: stringValue,
    }).passthrough(),
    auditType: "family_member_remove",
    targetCollection: "family_group_members",
    idempotencyKey: (input: Record<string, unknown>) =>
      `remove_family_member:${input.clientId}:${input.seniorId}:${input.memberPhone}`,
  },
  accept_shift: {
    role: "caregiver",
    inputSchema: z.object({ phone: stringValue, chatId: stringValue }).passthrough(),
    auditType: "shift_offer_accepted",
    targetCollection: "shift_offers",
  },
  decline_shift: {
    role: "caregiver",
    inputSchema: z.object({ phone: stringValue, chatId: stringValue }).passthrough(),
    auditType: "shift_offer_declined",
    targetCollection: "shift_offers",
  },
  submit_shift_hours: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      appointmentId: stringValue,
      clockInTime: stringValue,
      clockOutTime: stringValue,
    }).passthrough(),
    auditType: "shift_hours_submitted",
    targetCollection: "shiftHours",
    idempotencyKey: (input: Record<string, unknown>) =>
      `submit_shift_hours:${input.caregiverId}:${input.appointmentId}:${input.clockInTime}:${input.clockOutTime}:${input.breakMinutes ?? 0}`,
    failClosed: true,
  },
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
      appointmentId: stringValue,
      decision: z.enum(["accept", "decline"]),
    }).passthrough(),
    auditType: "booking_request_responded",
    targetCollection: "appointments",
    idempotencyKey: (input: Record<string, unknown>) =>
      `respond_to_booking_request:${input.caregiverId}:${input.appointmentId}:${input.decision}`,
  },
  start_shift: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      appointmentId: z.string().optional(),
      shiftId: z.string().optional(),
    }).passthrough().refine(input => !!input.appointmentId || !!input.shiftId, {
      message: "appointmentId or shiftId is required",
    }),
    auditType: "shift_started",
    targetCollection: "appointments",
    idempotencyKey: (input: Record<string, unknown>) =>
      `start_shift:${input.caregiverId}:${input.appointmentId ?? input.shiftId}`,
  },
  complete_shift: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      appointmentId: z.string().optional(),
      shiftId: z.string().optional(),
    }).passthrough().refine(input => !!input.appointmentId || !!input.shiftId, {
      message: "appointmentId or shiftId is required",
    }),
    auditType: "shift_completed",
    targetCollection: "appointments",
    idempotencyKey: (input: Record<string, unknown>) =>
      `complete_shift:${input.caregiverId}:${input.appointmentId ?? input.shiftId}`,
  },
  update_shift_task: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      shiftId: stringValue,
      taskKey: stringValue,
    }).passthrough(),
    auditType: "shift_task_updated",
    targetCollection: "shifts",
    idempotencyKey: (input: Record<string, unknown>) =>
      `update_shift_task:${input.caregiverId}:${input.shiftId}:${input.taskKey}:${input.completed ?? true}`,
  },
  respond_to_shift_hour_correction: {
    role: "caregiver",
    inputSchema: z.object({
      caregiverId: stringValue,
      appointmentId: stringValue,
      decision: z.enum(["accept", "pushback"]),
    }).passthrough(),
    auditType: "shift_hour_correction_responded",
    targetCollection: "shiftHours",
    idempotencyKey: (input: Record<string, unknown>) =>
      `respond_to_shift_hour_correction:${input.caregiverId}:${input.appointmentId}:${input.decision}:${input.message ?? ""}`,
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
  create_support_ticket: {
    role: (input: Record<string, unknown>) => roleFromUserType(input.userType),
    inputSchema: z.object({
      userId: stringValue,
      userType: stringValue,
      subject: stringValue,
      description: stringValue,
    }).passthrough(),
    auditType: "support_ticket_created",
    targetCollection: "support_tickets",
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
  const role = typeof config.role === "function" ? config.role(input) : config.role;
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

  // State-toggling pairs must not outlive the inverse action inside the done
  // TTL: after a successful add, clear remove's settled claim (and vice versa)
  // so add → remove → re-add cycles execute instead of replaying cached success.
  const inverse = INVERSE_ACTION[name];
  if (inverse) {
    const inverseConfig = writeActionConfigs[inverse];
    if ("idempotencyKey" in inverseConfig) {
      const inverseKey = inverseConfig.idempotencyKey(input);
      const { clearCaraActionExecution } = await import("../actionNative/actionExecutionLedger");
      await clearCaraActionExecution(inverseKey).catch(() => {});
    }
  }

  return result;
}

const INVERSE_ACTION: Partial<Record<SupportedMcpWriteAction, SupportedMcpWriteAction>> = {
  add_family_member: "remove_family_member",
  remove_family_member: "add_family_member",
};

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

function roleFromUserType(userType: unknown): CaraActionRole {
  if (userType === "caregiver" || userType === "family" || userType === "admin") return userType;
  return "client";
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
  ]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
