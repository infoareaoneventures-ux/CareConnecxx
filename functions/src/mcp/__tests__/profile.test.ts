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

vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

// Phone/email-change now route through the shared account-recovery flow
// (functions/src/accountRecovery.ts) instead of writing pendingPhone/pendingEmail
// directly — that module's own email-sending is exercised by its own tests, so
// here it's a boundary mock: assert update_user_profile/request_email_change
// call it with the right account details.
const requestPhoneChangeForAccount = vi.fn().mockResolvedValue(undefined);
const requestEmailChangeForAccount = vi.fn().mockResolvedValue(undefined);
vi.mock("../../accountRecovery", () => ({
  requestPhoneChangeForAccount: (...a: unknown[]) => requestPhoneChangeForAccount(...a),
  requestEmailChangeForAccount: (...a: unknown[]) => requestEmailChangeForAccount(...a),
}));

// The profile photo goes through the site's own upload path (agents/profilePhoto.ts,
// tested on its own) — here it is a boundary mock.
const setClientProfilePhoto = vi.fn(async (_uid: string, _src: string) => ({ photoURL: "https://firebasestorage.googleapis.com/v0/b/x/o/profile_photos%2Fu1%2Fprofile?alt=media&token=t" }));
vi.mock("../../agents/profilePhoto", () => ({
  setClientProfilePhoto: (...a: unknown[]) => setClientProfilePhoto(...(a as [string, string])),
}));

import { handleToolCall } from "../server";

describe("profile tools", () => {
  beforeEach(() => {
    hoisted.reset();
    requestPhoneChangeForAccount.mockClear();
    requestEmailChangeForAccount.mockClear();
    setClientProfilePhoto.mockClear();
  });

  describe("update_caregiver_profile", () => {
    it("denies a different acting phone without writing", async () => {
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550100" });
      const r = await handleToolCall("update_caregiver_profile", {
        caregiverId: "cg1",
        phone: "+15555550999",
        bio: "Injected bio",
      }) as any;

      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
      expect(hoisted.sets).toHaveLength(0);
    });

    it.each([-5, 0, 151, 9999])("rejects an out-of-range hourly rate: %s", async (hourlyRate) => {
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550100" });
      const r = await handleToolCall("update_caregiver_profile", {
        caregiverId: "cg1",
        phone: "+15555550100",
        hourlyRate,
      }) as any;

      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
      expect(hoisted.sets).toHaveLength(0);
    });

    it("updates an owned profile without mutating its identity phone", async () => {
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550100" });
      const r = await handleToolCall("update_caregiver_profile", {
        caregiverId: "cg1",
        phone: "+15555550100",
        hourlyRate: 35,
        bio: "Experienced companion caregiver",
      }) as any;

      expect(r.success).toBe(true);
      expect(r.updated).toEqual(expect.arrayContaining(["hourlyRate", "bio"]));
      const write = hoisted.sets.find((entry) => entry.path === "caregivers/cg1");
      expect(write?.data.phone).toBeUndefined();
    });
  });

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

    it("updates name + address using the site's own field names (displayName/street/city/location)", async () => {
      const r = await handleToolCall("update_user_profile", {
        userId: "u1", firstName: "Bob", address: "123 Main", city: "NYC",
      }) as any;
      expect(r.success).toBe(true);
      // Matches components/client/AccountSettings.tsx exactly — a combined
      // displayName (never separate firstName/lastName) and street/city/
      // location/careLocation (never address/zip) for address fields.
      expect(r.updated).toEqual(expect.arrayContaining(["displayName", "street", "city", "location", "careLocation"]));
      expect(r.updated).not.toContain("firstName");
      expect(r.updated).not.toContain("address");
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.displayName).toBe("Bob");
      expect(userSet?.data.street).toBe("123 Main");
      expect(userSet?.data.city).toBe("NYC");
    });

    it("keeps the existing last name when only firstName is updated", async () => {
      hoisted.docState.set("users/u1", { displayName: "Bob Smith" });
      const r = await handleToolCall("update_user_profile", { userId: "u1", firstName: "Robert" }) as any;
      expect(r.success).toBe(true);
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.displayName).toBe("Robert Smith");
    });

    it("profile photo goes through the site's upload path (storage → users.photoURL / senior_profiles.imageUrl / Auth), never a raw URL write", async () => {
      const r = await handleToolCall("update_user_profile", { userId: "u1", photoUrl: "https://example.com/p.jpg" }) as any;
      expect(r.success).toBe(true);
      expect(setClientProfilePhoto).toHaveBeenCalledWith("u1", "https://example.com/p.jpg");
      expect(r.updated).toContain("photoURL");
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.photoUrl).toBeUndefined();
    });

    it("a typed word is never a photo — 'skipped' is rejected and nothing is written", async () => {
      const r = await handleToolCall("update_user_profile", { userId: "u1", photoUrl: "skipped" }) as any;
      expect(r._toolError).toBe(true);
      expect(hoisted.sets.find(s => s.path === "users/u1")).toBeUndefined();
      expect(setClientProfilePhoto).not.toHaveBeenCalled();
    });

    it("photoFromMessage:true uses the photo the family just attached; with none it points to Account Settings", async () => {
      hoisted.docState.set("agent_sessions/+15550001111", { lastSharedMedia: { kind: "image", url: "https://media.example/a.jpg" } });
      const ok = await handleToolCall("update_user_profile", { userId: "u1", phone: "+15550001111", photoFromMessage: true }) as any;
      expect(ok.success).toBe(true);
      expect(setClientProfilePhoto).toHaveBeenCalledWith("u1", "https://media.example/a.jpg");
      hoisted.docState.delete("agent_sessions/+15550001111");
      setClientProfilePhoto.mockClear();
      const miss = await handleToolCall("update_user_profile", { userId: "u1", phone: "+15550001111", photoFromMessage: true }) as any;
      expect(miss._toolError).toBe(true);
      expect(JSON.stringify(miss)).toMatch(/\/client\/account/);
      expect(setClientProfilePhoto).not.toHaveBeenCalled();
    });

    it("requestPhoneChange:true starts the email-gated flow instead of writing phone directly", async () => {
      hoisted.docState.set("users/u1", { email: "family@example.com", firstName: "Bob" });
      const r = await handleToolCall("update_user_profile", {
        userId: "u1", requestPhoneChange: true,
      }) as any;
      expect(r.success).toBe(true);
      expect(r.sentTo).toBe("family@example.com");
      expect(requestPhoneChangeForAccount).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "u1", role: "client", name: "Bob" }),
        "family@example.com",
      );
      // Nothing written to users/u1 directly — the real swap only happens
      // once the emailed link is confirmed.
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet).toBeUndefined();
    });

    it("requestPhoneChange:true fails soft when there's no email on file", async () => {
      hoisted.docState.set("users/u1", { firstName: "Bob" });
      const r = await handleToolCall("update_user_profile", {
        userId: "u1", requestPhoneChange: true,
      }) as any;
      expect(r.success).toBe(false);
      expect(r.noEmailOnFile).toBe(true);
      expect(requestPhoneChangeForAccount).not.toHaveBeenCalled();
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
      // The actual token doc + email send now live in accountRecovery.ts
      // (its own tests cover that) — this boundary just confirms the tool
      // calls it with the right account and never writes pendingEmail itself.
      expect(requestEmailChangeForAccount).toHaveBeenCalledWith("u1", "client", "new@example.com");
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.pendingEmail).toBeUndefined();
    });
  });
});
