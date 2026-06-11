// Unit tests for the webhook exactly-once ledger (claim / settle semantics).

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const makeDocRef = (path: string) => ({
    path,
    create: vi.fn(async (data: any) => {
      if (docs.has(path)) {
        const err: any = new Error("ALREADY_EXISTS");
        err.code = 6;
        throw err;
      }
      docs.set(path, data);
    }),
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    }),
    delete: vi.fn(async () => { docs.delete(path); }),
  });

  const collection = vi.fn((name: string) => ({
    doc: (id: string) => makeDocRef(`${name}/${id}`),
  }));

  const runTransaction = vi.fn(async (fn: any) =>
    fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, data: any) => { docs.set(ref.path, data); },
      update: (ref: any, data: any) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); },
    })
  );

  return { docs, collection, runTransaction };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection, runTransaction: hoisted.runTransaction }) },
  firestore: () => ({ collection: hoisted.collection, runTransaction: hoisted.runTransaction }),
}));

import { claimWebhookEvent, settleWebhookEvent } from "../webhookLedger";

const COLL = "processed_stripe_events";

beforeEach(() => {
  hoisted.docs.clear();
  vi.clearAllMocks();
});

describe("claimWebhookEvent", () => {
  it("claims a never-seen event id", async () => {
    await expect(claimWebhookEvent(COLL, "evt_1")).resolves.toBe("claimed");
    expect(hoisted.docs.get(`${COLL}/evt_1`)).toMatchObject({ status: "processing" });
  });

  it("rejects a duplicate while the first delivery is still in flight", async () => {
    await claimWebhookEvent(COLL, "evt_1");
    await expect(claimWebhookEvent(COLL, "evt_1")).resolves.toBe("duplicate");
  });

  it("rejects a duplicate after the event was settled processed", async () => {
    await claimWebhookEvent(COLL, "evt_1");
    await settleWebhookEvent(COLL, "evt_1", "processed");
    await expect(claimWebhookEvent(COLL, "evt_1")).resolves.toBe("duplicate");
  });

  it("treats legacy ledger docs (processedAt only, no status) as settled", async () => {
    hoisted.docs.set(`${COLL}/evt_old`, { processedAt: "2026-01-01T00:00:00Z" });
    await expect(claimWebhookEvent(COLL, "evt_old")).resolves.toBe("duplicate");
  });

  it("reclaims a stale processing claim (handler crashed without settling)", async () => {
    hoisted.docs.set(`${COLL}/evt_1`, {
      status: "processing",
      claimedAtMs: Date.now() - 11 * 60 * 1000,
    });
    await expect(claimWebhookEvent(COLL, "evt_1")).resolves.toBe("claimed");
    expect(hoisted.docs.get(`${COLL}/evt_1`)).toMatchObject({ reclaimed: true });
  });

  it("fails OPEN when the ledger itself errors — never drops an event", async () => {
    hoisted.docs.set(`${COLL}/evt_1`, { status: "processed" }); // create() will throw exists
    hoisted.runTransaction.mockRejectedValueOnce(new Error("firestore unavailable"));
    await expect(claimWebhookEvent(COLL, "evt_1")).resolves.toBe("claimed");
  });
});

describe("settleWebhookEvent", () => {
  it("'failed' releases the claim so the provider's retry can reprocess", async () => {
    await claimWebhookEvent(COLL, "evt_1");
    await settleWebhookEvent(COLL, "evt_1", "failed");
    expect(hoisted.docs.has(`${COLL}/evt_1`)).toBe(false);
    await expect(claimWebhookEvent(COLL, "evt_1")).resolves.toBe("claimed");
  });

  it("'processed' makes the claim permanent", async () => {
    await claimWebhookEvent(COLL, "evt_1");
    await settleWebhookEvent(COLL, "evt_1", "processed");
    expect(hoisted.docs.get(`${COLL}/evt_1`)).toMatchObject({ status: "processed" });
  });

  it("swallows ledger errors (settle is best-effort)", async () => {
    // No claim exists; force delete to throw.
    const ref = hoisted.collection(COLL).doc("evt_x");
    void ref; // settle builds its own ref — patch collection to throw instead
    hoisted.collection.mockImplementationOnce(() => {
      throw new Error("firestore unavailable");
    });
    await expect(settleWebhookEvent(COLL, "evt_x", "failed")).resolves.toBeUndefined();
  });
});
