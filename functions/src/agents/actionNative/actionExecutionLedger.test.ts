import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();

  const docRef = (path: string) => ({
    path,
    async create(data: Record<string, unknown>) {
      if (docs.has(path)) throw new Error("already exists");
      docs.set(path, { ...data });
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    async delete() {
      docs.delete(path);
    },
  });

  const firestore = {
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${name}/${id}`),
    }),
    runTransaction: async <T>(fn: (tx: {
      get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
      set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => void;
      update: (ref: { path: string }, data: Record<string, unknown>) => void;
    }) => Promise<T>) => {
      const tx = {
        get: async (ref: { path: string }) => {
          const data = docs.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          docs.set(ref.path, opts?.merge ? { ...(docs.get(ref.path) ?? {}), ...data } : { ...data });
        },
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
        },
      };
      return fn(tx);
    },
  };

  return { docs, firestore };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.firestore },
  firestore: () => hoisted.firestore,
}));

import {
  claimCaraActionExecution,
  settleCaraActionExecution,
} from "./actionExecutionLedger";

describe("actionExecutionLedger", () => {
  beforeEach(() => {
    hoisted.docs.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks a fresh running claim and returns cached output after settlement", async () => {
    await expect(claimCaraActionExecution("setup:c1")).resolves.toEqual({ cached: false });
    await expect(claimCaraActionExecution("setup:c1")).resolves.toEqual({ inProgress: true });

    await settleCaraActionExecution("setup:c1", {
      ok: true,
      result: { sent: true, messageId: "msg-1" },
    });

    await expect(claimCaraActionExecution("setup:c1")).resolves.toEqual({
      cached: true,
      result: { sent: true, messageId: "msg-1" },
    });
  });

  it("reclaims only stale running claims", async () => {
    await expect(claimCaraActionExecution("family:add")).resolves.toEqual({ cached: false });

    vi.setSystemTime(new Date("2026-07-01T12:11:00Z"));

    await expect(claimCaraActionExecution("family:add")).resolves.toEqual({ cached: false });
    const saved = Array.from(hoisted.docs.values())[0];
    expect(saved).toMatchObject({ status: "running", reclaimed: true });
  });

  it("deletes failed claims so a later retry can run", async () => {
    await expect(claimCaraActionExecution("support:create")).resolves.toEqual({ cached: false });
    await settleCaraActionExecution("support:create", { ok: false });

    await expect(claimCaraActionExecution("support:create")).resolves.toEqual({ cached: false });
  });
});
