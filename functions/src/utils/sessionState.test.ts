import { describe, it, expect, vi } from "vitest";
import {
  claimInboundProcessing,
  releaseInboundProcessing,
  INBOUND_LOCK_TTL_MS,
  isFlowStale,
} from "./sessionState";

// Minimal Firestore double exposing just runTransaction + doc().delete().
function makeDb(initial?: { lockedAt?: number }) {
  let stored: { lockedAt?: number } | undefined = initial;
  const set = vi.fn((_ref: unknown, data: { lockedAt?: number }) => { stored = data; });
  const del = vi.fn(async () => { stored = undefined; });
  const tx = {
    get: async () => ({ exists: stored !== undefined, data: () => stored }),
    set,
  };
  const db = {
    collection: () => ({ doc: () => ({ delete: del }) }),
    runTransaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as import("firebase-admin").firestore.Firestore;
  return { db, set, del, getStored: () => stored };
}

const NOW = 1_000_000_000;

describe("claimInboundProcessing", () => {
  it("claims a free lock and records lockedAt", async () => {
    const { db, set } = makeDb(undefined);
    expect(await claimInboundProcessing("+1555", db, NOW)).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.anything(), { lockedAt: NOW });
  });

  it("refuses a live lock held by another in-flight message", async () => {
    const { db, set } = makeDb({ lockedAt: NOW - 1_000 });
    expect(await claimInboundProcessing("+1555", db, NOW)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("reclaims a stale lock past the TTL (crashed holder self-heal)", async () => {
    const { db, set } = makeDb({ lockedAt: NOW - (INBOUND_LOCK_TTL_MS + 1) });
    expect(await claimInboundProcessing("+1555", db, NOW)).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.anything(), { lockedAt: NOW });
  });

  it("fails open (claims) when the transaction errors — never drops a message", async () => {
    const db = {
      runTransaction: async () => { throw new Error("firestore down"); },
    } as unknown as import("firebase-admin").firestore.Firestore;
    expect(await claimInboundProcessing("+1555", db, NOW)).toBe(true);
  });
});

describe("releaseInboundProcessing", () => {
  it("deletes the lock doc", async () => {
    const { db, del } = makeDb({ lockedAt: NOW });
    await releaseInboundProcessing("+1555", db);
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe("isFlowStale", () => {
  const NOW_MS = Date.parse("2026-07-15T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();
  const TTL = 24 * 60 * 60 * 1000;

  it("false when the flag is not set", () => {
    expect(isFlowStale({}, "someStep", "someStepSetAt", TTL, NOW_MS)).toBe(false);
  });

  it("false for a fresh flow", () => {
    expect(isFlowStale(
      { someStep: "confirm_shift", someStepSetAt: iso(60 * 60 * 1000) },
      "someStep", "someStepSetAt", TTL, NOW_MS,
    )).toBe(false);
  });

  it("true past the TTL", () => {
    expect(isFlowStale(
      { refundStep: "confirm", refundStepSetAt: iso(TTL + 1000) },
      "refundStep", "refundStepSetAt", TTL, NOW_MS,
    )).toBe(true);
  });

  it("true when the flag is set with NO stamp (legacy never-expires guard)", () => {
    expect(isFlowStale(
      { collectingCredential: true },
      "collectingCredential", "collectingCredentialSetAt", TTL, NOW_MS,
    )).toBe(true);
  });
});

