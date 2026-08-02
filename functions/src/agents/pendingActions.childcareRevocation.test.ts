import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();

  const docRef = (path: string): any => ({
    path,
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
      ref: docRef(path),
    }),
    update: async (patch: Record<string, unknown>) => {
      const current = docs.get(path);
      if (current) docs.set(path, { ...current, ...patch });
    },
  });

  const firestore = () => ({
    collection: (collection: string) => ({
      doc: (id: string) => docRef(`${collection}/${id}`),
    }),
    runTransaction: async (fn: (tx: any) => unknown) =>
      fn({
        get: (ref: any) => ref.get(),
        update: (ref: any, patch: Record<string, unknown>) => ref.update(patch),
      }),
  });

  return { docs, firestore };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

import { claimPendingAction } from "./pendingActions";

const NOW = Date.now();

function seed(accessVersion = 4): void {
  hoisted.docs.set("pending_actions/pa_child", {
    phone: "+15550001111",
    userId: "parent-1",
    toolName: "cancel_childcare_booking",
    toolInput: { bookingId: "booking-1" },
    preview: "Cancel childcare booking booking-1",
    proposedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    status: "awaiting",
    careVertical: "child",
    childcareBookingId: "booking-1",
    operation: {
      schema: "pending-operation-v1",
      operationId: "op_test_child_booking_1",
      principalId: "parent-1",
      careVertical: "child",
      objectType: "childcare_booking",
      objectId: "booking-1",
      actionName: "cancel_childcare_booking",
      actionSchemaVersion: 1,
      sourceTurnKey: "turn-child-1",
      expiresAt: new Date(NOW + 60_000).toISOString(),
    },
    childAuthorityBindings: [
      { childId: "child-1", scope: "cancellation", accessVersion: 4 },
    ],
  });
  hoisted.docs.set("booking_requests/booking-1", {
    careVertical: "child",
    clientId: "parent-1",
    childIds: ["child-1"],
    status: "confirmed",
  });
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
  });
  hoisted.docs.set("guardian_authorities/child-1__parent-1", {
    childId: "child-1",
    adultUid: "parent-1",
    state: "active",
    scopes: ["cancellation"],
    accessVersion,
  });
}

beforeEach(() => {
  hoisted.docs.clear();
  seed();
});

describe("claimPendingAction childcare authority binding", () => {
  it("claims only while the proposal's authority version remains current", async () => {
    await expect(claimPendingAction("pa_child")).resolves.toBe("claimed");
    expect(hoisted.docs.get("pending_actions/pa_child")?.status).toBe("executing");
  });

  it("denies immediately after authority changes, without dispatching", async () => {
    hoisted.docs.set("guardian_authorities/child-1__parent-1", {
      ...(hoisted.docs.get("guardian_authorities/child-1__parent-1") ?? {}),
      state: "revoked",
      accessVersion: 5,
    });

    await expect(claimPendingAction("pa_child")).resolves.toBe("not_claimable");
    expect(hoisted.docs.get("pending_actions/pa_child")?.status).toBe("awaiting");
  });

  it("denies when childcare writes are disabled between proposal and approval", async () => {
    hoisted.docs.set("childcare_flags/global", {
      CHILDCARE_ENABLED: true,
      CHILDCARE_WRITES_ENABLED: false,
    });

    await expect(claimPendingAction("pa_child")).resolves.toBe("not_claimable");
    expect(hoisted.docs.get("pending_actions/pa_child")?.status).toBe("awaiting");
  });
});
