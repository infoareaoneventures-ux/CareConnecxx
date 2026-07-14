import type { z } from "zod";

export type CaraActionCaller =
  | "sms_agent"
  | "web_chat"
  | "admin"
  | "mcp"
  | "scheduler"
  | "webhook"
  | "system";

export type CaraActionRole =
  | "client"
  | "caregiver"
  | "family"
  | "admin"
  | "system"
  | string;

export interface CaraActionContext {
  caller: CaraActionCaller;
  role: CaraActionRole;
  uid?: string;
  phone?: string;
  chatId?: string;
  sessionId?: string;
  requestId?: string;
  sourceMessageId?: string;
  approvedActionKeys?: string[];
  scope?: Record<string, unknown>;
}

export interface CaraActionAuditConfig {
  actionType: string;
  targetCollection?: string;
  targetDocId?: (input: unknown, output?: unknown) => string | undefined;
}

export interface CaraActionDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  readOnly: boolean;
  modelVisible: boolean;
  webVisible: boolean;
  adminOnly: boolean;
  publicAllowed: boolean;
  approvalRequired?: boolean | ((input: TInput, ctx: CaraActionContext) => boolean | Promise<boolean>);
  audit?: CaraActionAuditConfig;
  idempotencyKey?: (input: TInput, ctx: CaraActionContext) => string | undefined;
  /** Money-adjacent actions refuse to run when the duplicate-protection claim
   *  cannot be verified (ledger infra error), instead of failing open. */
  failClosed?: boolean;
  allowedRoles?: CaraActionRole[];
  run: (input: TInput, ctx: CaraActionContext) => Promise<TOutput> | TOutput;
}

export type CaraActionInput<TAction> =
  TAction extends CaraActionDefinition<infer TInput, unknown> ? TInput : never;

export type CaraActionOutput<TAction> =
  TAction extends CaraActionDefinition<unknown, infer TOutput> ? TOutput : never;
