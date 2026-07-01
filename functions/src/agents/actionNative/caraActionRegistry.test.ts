import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { defineCaraAction } from "./defineCaraAction";
import { CaraActionRegistry } from "./caraActionRegistry";
import {
  CaraActionAccessError,
  CaraActionApprovalRequiredError,
  CaraActionInProgressError,
  CaraActionValidationError,
  createApprovalKey,
  runCaraAction,
} from "./runCaraAction";
import { setCaraActionExecutionStoreForTest } from "./actionExecutionLedger";

const logAgentAction = vi.fn(async () => undefined);

vi.mock("../../observability/actionLedger", () => ({
  logAgentAction: (...args: unknown[]) => logAgentAction(...args),
}));

beforeEach(() => {
  logAgentAction.mockClear();
  setCaraActionExecutionStoreForTest(null);
});

describe("defineCaraAction", () => {
  it("requires name, description, schemas, and run", () => {
    expect(() => defineCaraAction({} as any)).toThrow(/name is required/);
    expect(() => defineCaraAction({ name: "x" } as any)).toThrow(/description is required/);
    expect(() => defineCaraAction({ name: "x", description: "x" } as any)).toThrow(/inputSchema is required/);
  });

  it("defaults visibility flags without installing Agent-Native runtime", () => {
    const action = defineCaraAction({
      name: "get_status",
      description: "Read status",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      readOnly: true,
      modelVisible: true,
      webVisible: true,
      adminOnly: false,
      publicAllowed: false,
      run: async () => ({ ok: true }),
    });

    expect(action.modelVisible).toBe(true);
    expect(action.webVisible).toBe(true);
    expect(action.publicAllowed).toBe(false);
  });
});

