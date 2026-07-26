import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  requireAnyOperatorScope: vi.fn(async () => ({
    operatorUid: "op-1",
    scope: "childSafetyOperator",
  })),
}));

vi.mock("firebase-admin", () => {
  const firestore = () => ({
    collection: (collection: string) => ({
      doc: (id: string) => {
        const path = `${collection}/${id}`;
        return {
          path,
          collection: (subcollection: string) => ({
            doc: (subId: string) => ({
              path: `${path}/${subcollection}/${subId}`,
              get: async () => {
                const data = hoisted.docs.get(`${path}/${subcollection}/${subId}`);
                return { exists: Boolean(data), data: () => data };
              },
            }),
          }),
          get: async () => {
            const data = hoisted.docs.get(path);
            return { exists: Boolean(data), data: () => data };
          },
        };
      },
    }),
  });
  return { __esModule: true, default: { firestore }, firestore };
});

vi.mock("../admin/requireOperatorScope", () => ({
  OPERATOR_SCOPE_CHILD_BILLING: "childBillingOperator",
  OPERATOR_SCOPE_CHILD_SAFETY: "childSafetyOperator",
  OPERATOR_SCOPE_CHILD_SCREENING: "childScreeningOperator",
  OPERATOR_SCOPE_CHILD_SUPPORT: "childSupportOperator",
  requireAnyOperatorScope: hoisted.requireAnyOperatorScope,
}));

vi.mock("../config/featureFlags", () => ({
  getChildcareAppCheckConfig: vi.fn(async () => ({
    mode: "monitor",
    source: "default",
    transitionRecorded: false,
    transitionAt: null,
    providerRegistrationVerified: false,
    debugTokensAllowed: false,
    verifiedDomains: [],
  })),
}));

import { getChildcareOperatorObject as _getChildcareOperatorObject } from "./operatorCallables";

// The firebase-functions/v1 stub makes onCall(fn) === fn.
/* eslint-disable @typescript-eslint/no-explicit-any */
const getChildcareOperatorObject = _getChildcareOperatorObject as any;

const context = {
  auth: { uid: "op-1", token: { auth_time: Math.floor(Date.now() / 1000) } },
  app: { appId: "app-1" },
} as any;

beforeEach(() => {
  hoisted.docs.clear();
  hoisted.requireAnyOperatorScope.mockClear();
});

describe("getChildcareOperatorObject", () => {
  it("returns a minimum child conversation projection and audits exact-object scope", async () => {
    hoisted.docs.set("chatRooms/room-1", {
      careVertical: "child",
      contextType: "booking",
      contextId: "booking-1",
      state: "active",
      participants: ["family-1", "provider-1"],
      lastMessage: "private content",
      exactAddress: "123 Main St",
    });
    const result = await getChildcareOperatorObject(
      {
        resourceType: "conversation",
        objectRef: "room-1",
        reasonCode: "incident_investigation",
      },
      context,
    );
    expect(result.projection).toEqual({
      objectRef: "room-1",
      careVertical: "child",
      contextType: "booking",
      contextId: "booking-1",
      state: "active",
    });
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(JSON.stringify(result)).not.toContain("123 Main");
    expect(hoisted.requireAnyOperatorScope).toHaveBeenCalledWith(
      context,
      ["childSafetyOperator"],
      expect.objectContaining({
        recentAuth: true,
        access: {
          action: "operator_read:conversation",
          objectRef: "room-1",
          reason: "incident_investigation",
        },
      }),
    );
  });

  it("denies senior, missing, wrong-reason, and list-shaped requests uniformly", async () => {
    hoisted.docs.set("booking_requests/senior-1", {
      careVertical: "senior",
      status: "confirmed",
    });
    for (const input of [
      {
        resourceType: "booking",
        objectRef: "senior-1",
        reasonCode: "support_case",
      },
      {
        resourceType: "booking",
        objectRef: "missing",
        reasonCode: "support_case",
      },
      {
        resourceType: "conversation",
        objectRef: "room-1",
        reasonCode: "billing_reconciliation",
      },
      {
        resourceType: "booking",
        objectRef: "*",
        reasonCode: "support_case",
      },
    ]) {
      await expect(
        getChildcareOperatorObject(input, context),
      ).rejects.toMatchObject({ code: "permission-denied" });
    }
  });
});
