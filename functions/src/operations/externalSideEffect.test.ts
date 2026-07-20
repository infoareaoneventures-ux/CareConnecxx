import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const snapshot = (path: string) => ({
    exists: docs.has(path),
    data: () => docs.get(path),
  });
  const ref = (path: string) => ({ path });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (callback: (transaction: {
      get: (document: { path: string }) => Promise<ReturnType<typeof snapshot>>;
      set: (document: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
    }) => Promise<unknown>) => callback({
      get: async (document) => snapshot(document.path),
      set: (document, data, options) => {
        docs.set(document.path, options?.merge ? { ...(docs.get(document.path) ?? {}), ...data } : data);
      },
    }),
  };
  const firestore = Object.assign(() => db, {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  return { docs, firestore };
});

vi.mock("firebase-admin", () => {
  const admin = { firestore: h.firestore };
  return { __esModule: true, default: admin, ...admin };
});

import { claimExternalSideEffectOperation, externalOperationDocId } from "./externalSideEffect";

describe("external side-effect ledger claims", () => {
  beforeEach(() => h.docs.clear());

  it("creates the ledger row for the first claim", async () => {
    const claim = await claimExternalSideEffectOperation({
      operationKey: "notification/appointment-1",
      operationType: "notification",
      targetId: "appointment-1",
    });

    expect(claim).toMatchObject({ attemptCount: 1 });
    expect(h.docs.get(`externalSideEffectOperations/${externalOperationDocId("notification/appointment-1")}`)).toMatchObject({
      operationKey: "notification/appointment-1",
      operationType: "notification",
      targetId: "appointment-1",
      state: "processing",
      attemptCount: 1,
      leaseOwner: claim?.leaseOwner,
    });
  });

  it("admits only the first claim while its lease is active", async () => {
    const input = {
      operationKey: "notification/appointment-1",
      operationType: "notification",
      targetId: "appointment-1",
    };

    expect(await claimExternalSideEffectOperation(input)).not.toBeNull();
    expect(await claimExternalSideEffectOperation(input)).toBeNull();
  });
});
