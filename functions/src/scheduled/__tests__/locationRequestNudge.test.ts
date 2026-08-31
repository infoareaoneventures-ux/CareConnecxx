import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 2026-08-30 fix: pendingLocationRequest.nudgeSent is only ever cleared by an
 * SMS reply (a pin or a typed city/zip). If the user instead supplied their
 * address through the WEBSITE, nothing clears it, and this job would wrongly
 * nudge "still need your location" for something already on file. These
 * tests prove a live users-doc check now catches that case.
 */

const store = {
  sessions: new Map<string, any>(),
  users:    new Map<string, any>(),
  updates:  [] as Array<{ id: string; data: any }>,
};

vi.mock("firebase-admin", () => {
  const collection = (name: string) => {
    if (name === "users") {
      return { doc: (id: string) => ({ get: async () => ({ exists: store.users.has(id), data: () => store.users.get(id) }) }) };
    }
    // agent_sessions
    return {
      where: () => ({
        get: async () => ({
          docs: [...store.sessions.entries()].map(([id, data]) => ({
            id, data: () => data,
            ref: { update: vi.fn(async (upd: any) => { store.updates.push({ id, data: upd }); }) },
          })),
        }),
      }),
    };
  };
  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: { delete: () => ({ __del: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => ({
  pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) },
}));

vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async (opts: any) => opts.fallback),
}));

const sendSpy = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendSpy(...a) }));

import { sendLocationRequestNudges } from "../locationRequestNudge";

const TWENTY_MIN_AGO = new Date(Date.now() - 20 * 60 * 1000).toISOString();

function seedSession(id: string, data: Record<string, unknown>) {
  store.sessions.set(id, {
    optedOut: false,
    pendingLocationRequest: { sentAt: TWENTY_MIN_AGO, nudgeSent: false },
    ...data,
  });
}

beforeEach(() => {
  store.sessions.clear();
  store.users.clear();
  store.updates.length = 0;
  sendSpy.mockClear();
});

describe("sendLocationRequestNudges", () => {
  it("nudges when no linked account has the location yet", async () => {
    seedSession("+15552220000", { userId: "client-1" });
    store.users.set("client-1", {});

    await (sendLocationRequestNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("skips and clears the marker when the website already captured the address (zipCode)", async () => {
    seedSession("+15552220001", { userId: "client-2" });
    store.users.set("client-2", { zipCode: "78701" });

    await (sendLocationRequestNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(store.updates).toContainEqual({ id: "+15552220001", data: { pendingLocationRequest: { __del: true } } });
  });

  it("skips when the website already captured the address (city only)", async () => {
    seedSession("+15552220002", { userId: "client-3" });
    store.users.set("client-3", { city: "Austin" });

    await (sendLocationRequestNudges as any)();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("still nudges when there's no linked account yet (fail-soft, unchanged behavior)", async () => {
    seedSession("+15552220003", {});

    await (sendLocationRequestNudges as any)();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
