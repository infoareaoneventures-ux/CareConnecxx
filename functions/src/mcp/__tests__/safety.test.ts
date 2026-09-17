import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];
  const updates: Array<{ path: string; data: any }> = [];

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
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${adds.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${adds.length}`;
      adds.push({ path, data, id });
      docState.set(`${path}/${id}`, data);
      return { id };
    });
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, sets, adds, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:      (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove:     (...v: any[]) => ({ __arrayRemove: v }),
      increment:       (n: number) => ({ __increment: n }),
      delete:          () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
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

import { handleToolCall } from "../server";

describe("safety tools", () => {
  beforeEach(() => hoisted.reset());

  // block_user + unblock_user + report_user merged into set_block_status
  // (2026-08-31) to free tool slots under OpenAI's 128-tool cap when
  // delete_conversation/mark_messages_read were added.
  describe("set_block_status", () => {
    describe("action: 'block'", () => {
      // Confirmed-action gate (U12): seed a pending doc for the bypass call below.
      beforeEach(() => hoisted.docState.set("pending_actions/test", { toolName: "set_block_status", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" }));

      it("requires userId, targetUserId, and action", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1" }) as any;
        expect(r._toolError).toBe(true);
      });

      it("refuses self-block", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u1", action: "block" }) as any;
        expect(r._toolError).toBe(true);
      });

      it("arrayUnions target + creates admin_alert", async () => {
        // _confirmedActionId bypasses the runtime HITL gate (see pendingActions.ts).
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "block", reason: "spam", _confirmedActionId: "test" }) as any;
        expect(r.success).toBe(true);
        expect(r.blocked).toBe(true);
        const userSet = hoisted.sets.find(s => s.path === "users/u1");
        expect(userSet?.data.blockedUsers).toEqual({ __arrayUnion: ["u2"] });
        const alert = hoisted.adds.find(a => a.path === "admin_alerts");
        expect(alert?.data.type).toBe("user_blocked");
        expect(alert?.data.severity).toBe("medium");
      });
    });

    describe("action: 'unblock'", () => {
      it("requires no confirmation (matches unblock_user's pre-merge behavior)", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "unblock" }) as any;
        expect(r.success).toBe(true);
      });

      it("arrayRemoves target", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "unblock" }) as any;
        expect(r.success).toBe(true);
        const userSets = hoisted.sets.filter(s => s.path === "users/u1");
        expect(userSets[0]?.data.blockedUsers).toEqual({ __arrayRemove: ["u2"] });
      });

      it("also cleans up the blockedUserProfiles map entry the site's own unblockUser clears", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "unblock" }) as any;
        expect(r.success).toBe(true);
        const userSets = hoisted.sets.filter(s => s.path === "users/u1");
        const profileClear = userSets.find(s => "blockedUserProfiles.u2" in s.data);
        expect(profileClear?.data["blockedUserProfiles.u2"]).toEqual({ __delete: true });
      });

      it("hides the shared chat thread (messagesCutoff/deletedAt) when a room exists", async () => {
        const roomId = ["u1", "u2"].sort().join("_");
        hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["u1", "u2"] });
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "unblock" }) as any;
        expect(r.success).toBe(true);
        const roomSet = hoisted.sets.find(s => s.path === `chatRooms/${roomId}`);
        expect(roomSet?.data["messagesCutoff.u1"]).toBeTruthy();
        expect(roomSet?.data["deletedAt.u1"]).toBeTruthy();
      });

      it("does not fail when no chat room exists between the two users", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "unblock" }) as any;
        expect(r.success).toBe(true);
      });
    });

    describe("action: 'report'", () => {
      // Confirmed-action gate (U12): seed a pending doc for the bypass calls below.
      beforeEach(() => hoisted.docState.set("pending_actions/test", { toolName: "set_block_status", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" }));

      it("requires category and description", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "report", category: "harassment" }) as any;
        expect(r._toolError).toBe(true);
      });

      it("rejects unknown category", async () => {
        const r = await handleToolCall("set_block_status", { userId: "u1", targetUserId: "u2", action: "report", category: "made-up", description: "x" }) as any;
        expect(r._toolError).toBe(true);
      });

      it("creates a report doc + admin_alert, tells user 24h follow-up", async () => {
        const r = await handleToolCall("set_block_status", {
          userId: "u1", targetUserId: "u2", action: "report",
          category: "harassment", description: "Sent abusive messages",
          _confirmedActionId: "test", // bypass HITL gate
        }) as any;
        expect(r.success).toBe(true);
        expect(r.reported).toBe(true);
        expect(r.followUpWindow).toBe("24h");
        // Shape must match the website's own report doc (components/InboxView.tsx's
        // handleReportSubmit) — reportedBy/reportedUser/reason/details, no status
        // field (the admin list defaults a missing status to "new" client-side).
        const report = hoisted.adds.find(a => a.path === "reports");
        expect(report?.data.reportedBy).toBe("u1");
        expect(report?.data.reportedUser).toBe("u2");
        expect(report?.data.reason).toBe("Harassment");
        expect(report?.data.details).toBe("Sent abusive messages");
        expect(report?.data.status).toBeUndefined();
        const alert = hoisted.adds.find(a => a.path === "admin_alerts");
        expect(alert?.data.type).toBe("user_reported");
      });

      it("truncates extremely long descriptions to 2000 chars", async () => {
        const longDesc = "x".repeat(5000);
        const r = await handleToolCall("set_block_status", {
          userId: "u1", targetUserId: "u2", action: "report",
          category: "other", description: longDesc,
          _confirmedActionId: "test", // bypass HITL gate
        }) as any;
        expect(r.success).toBe(true);
        const report = hoisted.adds.find(a => a.path === "reports");
        expect((report?.data.details as string).length).toBeLessThanOrEqual(2000);
      });

      it("resolves reportedUserName from the target's users doc and maps safety_concern into details (no site-side equivalent reason)", async () => {
        hoisted.docState.set("users/u2", { name: "Alice Caregiver" });
        const r = await handleToolCall("set_block_status", {
          userId: "u1", targetUserId: "u2", action: "report",
          category: "safety_concern", description: "Left the client unattended",
          _confirmedActionId: "test",
        }) as any;
        expect(r.success).toBe(true);
        const report = hoisted.adds.find(a => a.path === "reports");
        expect(report?.data.reportedUserName).toBe("Alice Caregiver");
        expect(report?.data.reason).toBe("Other");
        expect(report?.data.details).toBe("[Safety concern] Left the client unattended");
      });
    });
  });
});
