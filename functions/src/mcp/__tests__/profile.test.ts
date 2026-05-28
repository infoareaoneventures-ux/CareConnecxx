import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updates: Array<{ path: string; data: any }> = [];
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];

  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      const prev = docState.get(path) ?? {};
      docState.set(path, opts?.merge ? { ...prev, ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      const prev = docState.get(path) ?? {};
      docState.set(path, { ...prev, ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${adds.length}`}`),
    add: vi.fn(async (data: any) => {
      const id = `auto-${adds.length}`;
      adds.push({ path, data, id });
      docState.set(`${path}/${id}`, data);
      return { id };
    }),
    where: vi.fn(function chain(this: any) { return this; }),
    orderBy: vi.fn(function chain(this: any) { return this; }),
    limit:   vi.fn(function chain(this: any) { return this; }),
    get: vi.fn(async () => {
      const docs = (collState.get(path) ?? []).map((d, i) => ({
        id: d.id ?? `doc-${i}`,
        data: () => d,
        ref:  makeDocRef(`${path}/${d.id ?? `doc-${i}`}`),
      }));
      return { empty: docs.length === 0, size: docs.length, docs };
    }),
  });
  // Make where/orderBy/limit chain back to itself with .get
  // (Previously stored as ChainProto; now inlined where needed below.)

  const collectionMock = vi.fn((p: string) => makeCollRef(p));

  return {
    docState, collState, updates, sets, adds, collectionMock,
    reset: () => { docState.clear(); collState.clear(); updates.length = 0; sets.length = 0; adds.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  vi.fn().mockResolvedValue(""),
  writeMemoryFile: vi.fn().mockResolvedValue(undefined),
  MemoryFile: {},
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
}));

import { handleToolCall } from "../server";

describe("profile tools", () => {
  beforeEach(() => hoisted.reset());

  describe("update_user_profile", () => {
    it("requires userId", async () => {
      const r = await handleToolCall("update_user_profile", { firstName: "Bob" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("rejects malformed phone", async () => {
      const r = await handleToolCall("update_user_profile", { userId: "u1", phone: "555" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("requires at least one field beyond userId", async () => {
      const r = await handleToolCall("update_user_profile", { userId: "u1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("updates name + address and lists the changed fields", async () => {
      const r = await handleToolCall("update_user_profile", {
        userId: "u1", firstName: "Bob", address: "123 Main", city: "NYC",
      }) as any;
      expect(r.success).toBe(true);
      expect(r.updated).toEqual(expect.arrayContaining(["firstName", "address", "city"]));
      expect(r.phoneChangeRequested).toBe(false);
    });

    it("stores phone as pendingPhone (does not overwrite live phone)", async () => {
      const r = await handleToolCall("update_user_profile", {
        userId: "u1", phone: "+15555550100",
      }) as any;
      expect(r.success).toBe(true);
      expect(r.phoneChangeRequested).toBe(true);
      expect(r.phoneVerificationNote).toContain("verify");
      // Verify the write was to pendingPhone, not phone
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.pendingPhone).toBe("+15555550100");
      expect(userSet?.data.phone).toBeUndefined();
    });
  });

  describe("update_communication_preferences", () => {
    it("requires userId", async () => {
      const r = await handleToolCall("update_communication_preferences", { newsletter: true }) as any;
      expect(r._toolError).toBe(true);
    });

    it("requires at least one preference field", async () => {
      const r = await handleToolCall("update_communication_preferences", { userId: "u1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("coerces values to boolean", async () => {
      const r = await handleToolCall("update_communication_preferences", {
        userId: "u1", newsletter: 1, privacyShowBookings: 0,
      }) as any;
      expect(r.success).toBe(true);
      const set = hoisted.sets.find(s => s.path === "users/u1");
      expect(set?.data.newsletter).toBe(true);
      expect(set?.data.privacyShowBookings).toBe(false);
    });
  });

  describe("request_email_change", () => {
    it("requires userId and newEmail", async () => {
      expect(((await handleToolCall("request_email_change", { userId: "u1" })) as any)._toolError).toBe(true);
      expect(((await handleToolCall("request_email_change", { newEmail: "a@b.co" })) as any)._toolError).toBe(true);
    });

    it("rejects invalid email format", async () => {
      const r = await handleToolCall("request_email_change", { userId: "u1", newEmail: "not-an-email" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("creates a pending change record and tells the user to verify", async () => {
      const r = await handleToolCall("request_email_change", { userId: "u1", newEmail: "new@example.com" }) as any;
      expect(r.success).toBe(true);
      expect(r.verificationSent).toBe(true);
      // Token-keyed doc was created in email_change_requests
      const tokenAdd = hoisted.sets.find(s => s.path.startsWith("email_change_requests/"));
      expect(tokenAdd?.data.userId).toBe("u1");
      expect(tokenAdd?.data.newEmail).toBe("new@example.com");
      expect(tokenAdd?.data.status).toBe("pending");
      // User doc was annotated with pendingEmail
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.pendingEmail).toBe("new@example.com");
    });
  });
});
