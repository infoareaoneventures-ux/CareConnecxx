import { describe, it, expect, vi, beforeEach } from "vitest";

// runTool's only impure dependency is the confirmation gate (pendingActions).
// Mock it so we can drive the high-risk branch deterministically; everything
// else is pure orchestration tested through fake ToolHandlers.
const gate = vi.hoisted(() => ({
  isHighRisk: vi.fn().mockReturnValue(false),
  proposePendingAction: vi.fn().mockResolvedValue({ id: "pa_1", preview: "Cancel appointment?" }),
  buildPendingActionStub: vi.fn().mockReturnValue({ _pendingAction: true, actionId: "pa_1" }),
}));
vi.mock("../../agents/pendingActions", () => gate);

import { runTool, toolError, ToolHandler, RunToolContext } from "../runTool";

const ctx: RunToolContext = { phone: "+15125550123", chatId: "c1", userId: "u1", actor: "client" };

function tool(over: Partial<ToolHandler> = {}): ToolHandler {
  return {
    name: "get_thing",
    run: vi.fn().mockResolvedValue({ success: true, value: 42 }),
    ...over,
  };
}

describe("runTool", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // gate mocks are hoisted/shared — clear call history between tests
    gate.isHighRisk.mockReturnValue(false);
    gate.proposePendingAction.mockResolvedValue({ id: "pa_1", preview: "Cancel appointment?" });
    gate.buildPendingActionStub.mockReturnValue({ _pendingAction: true, actionId: "pa_1" });
  });

  it("injects session fields into the tool input (clientId + userId from userId)", async () => {
    const run = vi.fn().mockResolvedValue({ success: true });
    await runTool(tool({ run }), { foo: "bar" }, ctx);
    const received = run.mock.calls[0][0];
    expect(received).toMatchObject({ foo: "bar", phone: "+15125550123", chatId: "c1", clientId: "u1", userId: "u1" });
  });

  it("respects the injects allow-list", async () => {
    const run = vi.fn().mockResolvedValue({ success: true });
    await runTool(tool({ run, injects: ["phone"] }), {}, ctx);
    const received = run.mock.calls[0][0];
    expect(received.phone).toBe("+15125550123");
    expect(received.chatId).toBeUndefined();
    expect(received.userId).toBeUndefined();
  });

  it("ownership deny short-circuits — run is never called", async () => {
    const run = vi.fn();
    const ownership = vi.fn().mockResolvedValue(toolError("PERMISSION_DENIED", "not yours"));
    const result = await runTool(tool({ run, ownership }), {}, ctx);
    expect(result).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("high-risk + unconfirmed → proposes a pending action, run not called", async () => {
    gate.isHighRisk.mockReturnValue(true);
    const run = vi.fn();
    const result = await runTool(tool({ name: "cancel_appointment", run }), {}, ctx);
    expect(gate.proposePendingAction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ _pendingAction: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("high-risk without a phone is refused, never proposed", async () => {
    gate.isHighRisk.mockReturnValue(true);
    const run = vi.fn();
    const result = await runTool(tool({ name: "cancel_appointment", run }), {}, { actor: "client" });
    expect(result).toMatchObject({ _toolError: true, code: "PERMISSION_DENIED" });
    expect(gate.proposePendingAction).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("high-risk + confirmed (_confirmedActionId) runs once, and strips the marker", async () => {
    gate.isHighRisk.mockReturnValue(true);
    const run = vi.fn().mockResolvedValue({ success: true });
    await runTool(tool({ name: "cancel_appointment", run }), { _confirmedActionId: "pa_1" }, ctx);
    expect(gate.proposePendingAction).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]._confirmedActionId).toBeUndefined();
  });

  it("audit fires after a successful run, with input + result", async () => {
    const audit = vi.fn();
    const run = vi.fn().mockResolvedValue({ success: true, value: 7 });
    await runTool(tool({ run, audit }), { a: 1 }, ctx);
    expect(audit).toHaveBeenCalledOnce();
    const [auditInput, auditResult] = audit.mock.calls[0];
    expect(auditInput).toMatchObject({ a: 1 });
    expect(auditResult).toMatchObject({ value: 7 });
  });

  it("a throwing audit never affects the returned result", async () => {
    const audit = vi.fn().mockRejectedValue(new Error("audit sink down"));
    const result = await runTool(tool({ audit }), {}, ctx);
    expect(result).toMatchObject({ success: true, value: 42 });
  });

  it("returns the run result unchanged for a non-high-risk read tool", async () => {
    const result = await runTool(tool(), {}, ctx);
    expect(result).toEqual({ success: true, value: 42 });
    expect(gate.proposePendingAction).not.toHaveBeenCalled();
  });
});
