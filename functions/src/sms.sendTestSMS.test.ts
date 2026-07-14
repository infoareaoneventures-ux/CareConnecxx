import { describe, it, expect, vi, beforeEach } from "vitest";

// B6 — sendTestSMS must be admin-gated: any authed user could previously SMS
// any number. requireAdmin is exercised for real against the in-memory users
// collection; only the transport (linq) and rate limiter are mocked.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, any>>();
  const sendToPhone = vi.fn(async () => "sent" as const);
  return { docs, sendToPhone };
});

vi.mock("firebase-admin", () => {
  const { docs } = hoisted;
  let autoId = 0;

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      data: () => docs.get(path),
    }),
    set: async (data: Record<string, any>) => { docs.set(path, data); },
    update: async (data: Record<string, any>) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (name: string) => makeCollection(`${path}/${name}`),
  });

  const makeCollection = (colPath: string): any => ({
    doc: (id?: string) => makeDocRef(`${colPath}/${id ?? `auto-${++autoId}`}`),
    add: async (data: Record<string, any>) => {
      const path = `${colPath}/auto-${++autoId}`;
      docs.set(path, data);
      return makeDocRef(path);
    },
    where: () => ({
      where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      get: async () => ({ empty: true, docs: [] }),
    }),
  });

  const firestore: any = () => ({ collection: (name: string) => makeCollection(name) });
  firestore.FieldValue = { serverTimestamp: () => "server-ts" };
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error {
    constructor(public code: string, msg: string) { super(msg); }
  }
  return {
    https: { HttpsError, onCall: (f: any) => f },
    firestore: { document: () => ({ onWrite: (f: any) => f, onUpdate: (f: any) => f, onCreate: (f: any) => f }) },
    pubsub: { schedule: () => ({ onRun: (f: any) => f }) },
    config: () => ({}),
  };
});

vi.mock("./linq/client", () => ({
  sendToPhone: (...args: unknown[]) => hoisted.sendToPhone(...args as []),
  listPhoneNumbers: vi.fn(async () => []),
  createOrUpdateContactCard: vi.fn(async () => ({})),
}));

vi.mock("./rateLimit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4 })),
  RATE_LIMITS: { sms: { maxRequests: 5, windowMs: 60_000 } },
  getClientIdentifier: () => "client-1",
}));

vi.mock("./config/appUrl", () => ({ getAppUrl: () => "https://example.com" }));

import { sendTestSMS } from "./sms";

beforeEach(() => {
  hoisted.docs.clear();
  hoisted.sendToPhone.mockClear();
});

describe("B6 — sendTestSMS admin gate", () => {
  const payload = { to: "+15555550100", message: "test message" };

  it("rejects an unauthenticated caller", async () => {
    await expect((sendTestSMS as any)(payload, {}))
      .rejects.toMatchObject({ code: "unauthenticated" });
    expect(hoisted.sendToPhone).not.toHaveBeenCalled();
  });

  it("rejects an authenticated non-admin with permission-denied and sends nothing", async () => {
    hoisted.docs.set("users/u1", { userType: "client" });

    await expect((sendTestSMS as any)(payload, { auth: { uid: "u1" } }))
      .rejects.toMatchObject({ code: "permission-denied" });
    expect(hoisted.sendToPhone).not.toHaveBeenCalled();
  });

  it("rejects a caller with no users doc at all (fail closed)", async () => {
    await expect((sendTestSMS as any)(payload, { auth: { uid: "ghost" } }))
      .rejects.toMatchObject({ code: "permission-denied" });
    expect(hoisted.sendToPhone).not.toHaveBeenCalled();
  });

  it("allows an admin to send", async () => {
    hoisted.docs.set("users/a1", { userType: "admin" });

    const result = await (sendTestSMS as any)(payload, { auth: { uid: "a1" } });

    expect(result.success).toBe(true);
    expect(hoisted.sendToPhone).toHaveBeenCalledTimes(1);
  });
});
