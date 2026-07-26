import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory Firestore stub. One doc per phone in the checkpoint collection.
const hoisted = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();

  const docRef = (phone: string) => ({
    set:    vi.fn(async (data: Record<string, unknown>) => { store.set(phone, data); }),
    get:    vi.fn(async () => {
      const data = store.get(phone);
      return {
        exists: data !== undefined,
        data:   () => data,
        ref:    { delete: vi.fn(async () => { store.delete(phone); }) },
      };
    }),
    delete: vi.fn(async () => { store.delete(phone); }),
  });

  const collection = vi.fn(() => ({ doc: (phone: string) => docRef(phone) }));
  return { store, collection };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default:   { firestore: () => ({ collection: hoisted.collection }) },
  firestore: () => ({ collection: hoisted.collection }),
}));

import {
  hashText,
  writeCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  isCheckpointResumeEnabled,
} from "./turnCheckpoint";

const PHONE = "+15555550100";

describe("turnCheckpoint", () => {
  beforeEach(() => {
    hoisted.store.clear();
    process.env.CARA_CHECKPOINT_RESUME = "true";
  });
  afterEach(() => {
    delete process.env.CARA_CHECKPOINT_RESUME;
    vi.useRealTimers();
  });

  describe("hashText", () => {
    it("is deterministic and trim-insensitive", () => {
      expect(hashText("hello")).toBe(hashText("  hello  "));
    });
    it("differs for different text", () => {
      expect(hashText("a")).not.toBe(hashText("b"));
    });
  });

  describe("feature flag", () => {
    it("reports enabled only when env flag is exactly 'true'", () => {
      process.env.CARA_CHECKPOINT_RESUME = "true";
      expect(isCheckpointResumeEnabled()).toBe(true);
      process.env.CARA_CHECKPOINT_RESUME = "false";
      expect(isCheckpointResumeEnabled()).toBe(false);
      delete process.env.CARA_CHECKPOINT_RESUME;
      expect(isCheckpointResumeEnabled()).toBe(false);
    });

    it("writeCheckpoint is a no-op when the flag is off", async () => {
      process.env.CARA_CHECKPOINT_RESUME = "false";
      await writeCheckpoint(PHONE, "loop_complete", hashText("hi"), "reply");
      expect(hoisted.store.size).toBe(0);
    });

    it("loadCheckpoint returns null when the flag is off", async () => {
      // Seed a doc with the flag on, then turn it off and confirm load is null.
      await writeCheckpoint(PHONE, "loop_complete", hashText("hi"), "reply");
      process.env.CARA_CHECKPOINT_RESUME = "false";
      expect(await loadCheckpoint(PHONE, "hi")).toBeNull();
    });
  });

  describe("write → load round trip", () => {
    it("loads a checkpoint when the text hash matches", async () => {
      await writeCheckpoint(PHONE, "loop_complete", hashText("when is the visit"), "Thursday 9am.");
      const cp = await loadCheckpoint(PHONE, "when is the visit");
      expect(cp).not.toBeNull();
      expect(cp!.reply).toBe("Thursday 9am.");
      expect(cp!.phase).toBe("loop_complete");
    });

    it("returns null when the inbound text differs (different message, same phone)", async () => {
      await writeCheckpoint(PHONE, "loop_complete", hashText("first message"), "reply A");
      const cp = await loadCheckpoint(PHONE, "a totally different message");
      expect(cp).toBeNull();
    });

    it("keeps senior and child checkpoints independent for the same phone and text", async () => {
      const textHash = hashText("same inbound");
      await writeCheckpoint(PHONE, "loop_complete", textHash, "senior reply", "senior");
      await writeCheckpoint(PHONE, "loop_complete", textHash, "child reply", "child");

      expect((await loadCheckpoint(PHONE, "same inbound", "senior"))?.reply).toBe("senior reply");
      expect((await loadCheckpoint(PHONE, "same inbound", "child"))?.reply).toBe("child reply");

      await clearCheckpoint(PHONE, "child");
      expect(await loadCheckpoint(PHONE, "same inbound", "child")).toBeNull();
      expect((await loadCheckpoint(PHONE, "same inbound", "senior"))?.reply).toBe("senior reply");
    });

    it("does not write an empty reply", async () => {
      await writeCheckpoint(PHONE, "loop_complete", hashText("hi"), "");
      expect(hoisted.store.size).toBe(0);
    });
  });

  describe("expiry", () => {
    it("returns null and deletes the doc once past the 5-minute TTL", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-28T10:00:00Z"));
      await writeCheckpoint(PHONE, "loop_complete", hashText("hi"), "reply");
      expect(hoisted.store.size).toBe(1);

      // Advance 6 minutes — past the 5-minute TTL.
      vi.setSystemTime(new Date("2026-05-28T10:06:00Z"));
      const cp = await loadCheckpoint(PHONE, "hi");
      expect(cp).toBeNull();
      // expired doc is cleaned up
      expect(hoisted.store.size).toBe(0);
    });

    it("still loads within the TTL window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-28T10:00:00Z"));
      await writeCheckpoint(PHONE, "loop_complete", hashText("hi"), "reply");
      vi.setSystemTime(new Date("2026-05-28T10:04:00Z")); // 4 min — within 5
      const cp = await loadCheckpoint(PHONE, "hi");
      expect(cp).not.toBeNull();
    });
  });

  describe("clearCheckpoint", () => {
    it("removes the doc", async () => {
      await writeCheckpoint(PHONE, "loop_complete", hashText("hi"), "reply");
      expect(hoisted.store.size).toBe(1);
      await clearCheckpoint(PHONE);
      expect(hoisted.store.size).toBe(0);
    });

    it("is safe to call when no checkpoint exists", async () => {
      await expect(clearCheckpoint(PHONE)).resolves.toBeUndefined();
    });
  });
});
