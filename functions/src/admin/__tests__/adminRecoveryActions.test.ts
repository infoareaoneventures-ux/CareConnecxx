import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore mock (mirrors adminExecutionTools.test.ts).
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const added: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
      ref: makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      if (!docs.has(path)) {
        const err: any = new Error(`5 NOT_FOUND: ${path}`);
        err.code = 5;
        throw err;
      }
      const cur = { ...(docs.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && (v as any).__delete) delete cur[k];
        else cur[k] = v;
      }
      docs.set(path, cur);
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${added.length}`}`);
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${added.length}`;
      added.push({ path, data });
      docs.set(`${path}/${id}`, data);
      return { id };
    });
    ref.where = () => ref;
    ref.orderBy = () => ref;
    ref.limit = () => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  const runTransaction = vi.fn(async (fn: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      update: (ref: any, data: any) => ref.update(data),
      set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
    };
    return fn(tx);
  });

  return {
    docs,
    added,
    makeCollRef,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    runTransaction,
    reset: () => {
      docs.clear();
      added.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    delete: () => ({ __delete: true }),
    serverTimestamp: () => "SERVER_TS",
  };
  const firestore: any = () => ({
    collection: hoisted.collectionMock,
    runTransaction: hoisted.runTransaction,
  });
  firestore.FieldValue = FieldValue;
  firestore.Timestamp = {
    fromMillis: (ms: number) => ({ __timestampMillis: ms }),
  };
  return { __esModule: true, default: { firestore }, firestore };
});

vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    __esModule: true,
    default: { https: { onCall: (fn: any) => fn, HttpsError } },
    https: { onCall: (fn: any) => fn, HttpsError },
  };
});

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

const handleToolCall = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../../mcp/server", () => ({ handleToolCall: (...a: any[]) => (handleToolCall as Function).apply(null, a) }));

const sendToPhone = vi.fn(async () => {});
const sendMessage = vi.fn(async () => ({ message_id: "m1" }));
vi.mock("../../linq/client", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendToPhone: (...a: any[]) => (sendToPhone as Function).apply(null, a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: (...a: any[]) => (sendMessage as Function).apply(null, a),
}));

import { logAudit } from "../../observability/auditLog";
// Callables are typed as Firebase HttpsFunction but vi.mock replaces onCall
// with (fn) => fn — direct (data, context) functions at runtime. Cast to any.
import {
  admin_retry_linq_delivery as _arld,
  admin_replay_pending_action as _arpa,
  admin_cancel_pending_action as _acpa,
  admin_assign_recovery_owner as _aaro,
  admin_mark_recovery_complete as _amrc,
} from "../adminRecoveryActions";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_retry_linq_delivery    = _arld  as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_replay_pending_action  = _arpa  as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_cancel_pending_action  = _acpa  as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_assign_recovery_owner  = _aaro  as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_mark_recovery_complete = _amrc  as any;

const adminCtx = { auth: { uid: "admin-1" } } as any;
const userCtx = { auth: { uid: "user-1" } } as any;

function seedAdmin() {
  hoisted.docs.set("users/admin-1", { userType: "admin" });
  hoisted.docs.set("users/user-1", { userType: "client" });
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  seedAdmin();
});

describe("admin_retry_linq_delivery", () => {
  function seedFailedLinqLedger() {
    hoisted.docs.set("agent_action_ledger/led-1", {
      status: "failed",
      userId: "user-1",
      metadata: { chatId: "chat-1", text: "Your appt is confirmed." },
    });
  }

  it("retry success transitions the ledger failed→executed and records delivery", async () => {
    seedFailedLinqLedger();
    const res: any = await admin_retry_linq_delivery({ ledgerId: "led-1", idempotencyKey: "k1" }, adminCtx);
    expect(res.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith("chat-1", "Your appt is confirmed.");
    const saved = hoisted.docs.get("agent_action_ledger/led-1");
    expect(saved.status).toBe("executed");
    expect(saved.deliveredAt).toBeTruthy();
  });

  it("retry failure keeps the ledger failed and creates an admin_alerts doc (AE5)", async () => {
    seedFailedLinqLedger();
    sendMessage.mockRejectedValueOnce(new Error("Linq 503"));
    const res: any = await admin_retry_linq_delivery({ ledgerId: "led-1", idempotencyKey: "k1" }, adminCtx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Linq 503");
    expect(hoisted.docs.get("agent_action_ledger/led-1").status).toBe("failed");
    const alert = hoisted.added.find((a) => a.path === "admin_alerts");
    expect(alert?.data.type).toBe("linq_delivery_retry_failed");
  });

  it("is idempotent — a duplicate key after success is rejected", async () => {
    seedFailedLinqLedger();
    await admin_retry_linq_delivery({ ledgerId: "led-1", idempotencyKey: "k1" }, adminCtx);
    await expect(
      admin_retry_linq_delivery({ ledgerId: "led-1", idempotencyKey: "k1" }, adminCtx),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("denies a non-admin caller", async () => {
    seedFailedLinqLedger();
    await expect(
      admin_retry_linq_delivery({ ledgerId: "led-1", idempotencyKey: "k1" }, userCtx),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

describe("admin_replay_pending_action — high-risk confirmation", () => {
  function seedHighRiskPending() {
    hoisted.docs.set("pending_actions/pa-hr", {
      status: "awaiting",
      toolName: "cancel_job_post",
      toolInput: { jobId: "j1", clientId: "c1" },
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  function seedSafePending() {
    hoisted.docs.set("pending_actions/pa-safe", {
      status: "awaiting",
      toolName: "send_client_message",
      toolInput: { phone: "+1", message: "hi" },
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  it("rejects a high-risk replay without confirmation (tool NOT called)", async () => {
    seedHighRiskPending();
    await expect(
      admin_replay_pending_action({ pendingActionId: "pa-hr", idempotencyKey: "k1", confirm: false }, adminCtx),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(handleToolCall).not.toHaveBeenCalled();
    // still awaiting — the lock was not consumed
    expect(hoisted.docs.get("pending_actions/pa-hr").status).toBe("awaiting");
  });

  it("proceeds for a high-risk replay WITH confirmation", async () => {
    seedHighRiskPending();
    handleToolCall.mockResolvedValueOnce({ success: true });
    const res: any = await admin_replay_pending_action(
      { pendingActionId: "pa-hr", idempotencyKey: "k1", confirm: true },
      adminCtx,
    );
    expect(res.success).toBe(true);
    expect(handleToolCall).toHaveBeenCalledWith("cancel_job_post", {
      jobId: "j1", clientId: "c1",
    });
    expect(hoisted.docs.get("pending_actions/pa-hr").status).toBe("executed");
  });

  it("a safe replay does not require confirmation", async () => {
    seedSafePending();
    handleToolCall.mockResolvedValueOnce({ success: true });
    const res: any = await admin_replay_pending_action(
      { pendingActionId: "pa-safe", idempotencyKey: "k1", confirm: false },
      adminCtx,
    );
    expect(res.success).toBe(true);
    expect(handleToolCall).toHaveBeenCalledTimes(1);
  });

  it("a tool failure surfaces visibly and raises an admin alert", async () => {
    seedSafePending();
    handleToolCall.mockResolvedValueOnce({ _toolError: true, success: false, message: "boom" });
    const res: any = await admin_replay_pending_action(
      { pendingActionId: "pa-safe", idempotencyKey: "k1", confirm: false },
      adminCtx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("boom");
    expect(hoisted.docs.get("pending_actions/pa-safe").status).toBe("failed");
    const alert = hoisted.added.find((a) => a.path === "admin_alerts");
    expect(alert?.data.type).toBe("pending_action_replay_failed");
  });
});

describe("admin_cancel_pending_action", () => {
  it("cancels a stale pending action WITHOUT executing the tool", async () => {
    hoisted.docs.set("pending_actions/pa-1", {
      status: "awaiting",
      toolName: "cancel_appointment",
      toolInput: { appointmentId: "a1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res: any = await admin_cancel_pending_action(
      { pendingActionId: "pa-1", reason: "Stale — family rebooked elsewhere" },
      adminCtx,
    );
    expect(res.success).toBe(true);
    expect(res.executed).toBe(false);
    expect(hoisted.docs.get("pending_actions/pa-1").status).toBe("rejected");
    // The underlying tool must NEVER run on a cancel.
    expect(handleToolCall).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    hoisted.docs.set("pending_actions/pa-1", {
      status: "awaiting",
      toolName: "cancel_appointment",
      toolInput: {},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(
      admin_cancel_pending_action({ pendingActionId: "pa-1", reason: "  " }, adminCtx),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("admin_mark_recovery_complete", () => {
  it("marks a ledger row handled with a reason", async () => {
    hoisted.docs.set("agent_action_ledger/led-1", { status: "failed", userId: "user-1" });
    const res: any = await admin_mark_recovery_complete(
      { ledgerId: "led-1", reason: "Manually re-sent via support" },
      adminCtx,
    );
    expect(res.success).toBe(true);
    const saved = hoisted.docs.get("agent_action_ledger/led-1");
    expect(saved.status).toBe("cancelled");
    expect(saved.handledReason).toContain("Manually re-sent");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "recovery_marked_complete" }),
    );
  });

  it("rejects marking handled without a reason (invalid-argument)", async () => {
    hoisted.docs.set("agent_action_ledger/led-1", { status: "failed" });
    await expect(
      admin_mark_recovery_complete({ ledgerId: "led-1", reason: "" }, adminCtx),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("admin_assign_recovery_owner", () => {
  it("sets an owner on a ledger doc", async () => {
    hoisted.docs.set("agent_action_ledger/led-1", { status: "failed" });
    const res: any = await admin_assign_recovery_owner(
      { ledgerId: "led-1", ownerLabel: "On-call ops" },
      adminCtx,
    );
    expect(res.success).toBe(true);
    expect(hoisted.docs.get("agent_action_ledger/led-1").recoveryOwnerLabel).toBe("On-call ops");
  });

  it("denies a non-admin caller", async () => {
    hoisted.docs.set("agent_action_ledger/led-1", { status: "failed" });
    await expect(
      admin_assign_recovery_owner({ ledgerId: "led-1", ownerLabel: "x" }, userCtx),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});
