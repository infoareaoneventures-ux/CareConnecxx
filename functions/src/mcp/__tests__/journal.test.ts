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

const trySend = vi.fn().mockResolvedValue({ sent: true });
vi.mock("../../utils/toolNotify", () => ({
  trySend:        (...args: unknown[]) => trySend(...args),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("journal engagement tools", () => {
  beforeEach(() => { hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true }); });

  describe("like_journal_entry", () => {
    it("requires userId and entryId", async () => {
      const r = await handleToolCall("like_journal_entry", { userId: "u1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND for missing entry", async () => {
      const r = await handleToolCall("like_journal_entry", { userId: "u1", entryId: "ghost" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("arrayUnions user and increments likeCount", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "..." });
      const r = await handleToolCall("like_journal_entry", { userId: "u1", entryId: "e1" }) as any;
      expect(r.success).toBe(true);
      expect(r.liked).toBe(true);
      const set = hoisted.sets.find(s => s.path === "care_journal/e1");
      expect(set?.data.likedBy).toEqual({ __arrayUnion: ["u1"] });
      expect(set?.data.likeCount).toEqual({ __increment: 1 });
    });
  });

  describe("unlike_journal_entry", () => {
    it("arrayRemoves user and decrements likeCount", async () => {
      const r = await handleToolCall("unlike_journal_entry", { userId: "u1", entryId: "e1" }) as any;
      expect(r.success).toBe(true);
      const set = hoisted.sets.find(s => s.path === "care_journal/e1");
      expect(set?.data.likedBy).toEqual({ __arrayRemove: ["u1"] });
      expect(set?.data.likeCount).toEqual({ __increment: -1 });
    });
  });

  describe("comment_on_journal_entry", () => {
    it("requires all three fields", async () => {
      const r = await handleToolCall("comment_on_journal_entry", { userId: "u1", entryId: "e1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND for missing entry", async () => {
      const r = await handleToolCall("comment_on_journal_entry", { userId: "u1", entryId: "ghost", comment: "thanks!" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("adds comment subdoc + notifies caregiver", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "..." });
      hoisted.docState.set("caregivers/cg1", { name: "Maria", phone: "+15555550101" });
      const r = await handleToolCall("comment_on_journal_entry", { userId: "u1", entryId: "e1", comment: "Loved the dog photo!" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(true);
      // Comment was written
      const commentAdd = hoisted.adds.find(a => a.path === "care_journal/e1/comments");
      expect(commentAdd?.data.comment).toContain("Loved the dog photo");
      // Caregiver was sent the comment
      expect(trySend).toHaveBeenCalledWith("+15555550101", expect.stringContaining("New comment"), "mcp:comment_on_journal_entry");
    });

    it("surfaces notification.sent=false when caregiver phone is missing", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "..." });
      hoisted.docState.set("caregivers/cg1", { name: "Maria" }); // no phone
      const r = await handleToolCall("comment_on_journal_entry", { userId: "u1", entryId: "e1", comment: "thanks" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(false);
      expect(r.notification.reason).toBe("no_caregiver_phone");
      expect(trySend).not.toHaveBeenCalled();
    });

    it("surfaces notification.sent=false when send itself fails", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "..." });
      hoisted.docState.set("caregivers/cg1", { name: "Maria", phone: "+15555550101" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed", error: "timeout" });
      const r = await handleToolCall("comment_on_journal_entry", { userId: "u1", entryId: "e1", comment: "thanks" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(false);
      expect(r.notification.reason).toBe("linq_send_failed");
    });

    it("truncates very long comments to 2000 chars", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1" });
      hoisted.docState.set("caregivers/cg1", { name: "Maria", phone: "+15555550101" });
      const longComment = "x".repeat(5000);
      await handleToolCall("comment_on_journal_entry", { userId: "u1", entryId: "e1", comment: longComment });
      const commentAdd = hoisted.adds.find(a => a.path === "care_journal/e1/comments");
      expect((commentAdd?.data.comment as string).length).toBeLessThanOrEqual(2000);
    });
  });
});
