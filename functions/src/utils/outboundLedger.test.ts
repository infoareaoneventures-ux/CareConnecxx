import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared in-memory doc store for the firebase-admin mock.
const h = vi.hoisted(() => {
  const store = new Map<string, { sentAt?: number }>();
  const tx = {
    get: async (ref: { id: string }) => ({ exists: store.has(ref.id), data: () => store.get(ref.id) }),
    set: (ref: { id: string }, data: { sentAt?: number }) => { store.set(ref.id, data); },
  };
  const firestore = () => ({
    collection: () => ({ doc: (id: string) => ({ id }) }),
    runTransaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  });
  return { store, firestore, tx };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: h.firestore },
  firestore: h.firestore,
}));

import { claimOutboundSend } from "./outboundLedger";

const NOW = 1_000_000_000;

beforeEach(() => h.store.clear());

describe("claimOutboundSend", () => {
  it("allows the first send and records it", async () => {
    expect(await claimOutboundSend("+1555", "chat1", "your shift is confirmed", NOW)).toBe(true);
  });

  it("suppresses an identical message to the same chat within the window", async () => {
    await claimOutboundSend("+1555", "chat1", "your shift is confirmed", NOW);
    expect(await claimOutboundSend("+1555", "chat1", "your shift is confirmed", NOW + 5_000)).toBe(false);
  });

  it("allows the same content again after the window", async () => {
    await claimOutboundSend("+1555", "chat1", "checking in", NOW);
    expect(await claimOutboundSend("+1555", "chat1", "checking in", NOW + 61_000)).toBe(true);
  });

  it("allows different content to the same chat (distinct hash)", async () => {
    await claimOutboundSend("+1555", "chat1", "message A", NOW);
    expect(await claimOutboundSend("+1555", "chat1", "message B", NOW + 1_000)).toBe(true);
  });

  it("fails open (allows send) when the transaction errors", async () => {
    const spy = vi.spyOn(h.tx, "get").mockRejectedValueOnce(new Error("firestore down"));
    expect(await claimOutboundSend("+1555", "chat1", "anything", NOW)).toBe(true);
    spy.mockRestore();
  });
});
