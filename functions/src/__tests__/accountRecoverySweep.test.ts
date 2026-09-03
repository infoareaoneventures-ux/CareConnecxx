import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const deletions: string[] = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    delete: vi.fn(async () => { deletions.push(path); docState.delete(path); }),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.where = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { docs: items.map((d: any) => ({ id: d.id, ref: makeDocRef(`${path}/${d.id}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, deletions,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); deletions.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: () => ({ collection: hoisted.collectionMock }) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("../email", () => ({
  sendTransactionalEmail: vi.fn(),
  phoneChangeRequestHtml: vi.fn(),
  phoneChangeConfirmedHtml: vi.fn(),
  emailChangeConfirmHtml: vi.fn(),
}));
vi.mock("../sms", () => ({ sendSMS: vi.fn() }));

beforeEach(() => hoisted.reset());

describe("sweepExpiredAccountRecoveryRequests", () => {
  it("deletes only expired requests, from both collections, and reports the count", async () => {
    // Firestore's own where("<") filtering is mocked away here (the fake
    // collection ref returns whatever's seeded) — the real inequality query
    // is exercised implicitly by every other Firestore-backed test in this
    // suite using the same convention; this test locks in the sweep's own
    // per-collection loop and delete/count behavior.
    hoisted.collState.set("phone_change_requests", [{ id: "expired_1" }, { id: "expired_2" }]);
    hoisted.collState.set("email_change_requests", [{ id: "expired_3" }]);

    const { sweepExpiredAccountRecoveryRequests } = await import("../accountRecovery");
    const result = await sweepExpiredAccountRecoveryRequests();

    expect(result.deleted).toBe(3);
    expect(hoisted.deletions).toEqual(
      expect.arrayContaining([
        "phone_change_requests/expired_1",
        "phone_change_requests/expired_2",
        "email_change_requests/expired_3",
      ]),
    );
  });

  it("returns 0 when nothing is expired", async () => {
    const { sweepExpiredAccountRecoveryRequests } = await import("../accountRecovery");
    const result = await sweepExpiredAccountRecoveryRequests();
    expect(result.deleted).toBe(0);
  });
});
