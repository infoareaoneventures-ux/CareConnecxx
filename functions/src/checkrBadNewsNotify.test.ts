import { describe, it, expect, vi, beforeEach } from "vitest";

// Fix 3 (caregiver-signup-fixes-2026-07-07): the consider/suspended/disputed
// caregiver notifications are compliance-adjacent and must ALWAYS deliver — they
// must not be droppable (canDrop:false) and must bypass the daily proactive cap
// (urgency:"immediate"). This drives the checkr webhook to the "consider" branch
// and asserts the send carries those flags.

const hoisted = vi.hoisted(() => {
  const sendViaInteractionAgent = vi.fn(async () => {});
  const sendToPhone = vi.fn(async () => "sent");
  const adminAlertAdd = vi.fn(async () => {});
  const caregiverData = { phone: "+15551112222", name: "Jane Doe" };
  // Toggle whether the caregiver has an agent_sessions doc. Session present →
  // interaction agent; absent → sendToPhone fallback.
  const state = { sessionExists: true };

  const genericDoc = () => ({
    get:        vi.fn(async () => ({ exists: true, data: () => ({}) })),
    update:     vi.fn(async () => {}),
    set:        vi.fn(async () => {}),
    collection: vi.fn(() => ({ add: vi.fn(async () => {}), doc: genericDoc })),
  });

  const collectionMock = vi.fn((name: string) => {
    if (name === "caregivers") {
      return {
        where: () => ({ limit: () => ({ get: async () => ({ empty: false, docs: [{ id: "cg-1" }] }) }) }),
        doc:   () => ({
          get:    async () => ({ exists: true, data: () => caregiverData }),
          update: vi.fn(async () => {}),
          collection: vi.fn(() => ({ add: vi.fn(async () => {}), doc: genericDoc })),
        }),
      };
    }
    if (name === "admin_alerts") return { add: (...a: unknown[]) => hoisted.adminAlertAdd(...a) };
    if (name === "agent_sessions") {
      return { doc: () => ({ get: async () => ({ exists: state.sessionExists, data: () => ({}) }), update: vi.fn(async () => {}) }) };
    }
    return { add: vi.fn(async () => {}), doc: genericDoc, where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }), get: async () => ({ empty: true, docs: [] }) }) };
  });

  const claimWebhookEvent = vi.fn(async () => "claimed");
  const settleWebhookEvent = vi.fn(async () => {});

  return { sendViaInteractionAgent, sendToPhone, adminAlertAdd, collectionMock, claimWebhookEvent, settleWebhookEvent, state };
});

vi.mock("firebase-functions/v1", () => {
  const https = {
    onRequest: (handler: unknown) => handler,
    onCall:    (handler: unknown) => handler,
    HttpsError: class extends Error {},
  };
  const runWith = () => ({ https });
  const fn = { https, runWith, config: () => ({}) };
  return { __esModule: true, ...fn, default: fn };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "ts", delete: () => "__delete__", arrayUnion: (...a: unknown[]) => a };
  const firestore: any = () => ({ collection: hoisted.collectionMock });
  firestore.FieldValue = FieldValue;
  return {
    __esModule: true,
    apps: [{}],
    initializeApp: vi.fn(),
    firestore,
    default: { apps: [{}], initializeApp: vi.fn(), firestore },
  };
});

vi.mock("./utils/webhookLedger", () => ({
  CHECKR_EVENTS_COLLECTION: "processed_checkr_events",
  claimWebhookEvent: (...a: unknown[]) => hoisted.claimWebhookEvent(...a),
  settleWebhookEvent: (...a: unknown[]) => hoisted.settleWebhookEvent(...a),
}));

vi.mock("./agents/caraAgent", () => ({
  sendViaInteractionAgent: (...a: unknown[]) => hoisted.sendViaInteractionAgent(...a),
}));

vi.mock("./linq/client", () => ({
  sendToPhone: (...a: unknown[]) => hoisted.sendToPhone(...a),
}));

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Emulator mode skips signature verification (no real webhook secret needed).
  process.env = { ...OLD_ENV, FUNCTIONS_EMULATOR: "true", CHECKR_WEBHOOK_SECRET: "" };
  hoisted.claimWebhookEvent.mockResolvedValue("claimed");
  hoisted.sendToPhone.mockResolvedValue("sent");
  hoisted.state.sessionExists = true;
});

function makeRes() {
  return {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    send: vi.fn(),
    json: vi.fn(),
  };
}

