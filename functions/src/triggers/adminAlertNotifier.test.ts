import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const queueGet = vi.fn();
  const queueSet = vi.fn();
  const queueDoc = vi.fn(() => ({ get: queueGet, set: queueSet }));
  const collection = vi.fn(() => ({ doc: queueDoc }));
  return {
    queueGet,
    queueSet,
    queueDoc,
    collection,
    sendEmail: vi.fn(),
    sendToPhone: vi.fn(),
  };
});

vi.mock("firebase-admin", () => ({
  apps: [{}],
  firestore: () => ({ collection: mocks.collection }),
}));
vi.mock("../email", () => ({ sendTransactionalEmail: mocks.sendEmail }));
vi.mock("../linq/client", () => ({ sendToPhone: mocks.sendToPhone }));

import { handleAdminAlertCreated } from "./adminAlertNotifier";

const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ORIGINAL_ADMIN_PHONE = process.env.ADMIN_PHONE;

function makeSnap(alert: Record<string, unknown>) {
  return {
    data: () => alert,
    ref: { update: vi.fn().mockResolvedValue(undefined) },
  };
}

async function runTrigger(
  alert: Record<string, unknown>,
  alertId = "alert-123"
) {
  const snap = makeSnap(alert);
  await handleAdminAlertCreated(snap, { params: { alertId } });
  return snap;
}

describe("onAdminAlertCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAIL = "ops@example.com";
    process.env.ADMIN_PHONE = "+15559990000";
    mocks.queueGet.mockResolvedValue({ exists: false, data: () => undefined });
    mocks.queueSet.mockResolvedValue(undefined);
    mocks.sendEmail.mockResolvedValue({ id: "email-provider-id" });
    mocks.sendToPhone.mockResolvedValue("sent");
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_PHONE === undefined) delete process.env.ADMIN_PHONE;
    else process.env.ADMIN_PHONE = ORIGINAL_ADMIN_PHONE;
  });

  it("directly sends email and SMS and records provider outcomes", async () => {
    const snap = await runTrigger({
      type: "missing_emergency_contact",
      priority: "critical",
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(mocks.queueDoc).toHaveBeenCalledWith("alert-123");
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@example.com",
        subject: expect.stringContaining("missing_emergency_contact"),
        text: expect.stringContaining("Alert ID: alert-123"),
      })
    );
    expect(mocks.sendToPhone).toHaveBeenCalledWith(
      "+15559990000",
      expect.stringContaining("missing_emergency_contact"),
      { source: "admin_alert_notifier" }
    );
    expect(mocks.queueSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sent: true,
        deliveryState: "sent",
        providerMessageId: "email-provider-id",
      }),
      { merge: true }
    );
    expect(snap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({
        emailSent: true,
        emailDeliveryState: "sent",
      })
    );
    expect(snap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({
        smsSent: true,
        smsDeliveryState: "sent",
      })
    );
  });

  it("escapes alert data before placing it in HTML", async () => {
    await runTrigger({
      type: "qa_loop_exhausted",
      priority: "high",
      message: "<script>alert('x')</script>",
    });

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.text).toContain("<script>");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("a family emergency texts the on-call phone with the caregiver outcome (email alone is not a page)", async () => {
    await runTrigger({ type: "family_emergency", severity: "critical", source: "site", caregiverNotified: false, note: "Mom fell" });
    expect(mocks.sendToPhone).toHaveBeenCalledWith(
      "+15559990000",
      expect.stringContaining("FAMILY EMERGENCY"),
      expect.anything(),
    );
    expect(String(mocks.sendToPhone.mock.calls[0][1])).toContain("could NOT be reached");
    expect(String(mocks.sendToPhone.mock.calls[0][1])).toContain("Mom fell");
  });

  it("notifies for canonical alerts that use severity instead of priority", async () => {
    await runTrigger({ type: "provider_failure", severity: "critical" });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toContain("critical priority");
    expect(mocks.sendToPhone).not.toHaveBeenCalled();
  });

  it("does not resend email when the deterministic audit record is already sent", async () => {
    mocks.queueGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ sent: true }),
    });

    await runTrigger({ type: "qa_loop_exhausted", priority: "high" });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.queueSet).not.toHaveBeenCalled();
  });

  it("records email and SMS failures without allowing one to block the other", async () => {
    mocks.sendEmail.mockRejectedValueOnce(new Error("resend unavailable"));
    mocks.sendToPhone.mockRejectedValueOnce(new Error("linq unavailable"));

    const snap = await runTrigger({
      type: "background_check_expired",
      priority: "critical",
    });

    expect(mocks.sendToPhone).toHaveBeenCalledTimes(1);
    expect(mocks.queueSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sent: false,
        deliveryState: "failed",
        lastError: "resend unavailable",
      }),
      { merge: true }
    );
    expect(snap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDeliveryState: "failed",
        emailLastError: "resend unavailable",
      })
    );
    expect(snap.ref.update).toHaveBeenCalledWith(
      expect.objectContaining({
        smsDeliveryState: "failed",
        smsLastError: "linq unavailable",
      })
    );
  });

  it("does not notify for alerts below the threshold", async () => {
    await runTrigger({ type: "informational", priority: "medium" });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendToPhone).not.toHaveBeenCalled();
    expect(mocks.queueDoc).not.toHaveBeenCalled();
  });
});
