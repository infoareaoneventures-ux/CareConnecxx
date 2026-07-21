import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Firestore with transactional get/set/merge + doc().update, enough to
// exercise the provider-message map's convergence + idempotency logic.
const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const DELETE = { __fvDelete: true };
  const merge = (path: string, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    const base = opts?.merge ? { ...(docs.get(path) ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete base[k];
      else base[k] = v;
    }
    docs.set(path, base);
  };
  const makeRef = (path: string) => ({
    path,
    update: async (data: Record<string, unknown>) => {
      if (!docs.has(path)) throw new Error("NOT_FOUND");
      merge(path, data, { merge: true });
    },
  });
  const dbObj = {
    collection: (name: string) => ({ doc: (id: string) => makeRef(`${name}/${id}`) }),
    doc: (path: string) => makeRef(path),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: async (ref: any) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => merge(ref.path, data, opts),
      };
      return fn(tx);
    },
  };
  return { docs, dbObj, DELETE };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => h.dbObj, {
    Timestamp: { fromMillis: (ms: number) => ({ __ts: true, toMillis: () => ms }) },
    FieldValue: { delete: () => h.DELETE },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  providerMessageDocId,
  registerSentProviderMessage,
  applyProviderReceipt,
  applyProviderEdit,
} from "../providerMessageIndex";

const PID = "prov-msg-1";
const REF = "agent_conversations/+14085550001/messages/m1";
const mapPath = () => `linq_message_index/${providerMessageDocId(PID)}`;

beforeEach(() => {
  h.docs.clear();
  h.docs.set(REF, { role: "assistant", content: "hi" });
});

describe("providerMessageDocId", () => {
  it("hashes scope+id — no raw provider id in the key", () => {
    const id = providerMessageDocId(PID);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(PID);
  });
});

describe("send-first flow", () => {
  it("registers refs, then a delivery receipt lands on the canonical row", async () => {
    await registerSentProviderMessage(PID, [REF]);
    const res = await applyProviderReceipt(PID, "delivered", "2026-07-20T00:00:00Z");
    expect(res.resolved).toBe(true);
    expect(h.docs.get(REF)).toMatchObject({ deliveredAt: "2026-07-20T00:00:00Z" });
    // Map entry stores refs + resolved, never message text or raw id.
    const entry = h.docs.get(mapPath())!;
    expect(entry.refs).toEqual([REF]);
    expect(entry.resolved).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("hi");
    expect(JSON.stringify(entry)).not.toContain(PID);
  });

  it("delivery receipts are idempotent", async () => {
    await registerSentProviderMessage(PID, [REF]);
    await applyProviderReceipt(PID, "delivered", "t1");
    await applyProviderReceipt(PID, "delivered", "t2");
    expect(h.docs.get(REF)).toMatchObject({ deliveredAt: "t2" });
  });
});

describe("webhook-first flow (race)", () => {
  it("buffers a receipt before registration, then registration applies it", async () => {
    // Webhook wins the race — no refs yet.
    const first = await applyProviderReceipt(PID, "delivered", "t0");
    expect(first.resolved).toBe(false);
    expect(h.docs.get(REF)).not.toHaveProperty("deliveredAt");
    const entry = h.docs.get(mapPath())!;
    expect(entry.resolved).toBe(false);
    expect(entry.bufferedStatus).toBe("delivered");

    // Send-side registration converges on the same hash and applies the buffered status.
    await registerSentProviderMessage(PID, [REF]);
    expect(h.docs.get(REF)).toMatchObject({ deliveredAt: "t0" });
    expect(h.docs.get(mapPath())!.resolved).toBe(true);
  });

  it("consumes the buffered status on registration — a re-registration cannot re-apply a stale receipt", async () => {
    await applyProviderReceipt(PID, "delivered", "t0"); // webhook-first buffer
    await registerSentProviderMessage(PID, [REF]);      // applies t0, consumes buffer
    expect(h.docs.get(mapPath())).not.toHaveProperty("bufferedStatus");
    expect(h.docs.get(mapPath())).not.toHaveProperty("bufferedAt");

    await applyProviderReceipt(PID, "delivered", "t2"); // newer receipt on resolved entry
    await registerSentProviderMessage(PID, [REF]);      // retried send re-registers same id
    // The stale t0 must NOT overwrite t2.
    expect(h.docs.get(REF)).toMatchObject({ deliveredAt: "t2" });
  });
});

describe("failed receipts", () => {
  it("stamps failedAt on the canonical row via the map", async () => {
    await registerSentProviderMessage(PID, [REF]);
    const res = await applyProviderReceipt(PID, "failed", "f1");
    expect(res.resolved).toBe(true);
    expect(h.docs.get(REF)).toMatchObject({ failedAt: "f1" });
  });
});

describe("edits", () => {
  it("applies an edit to the canonical row when resolved", async () => {
    await registerSentProviderMessage(PID, [REF]);
    const res = await applyProviderEdit(PID, "edited text", "e1");
    expect(res.resolved).toBe(true);
    expect(h.docs.get(REF)).toMatchObject({ editedText: "edited text", editedAt: "e1" });
  });

  it("does not store edited text in the map when unresolved (no history mutation)", async () => {
    const res = await applyProviderEdit(PID, "secret edit", "e0");
    expect(res.resolved).toBe(false);
    expect(h.docs.get(REF)).not.toHaveProperty("editedText");
    const entry = h.docs.get(mapPath())!;
    expect(JSON.stringify(entry)).not.toContain("secret edit");
    expect(entry.editedAt).toBe("e0");
  });
});

describe("multipart", () => {
  it("several provider ids can reference the same canonical row", async () => {
    await registerSentProviderMessage("p1", [REF]);
    await registerSentProviderMessage("p2", [REF]);
    await applyProviderReceipt("p1", "delivered", "t1");
    await applyProviderReceipt("p2", "delivered", "t2");
    expect(h.docs.get(REF)).toMatchObject({ deliveredAt: "t2" });
    expect(h.docs.has(`linq_message_index/${providerMessageDocId("p1")}`)).toBe(true);
    expect(h.docs.has(`linq_message_index/${providerMessageDocId("p2")}`)).toBe(true);
  });
});

describe("guards", () => {
  it("no-ops without a provider id or refs", async () => {
    expect((await applyProviderReceipt("", "delivered")).resolved).toBe(false);
    await registerSentProviderMessage(PID, []); // no refs → no entry
    expect(h.docs.has(mapPath())).toBe(false);
  });
});