describe("CaraActionRegistry", () => {
  it("rejects duplicate names and filters by caller/role", () => {
    const registry = new CaraActionRegistry();
    const clientAction = defineCaraAction({
      name: "send_setup_link",
      description: "Send setup link",
      inputSchema: z.object({ clientId: z.string() }),
      outputSchema: z.object({ sent: z.boolean() }),
      readOnly: false,
      modelVisible: true,
      webVisible: true,
      adminOnly: false,
      publicAllowed: false,
      allowedRoles: ["client", "admin"],
      run: async () => ({ sent: true }),
    });
    const adminAction = defineCaraAction({
      name: "admin_replay_action",
      description: "Replay an action",
      inputSchema: z.object({ ledgerId: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      readOnly: false,
      modelVisible: false,
      webVisible: false,
      adminOnly: true,
      publicAllowed: false,
      run: async () => ({ ok: true }),
    });

    registry.register(clientAction);
    registry.register(adminAction);

    expect(() => registry.register(clientAction)).toThrow(/duplicate action/);
    expect(registry.visibleFor({ caller: "sms_agent", role: "client" }).map(a => a.name)).toEqual(["send_setup_link"]);
    expect(registry.visibleFor({ caller: "admin", role: "admin" }).map(a => a.name)).toEqual(["admin_replay_action", "send_setup_link"]);
  });

  it("fails health checks for public mutating actions and oversized model surfaces", () => {
    const registry = new CaraActionRegistry();
    registry.register(defineCaraAction({
      name: "unsafe_public_write",
      description: "Unsafe public write",
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      readOnly: false,
      modelVisible: true,
      webVisible: true,
      adminOnly: false,
      publicAllowed: true,
      run: async () => ({ ok: true }),
    }));

    expect(() => registry.assertHealthy()).toThrow(/public action .* must be readOnly/);
    expect(() => registry.assertHealthy(0)).toThrow(/model-visible action surface too large/);
  });
});

describe("runCaraAction", () => {
  const action = defineCaraAction({
    name: "send_setup_link",
    description: "Send setup link",
    inputSchema: z.object({ clientId: z.string(), url: z.string().url() }),
    outputSchema: z.object({ sent: z.boolean(), messageId: z.string() }),
    readOnly: false,
    modelVisible: true,
    webVisible: true,
    adminOnly: false,
    publicAllowed: false,
    allowedRoles: ["client", "admin"],
    audit: { actionType: "setup_link_sent", targetCollection: "agent_action_ledger" },
    run: async input => ({ sent: true, messageId: `msg-${input.clientId}` }),
  });

  it("validates input and output and writes confirmed/executed ledger entries", async () => {
    const result = await runCaraAction(
      action,
      { clientId: "c1", url: "https://careconnex.example/setup" },
      { caller: "sms_agent", role: "client", uid: "c1", phone: "+15550001111" },
    );

    expect(result).toEqual({ sent: true, messageId: "msg-c1" });
    expect(logAgentAction).toHaveBeenCalledTimes(2);
    expect(logAgentAction.mock.calls[0][0]).toMatchObject({ status: "confirmed", toolName: "send_setup_link" });
    expect(logAgentAction.mock.calls[1][0]).toMatchObject({ status: "executed", toolName: "send_setup_link" });
  });

  it("rejects invalid input and unauthorized roles", async () => {
    await expect(runCaraAction(
      action,
      { clientId: "c1", url: "not-a-url" },
      { caller: "sms_agent", role: "client" },
    )).rejects.toBeInstanceOf(CaraActionValidationError);

    await expect(runCaraAction(
      action,
      { clientId: "c1", url: "https://careconnex.example/setup" },
      { caller: "sms_agent", role: "caregiver" },
    )).rejects.toBeInstanceOf(CaraActionAccessError);
  });

  it("fails closed when approval is required and emits proposed ledger state", async () => {
    const approvalAction = defineCaraAction({
      ...action,
      name: "refund_payment",
      approvalRequired: true,
    });
    const input = { clientId: "c1", url: "https://careconnex.example/refund" };
    const ctx = { caller: "admin" as const, role: "admin", uid: "admin1" };
    const approvalKey = createApprovalKey("refund_payment", input, ctx);

    await expect(runCaraAction(approvalAction, input, ctx)).rejects.toMatchObject({
      approvalKey,
    });
    await expect(runCaraAction(approvalAction, input, {
      ...ctx,
      approvedActionKeys: [approvalKey],
    })).resolves.toMatchObject({ sent: true });
    expect(logAgentAction.mock.calls[0][0]).toMatchObject({ status: "proposed", toolName: "refund_payment" });
  });

  it("returns cached output and blocks duplicate mutating actions with the same idempotency key", async () => {
    const stored = new Map<string, unknown>();
    setCaraActionExecutionStoreForTest({
      claim: async key => stored.has(key)
        ? { cached: true, result: stored.get(key) }
        : { cached: false },
      settle: async (key, outcome) => {
        if (outcome.ok) stored.set(key, outcome.result);
      },
    });
    const run = vi.fn(async () => ({ sent: true, messageId: "msg-cached" }));
    const duplicateAction = defineCaraAction({
      ...action,
      run,
      idempotencyKey: input => `setup:${input.clientId}:${input.url}`,
    });
    const input = { clientId: "c1", url: "https://careconnex.example/setup" };
    const ctx = { caller: "sms_agent" as const, role: "client", uid: "c1" };

    await expect(runCaraAction(duplicateAction, input, ctx)).resolves.toEqual({ sent: true, messageId: "msg-cached" });
    await expect(runCaraAction(duplicateAction, input, ctx)).resolves.toEqual({ sent: true, messageId: "msg-cached" });

    expect(run).toHaveBeenCalledTimes(1);
    expect(logAgentAction.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "duplicate_blocked",
      toolName: "send_setup_link",
    });
  });

  it("fails closed while a mutating action with the same idempotency key is still running", async () => {
    let claimed = false;
    let settled = false;
    setCaraActionExecutionStoreForTest({
      claim: async () => {
        if (settled) return { cached: true, result: { sent: true, messageId: "msg-running" } };
        if (claimed) return { inProgress: true };
        claimed = true;
        return { cached: false };
      },
      settle: async (_key, outcome) => {
        if (outcome.ok) settled = true;
      },
    });

    let releaseRun!: () => void;
    const runStarted = new Promise<void>(resolve => {
      releaseRun = resolve;
    });
    let finishRun!: () => void;
    const finish = new Promise<void>(resolve => {
      finishRun = resolve;
    });
    const run = vi.fn(async () => {
      releaseRun();
      await finish;
      return { sent: true, messageId: "msg-running" };
    });
    const duplicateAction = defineCaraAction({
      ...action,
      run,
      idempotencyKey: input => `setup:${input.clientId}:${input.url}`,
    });
    const input = { clientId: "c1", url: "https://careconnex.example/setup" };
    const ctx = { caller: "sms_agent" as const, role: "client", uid: "c1" };

    const first = runCaraAction(duplicateAction, input, ctx);
    await runStarted;

    await expect(runCaraAction(duplicateAction, input, ctx)).rejects.toBeInstanceOf(CaraActionInProgressError);
    finishRun();
    await expect(first).resolves.toEqual({ sent: true, messageId: "msg-running" });

    expect(run).toHaveBeenCalledTimes(1);
    expect(logAgentAction.mock.calls.some(call =>
      call[0].status === "duplicate_blocked" &&
      call[0].metadata?.reason === "in_progress",
    )).toBe(true);
  });
});
