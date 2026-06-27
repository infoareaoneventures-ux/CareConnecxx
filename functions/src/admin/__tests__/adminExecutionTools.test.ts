import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore mock shared across the suite.
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
      // Apply FieldValue sentinels + dotted paths shallowly enough for assertions.
      const cur = { ...(docs.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && (v as any).__delete) {
          delete cur[k];
        } else if (v && typeof v === "object" && (v as any).__arrayUnion) {
          cur[k] = [...(Array.isArray(cur[k]) ? cur[k] : []), ...(v as any).__arrayUnion];
        } else {
          cur[k] = v;
        }
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
    makeDocRef,
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
  // Defined inside the factory (hoisting-safe) — see HttpsError note below.
  const FieldValue = {
    delete: () => ({ __delete: true }),
    arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
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
  return {
    __esModule: true,
    default: { firestore },
    firestore,
  };
});

vi.mock("firebase-functions/v1", () => {
  // Defined inside the factory: vi.mock is hoisted to the top of the module, so a
  // top-level `class HttpsError` would not yet be initialized when the factory
  // runs ("Cannot access 'HttpsError' before initialization").
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
vi.mock("../../linq/client", () => ({ sendToPhone: (...a: any[]) => (sendToPhone as Function).apply(null, a) }));

import { logAudit } from "../../observability/auditLog";
// Callables are typed as Firebase HttpsFunction but the vi.mock replaces onCall
// with (fn) => fn, so they are direct (data, context) => Promise functions at
// runtime. Cast to any so TypeScript doesn’t check the Request/Response overload.
import { admin_review_caregiver_exception as _arc, admin_review_document as _ard } from "../adminCaregiverActions";
import { admin_suspend_user as _asu, admin_restore_user as _aru } from "../adminUserActions";
import { admin_respond_support_ticket as _arst, admin_resolve_dispute as _ardp } from "../adminSupportActions";
import { admin_retry_agent_action as _araa } from "../adminLedgerActions";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_review_caregiver_exception = _arc as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_review_document = _ard as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_suspend_user = _asu as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_restore_user = _aru as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_respond_support_ticket = _arst as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_resolve_dispute = _ardp as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin_retry_agent_action = _araa as any;

// Helpers
const adminCtx = { auth: { uid: "admin-1" } } as any;
const userCtx = { auth: { uid: "user-1" } } as any;
const noAuthCtx = {} as any;

function seedAdmin() {
  hoisted.docs.set("users/admin-1", { userType: "admin" });
  hoisted.docs.set("users/user-1", { userType: "client" });
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  seedAdmin();
});

describe("requireAdmin gate", () => {
  it("denies an unauthenticated caller (admin_suspend_user)", async () => {
    await expect(admin_suspend_user({ userId: "x", reason: "y" }, noAuthCtx)).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("denies a non-admin caller (admin_review_caregiver_exception — a mutation)", async () => {
    hoisted.docs.set("caregivers/cg-1", { onboardingStatus: "profile_complete", verificationStatus: "consider" });
    await expect(
      admin_review_caregiver_exception({ caregiverId: "cg-1", decision: "approve" }, userCtx),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

describe("admin_review_caregiver_exception — AE8 bookability gate", () => {
  it("approving a consider does NOT make bookable when onboarding is incomplete", async () => {
    hoisted.docs.set("caregivers/cg-1", {
      onboardingStatus: "incomplete",
      verificationStatus: "consider",
    });
    const res: any = await admin_review_caregiver_exception(
      { caregiverId: "cg-1", decision: "approve" },
      adminCtx,
    );
    expect(res.bookable).toBe(false);
    const saved = hoisted.docs.get("caregivers/cg-1");
    expect(saved.verificationStatus).toBe("approved");
    // status must NOT be flipped to active (not bookable)
    expect(saved.status).toBeUndefined();
    // never fabricates a Checkr clear
    expect(saved.verificationSource).toBe("admin_manual_review");
  });

  it("approving a consider becomes bookable only when policy is fully satisfied", async () => {
    hoisted.docs.set("caregivers/cg-2", {
      onboardingStatus: "profile_complete",
      verificationStatus: "consider",
    });
    const res: any = await admin_review_caregiver_exception(
      { caregiverId: "cg-2", decision: "approve" },
      adminCtx,
    );
    expect(res.bookable).toBe(true);
    expect(hoisted.docs.get("caregivers/cg-2").status).toBe("active");
  });
});

describe("admin_review_document", () => {
  it("approves a specific document", async () => {
    hoisted.docs.set("caregivers/cg-1", {
      documents: { driversLicense: { url: "u", status: "pending" } },
    });
    const res: any = await admin_review_document(
      { caregiverId: "cg-1", documentType: "driversLicense", decision: "approve" },
      adminCtx,
    );
    expect(res.status).toBe("approved");
    expect(hoisted.docs.get("caregivers/cg-1")["documents.driversLicense.status"]).toBe("approved");
  });
});

describe("admin_suspend_user / admin_restore_user", () => {
  it("soft-suspends (no destructive delete) and restores", async () => {
    hoisted.docs.set("users/target", { userType: "client" });
    await admin_suspend_user({ userId: "target", reason: "abuse" }, adminCtx);
    expect(hoisted.docs.get("users/target").accountStatus).toBe("suspended");
    // doc still exists — soft only
    expect(hoisted.docs.has("users/target")).toBe(true);

    await admin_restore_user({ userId: "target" }, adminCtx);
    expect(hoisted.docs.get("users/target").accountStatus).toBe("active");
  });
});

describe("admin_respond_support_ticket — user can read the response", () => {
  it("writes a response the user reads + notifies", async () => {
    hoisted.docs.set("support_tickets/t-1", { userId: "user-1", status: "open" });
    const res: any = await admin_respond_support_ticket(
      { ticketId: "t-1", message: "We refunded you." },
      adminCtx,
    );
    expect(res.success).toBe(true);
    // user-visible response written into the responses subcollection
    const responseWrite = hoisted.added.find((a) => a.path === "support_tickets/t-1/responses");
    expect(responseWrite).toBeTruthy();
    expect(responseWrite!.data.isAdmin).toBe(true);
    expect(responseWrite!.data.message).toBe("We refunded you.");
    // ticket moved to in-progress
    expect(hoisted.docs.get("support_tickets/t-1").status).toBe("in-progress");
  });
});

describe("admin_resolve_dispute", () => {
  it("approves a disputed shift, updates shiftHours + writes audit", async () => {
    hoisted.docs.set("shiftHours/appt-1", {
      status: "disputed_admin_review",
      clientId: "user-1",
      caregiverId: "cg-1",
      payRate: 20,
      submittedTotalHours: 4,
      lineItems: [],
    });
    const res: any = await admin_resolve_dispute(
      { appointmentId: "appt-1", outcome: "approve", finalTotalHours: 3 },
      adminCtx,
    );
    expect(res.success).toBe(true);
    const saved = hoisted.docs.get("shiftHours/appt-1");
    expect(saved.status).toBe("approved");
    expect(saved.finalTotalHours).toBe(3);
    expect(saved.grossPay).toBe(60); // 3h * $20
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "dispute_resolved" }),
    );
  });
});

describe("admin_retry_agent_action — no false success + idempotency", () => {
  function seedFailedLedger() {
    hoisted.docs.set("agent_action_ledger/led-1", {
      status: "failed",
      toolName: "send_client_message",
      replayInput: { phone: "+1", message: "hi" },
      userId: "user-1",
    });
  }

  it("executes the intended tool and marks the ledger executed on success", async () => {
    seedFailedLedger();
    handleToolCall.mockResolvedValueOnce({ success: true });
    const res: any = await admin_retry_agent_action(
      { ledgerId: "led-1", idempotencyKey: "k1" },
      adminCtx,
    );
    expect(res.success).toBe(true);
    expect(handleToolCall).toHaveBeenCalledWith("send_client_message", { phone: "+1", message: "hi" });
    expect(hoisted.docs.get("agent_action_ledger/led-1").status).toBe("executed");
  });

  it("marks the ledger failed and does NOT claim success when the tool fails", async () => {
    seedFailedLedger();
    handleToolCall.mockResolvedValueOnce({ _toolError: true, success: false, message: "Linq down" });
    const res: any = await admin_retry_agent_action(
      { ledgerId: "led-1", idempotencyKey: "k1" },
      adminCtx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("Linq down");
    const saved = hoisted.docs.get("agent_action_ledger/led-1");
    expect(saved.status).toBe("failed");
    expect(saved.retryError).toContain("Linq down");
    // a fresh admin alert surfaces the failure
    const alert = hoisted.added.find((a) => a.path === "admin_alerts");
    expect(alert?.data.type).toBe("agent_action_retry_failed");
  });

  it("is idempotent — a second retry with the same key is rejected (no double-execute)", async () => {
    seedFailedLedger();
    handleToolCall.mockResolvedValueOnce({ success: true });
    await admin_retry_agent_action({ ledgerId: "led-1", idempotencyKey: "k1" }, adminCtx);
    // First retry transitioned it to executed; a duplicate key must be refused
    // AND it would now be terminal-executed regardless.
    await expect(
      admin_retry_agent_action({ ledgerId: "led-1", idempotencyKey: "k1" }, adminCtx),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(handleToolCall).toHaveBeenCalledTimes(1);
  });

  it("does not claim success when the row has no replay payload", async () => {
    hoisted.docs.set("agent_action_ledger/led-2", { status: "failed", userId: "user-1" });
    await expect(
      admin_retry_agent_action({ ledgerId: "led-2", idempotencyKey: "k2" }, adminCtx),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(handleToolCall).not.toHaveBeenCalled();
  });
});