describe("checkrWebhook — bad-news notifications always deliver (Fix 3)", () => {
  it("consider report notifies the caregiver with canDrop:false and immediate urgency", async () => {
    const { checkrWebhook } = await import("./checkr");
    const event = {
      id:   "evt_c1",
      type: "report.completed",
      data: { object: { id: "rep_1", candidate_id: "cand_1", result: "consider" } },
    };
    const req: any = { method: "POST", headers: {}, body: event, rawBody: Buffer.from(JSON.stringify(event)) };
    const res = makeRes();

    await (checkrWebhook as any)(req, res);

    // The caregiver-facing send happened...
    expect(hoisted.sendViaInteractionAgent).toHaveBeenCalled();
    const call = hoisted.sendViaInteractionAgent.mock.calls.find(
      (c) => (c[1] as any)?.sourceAgent === "checkr_status"
    );
    expect(call).toBeTruthy();
    // ...and it cannot be dropped or deferred by the proactive cap.
    expect((call![1] as any).canDrop).toBe(false);
    expect((call![1] as any).urgency).toBe("immediate");
    // Admin alert still written.
    expect(hoisted.adminAlertAdd).toHaveBeenCalled();
  }, 20_000);

  // The fix landed in three branches — each can regress independently.
  it.each([
    ["suspended", "report.suspended", { id: "rep_2", candidate_id: "cand_1", status: "suspended" }],
    ["disputed",  "report.disputed",  { id: "rep_3", candidate_id: "cand_1" }],
  ])("%s report notifies the caregiver with canDrop:false and immediate urgency", async (label, type, object) => {
    const { checkrWebhook } = await import("./checkr");
    const event = { id: `evt_${label}`, type, data: { object } };
    const req: any = { method: "POST", headers: {}, body: event, rawBody: Buffer.from(JSON.stringify(event)) };
    const res = makeRes();

    await (checkrWebhook as any)(req, res);

    const call = hoisted.sendViaInteractionAgent.mock.calls.find(
      (c) => (c[1] as any)?.sourceAgent === "checkr_status"
    );
    expect(call).toBeTruthy();
    expect((call![1] as any).canDrop).toBe(false);
    expect((call![1] as any).urgency).toBe("immediate");
  }, 20_000);
});

describe("checkrWebhook — session-less caregiver fallback (F5)", () => {
  it("falls back to sendToPhone when the caregiver has no agent_sessions doc", async () => {
    hoisted.state.sessionExists = false;
    const { checkrWebhook } = await import("./checkr");
    const event = {
      id:   "evt_nosess",
      type: "report.completed",
      data: { object: { id: "rep_1", candidate_id: "cand_1", result: "consider" } },
    };
    const req: any = { method: "POST", headers: {}, body: event, rawBody: Buffer.from(JSON.stringify(event)) };
    const res = makeRes();

    await (checkrWebhook as any)(req, res);

    // Direct SMS is the only channel that reaches a session-less caregiver.
    expect(hoisted.sendToPhone).toHaveBeenCalledWith("+15551112222", expect.stringContaining("under review"));
    expect(hoisted.sendViaInteractionAgent).not.toHaveBeenCalled();
    // Delivered → no undelivered alert (the review admin_alert is separate).
    const undeliveredAlert = hoisted.adminAlertAdd.mock.calls.find(
      (c) => (c[0] as any)?.type === "bgcheck_notice_undelivered"
    );
    expect(undeliveredAlert).toBeFalsy();
  }, 20_000);

  it("pages ops when the session-less send is not delivered (opt-out / circuit drop)", async () => {
    hoisted.state.sessionExists = false;
    hoisted.sendToPhone.mockResolvedValue("skipped_opt_out");
    const { checkrWebhook } = await import("./checkr");
    const event = {
      id:   "evt_optout",
      type: "report.completed",
      data: { object: { id: "rep_1", candidate_id: "cand_1", result: "consider" } },
    };
    const req: any = { method: "POST", headers: {}, body: event, rawBody: Buffer.from(JSON.stringify(event)) };
    const res = makeRes();

    await (checkrWebhook as any)(req, res);

    const undeliveredAlert = hoisted.adminAlertAdd.mock.calls.find(
      (c) => (c[0] as any)?.type === "bgcheck_notice_undelivered"
    );
    expect(undeliveredAlert).toBeTruthy();
    expect((undeliveredAlert![0] as any).outcome).toBe("skipped_opt_out");
    expect((undeliveredAlert![0] as any).severity).toBe("high");
  }, 20_000);

  it("pages ops when sendToPhone THROWS (chat-creation failure has no dead-letter)", async () => {
    hoisted.state.sessionExists = false;
    hoisted.sendToPhone.mockRejectedValue(new Error("linq down"));
    const { checkrWebhook } = await import("./checkr");
    const event = {
      id:   "evt_throw",
      type: "report.completed",
      data: { object: { id: "rep_1", candidate_id: "cand_1", result: "consider" } },
    };
    const req: any = { method: "POST", headers: {}, body: event, rawBody: Buffer.from(JSON.stringify(event)) };
    const res = makeRes();

    await (checkrWebhook as any)(req, res);

    const undeliveredAlert = hoisted.adminAlertAdd.mock.calls.find(
      (c) => (c[0] as any)?.type === "bgcheck_notice_undelivered"
    );
    expect(undeliveredAlert).toBeTruthy();
    expect((undeliveredAlert![0] as any).outcome).toBe("send_error");
    // The webhook itself must still settle cleanly (miss is paged, not fatal).
    expect(res.statusCode).toBe(200);
  }, 20_000);
});
