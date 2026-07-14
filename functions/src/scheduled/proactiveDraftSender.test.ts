import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks — shared by every test in this file.
const hoisted = vi.hoisted(() => {
  type DraftDoc = {
    id:        string;
    status:    string;
    phone?:    string;
    draftText?: string;
    createdAt?: string;
    sentAt?:   string;
    sendError?: string;
    expiredAt?: string;
    lastAttemptAt?: string;
  };

  const updateMock = vi.fn(async (_patch: Record<string, unknown>) => undefined);
  const sendSMS    = vi.fn<(p: { to: string; message: string }) => Promise<{ success: boolean; error?: string }>>(
    async () => ({ success: true }),
  );

  // Simulated query result. Each test seeds via `setDrafts([...])`.
  let currentDrafts: DraftDoc[] = [];

  const setDrafts = (ds: DraftDoc[]) => { currentDrafts = ds; };

  const docs = () =>
    currentDrafts.map((d) => {
      const patches: Record<string, unknown>[] = [];
      const ref = {
        update: vi.fn(async (patch: Record<string, unknown>) => {
          patches.push(patch);
          await updateMock(patch);
          return undefined;
        }),
        _patches: patches,
        // Carried so the transaction mock's tx.get(ref) can read current state.
        _draft: d,
      };
      return {
        id: d.id,
        data: () => d,
        ref,
      };
    });

  const queryProxy = {
    where:    vi.fn(() => queryProxy),
    orderBy:  vi.fn(() => queryProxy),
    limit:    vi.fn(() => queryProxy),
    get:      vi.fn(async () => ({ docs: docs() })),
  };

  const collectionMock = vi.fn(() => queryProxy);

  // Minimal transaction shim: tx.get(ref) reads the draft the ref carries;
  // tx.update(ref, patch) applies through the same ref.update path so patch
  // assertions (updateMock) still see the claim's status change.
  const runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get:    async (ref: any) => ({ exists: true, data: () => ref._draft }),
      update: (ref: any, patch: Record<string, unknown>) => { void ref.update(patch); },
    };
    return fn(tx);
  });

  return { updateMock, sendSMS, setDrafts, collectionMock, runTransaction };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransaction }) },
  firestore: () => ({ collection: hoisted.collectionMock, runTransaction: hoisted.runTransaction }),
}));
vi.mock("firebase-functions", () => ({
  __esModule: true,
  pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (fn: unknown) => fn }) }) },
  https:  { onCall: (fn: unknown) => fn, HttpsError: class {} },
}));
vi.mock("../sms", () => ({
  sendSMS: (...args: unknown[]) => hoisted.sendSMS(...(args as [{ to: string; message: string }])),
}));

import { _internal } from "./proactiveDraftSender";
const { runProactiveDraftSenderPass } = _internal;

describe("proactiveDraftSender", () => {
  beforeEach(() => {
    hoisted.updateMock.mockClear();
    hoisted.sendSMS.mockClear();
    hoisted.sendSMS.mockResolvedValue({ success: true });
  });

  it("sends each approved draft and transitions to 'sent'", async () => {
    hoisted.setDrafts([
      { id: "d1", status: "approved", phone: "+15551110001", draftText: "first", createdAt: new Date().toISOString() },
      { id: "d2", status: "approved", phone: "+15551110002", draftText: "second", createdAt: new Date().toISOString() },
    ]);

    const stats = await runProactiveDraftSenderPass();
    expect(stats).toEqual({ scanned: 2, sent: 2, failed: 0, expired: 0 });
    expect(hoisted.sendSMS).toHaveBeenCalledTimes(2);
    expect(hoisted.updateMock).toHaveBeenCalledWith(expect.objectContaining({ status: "sent" }));
  });

  it("marks send failures with status=send_failed and stores the error", async () => {
    hoisted.sendSMS.mockResolvedValueOnce({ success: false, error: "circuit open" });

    hoisted.setDrafts([
      { id: "d1", status: "approved", phone: "+15551110001", draftText: "boom", createdAt: new Date().toISOString() },
    ]);

    const stats = await runProactiveDraftSenderPass();
    expect(stats).toEqual({ scanned: 1, sent: 0, failed: 1, expired: 0 });
    expect(hoisted.updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "send_failed",
      sendError: "circuit open",
    }));
  });

  it("expires drafts older than 24h instead of sending", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    hoisted.setDrafts([
      { id: "d1", status: "approved", phone: "+15551110001", draftText: "stale", createdAt: twoDaysAgo },
    ]);

    const stats = await runProactiveDraftSenderPass();
    expect(stats).toEqual({ scanned: 1, sent: 0, failed: 0, expired: 1 });
    expect(hoisted.sendSMS).not.toHaveBeenCalled();
    expect(hoisted.updateMock).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }));
  });

  it("flags malformed drafts (missing phone or draftText) as send_failed", async () => {
    hoisted.setDrafts([
      { id: "d1", status: "approved", draftText: "no phone", createdAt: new Date().toISOString() },
      { id: "d2", status: "approved", phone: "+15551110002", createdAt: new Date().toISOString() },
    ]);

    const stats = await runProactiveDraftSenderPass();
    expect(stats.scanned).toBe(2);
    expect(stats.failed).toBe(2);
    expect(hoisted.sendSMS).not.toHaveBeenCalled();
  });

  it("catches sendSMS throws and marks the draft failed", async () => {
    hoisted.sendSMS.mockRejectedValueOnce(new Error("net down"));
    hoisted.setDrafts([
      { id: "d1", status: "approved", phone: "+15551110001", draftText: "x", createdAt: new Date().toISOString() },
    ]);

    const stats = await runProactiveDraftSenderPass();
    expect(stats.failed).toBe(1);
    expect(hoisted.updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "send_failed",
      sendError: "net down",
    }));
  });

  it("returns zero stats when no approved drafts exist", async () => {
    hoisted.setDrafts([]);
    const stats = await runProactiveDraftSenderPass();
    expect(stats).toEqual({ scanned: 0, sent: 0, failed: 0, expired: 0 });
    expect(hoisted.sendSMS).not.toHaveBeenCalled();
  });
});
