import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    firestore: () => ({
      collection: (name: string) => ({
        doc: (id: string) => ({
          set: async (d: Record<string, unknown>) => { docs.set(`${name}/${id}`, d); },
          get: async () => {
            const d = docs.get(`${name}/${id}`);
            return { exists: !!d, data: () => d };
          },
        }),
      }),
    }),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

import {
  writePhaseCheckpoint,
  loadPhaseCheckpoint,
  buildResumeDirective,
  PHASE_CHECKPOINT_COLLECTION,
  type PhaseCheckpointDoc,
} from "./turnPhaseCheckpoint";
import type { SourceTurnIdentity } from "./turnSourceKey";

const now = new Date("2026-07-22T12:00:00Z");
const identity = (over: Partial<SourceTurnIdentity> = {}): SourceTurnIdentity => ({
  channel: "linq",
  principal: "+14085550100",
  conversationId: "chat-1",
  messageId: "evt-abc",
  objectiveVersion: 0,
  ...over,
});

describe("phase checkpoints (U4/R21)", () => {
  it("write → load roundtrip under the same verified identity", async () => {
    hoisted.docs.clear();
    const { key } = await writePhaseCheckpoint(identity(), "acted", {
      completedActionKeys: ["request_booking:u1:cg1"],
      objectiveId: "obj-1",
      now,
    });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const loaded = await loadPhaseCheckpoint(identity(), { now });
    expect(loaded).not.toBeNull();
    expect(loaded!.phase).toBe("acted");
    expect(loaded!.completedActionKeys).toEqual(["request_booking:u1:cg1"]);
    expect(loaded!.objectiveId).toBe("obj-1");
  });

  it("AE21: a different account or channel can never load the checkpoint", async () => {
    hoisted.docs.clear();
    await writePhaseCheckpoint(identity(), "responded", { now });
    expect(await loadPhaseCheckpoint(identity({ principal: "+14085550999" }), { now })).toBeNull();
    expect(await loadPhaseCheckpoint(identity({ channel: "web", principal: "uid-1" }), { now })).toBeNull();
    expect(await loadPhaseCheckpoint(identity({ messageId: "evt-other" }), { now })).toBeNull();
  });

  it("an old checkpoint never applies to a newer objective version", async () => {
    hoisted.docs.clear();
    await writePhaseCheckpoint(identity({ objectiveVersion: 1 }), "acted", { now });
    expect(await loadPhaseCheckpoint(identity({ objectiveVersion: 2 }), { now })).toBeNull();
  });

  it("expired checkpoints load as absent", async () => {
    hoisted.docs.clear();
    await writePhaseCheckpoint(identity(), "hydrated", { now });
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    expect(await loadPhaseCheckpoint(identity(), { now: later })).toBeNull();
  });

  it("tampered stored bindings refuse to load", async () => {
    hoisted.docs.clear();
    const { key } = await writePhaseCheckpoint(identity(), "verified", { now });
    const path = `${PHASE_CHECKPOINT_COLLECTION}/${key}`;
    const doc = hoisted.docs.get(path)!;
    hoisted.docs.set(path, {
      ...doc,
      bindings: { ...(doc.bindings as Record<string, string>), principalHash: "0".repeat(32) },
    });
    expect(await loadPhaseCheckpoint(identity(), { now })).toBeNull();
  });

  it("a legacy phone-keyed rescue doc is never mistaken for a phase checkpoint", async () => {
    hoisted.docs.clear();
    // Legacy doc shape at a phone-keyed id (turnCheckpoint.ts) — different id
    // space, but even a hypothetical id collision is rejected by schema.
    hoisted.docs.set(`${PHASE_CHECKPOINT_COLLECTION}/+14085550100`, {
      phase: "loop_complete", reply: "…", expiresAt: now.getTime() + 60_000,
    });
    expect(await loadPhaseCheckpoint(identity(), { now })).toBeNull();
  });

  it("replay: retry loads the acted checkpoint and the directive forbids re-acting (R21)", async () => {
    hoisted.docs.clear();
    await writePhaseCheckpoint(identity(), "acted", {
      completedActionKeys: ["request_booking:abc123", "send_caregiver_message:def456"],
      now,
    });
    const cp = await loadPhaseCheckpoint(identity(), { now });
    const directive = buildResumeDirective(cp);
    expect(directive).toContain("ALREADY COMPLETED");
    expect(directive).toContain("request_booking:abc123");
    expect(directive).toContain("send_caregiver_message:def456");
    expect(directive).toMatch(/never repeat a completed side effect/);
  });

  it("no directive for hydrated-only or action-free checkpoints (fresh turns act normally)", () => {
    const base: PhaseCheckpointDoc = {
      schema: "phase-v1", phase: "hydrated",
      bindings: { principalHash: "x", channelBindingHash: "y" },
      objectiveVersion: 0, completedActionKeys: [],
      updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 1000).toISOString(),
    };
    expect(buildResumeDirective(null)).toBe("");
    expect(buildResumeDirective(base)).toBe("");
    expect(buildResumeDirective({ ...base, phase: "acted" })).toBe(""); // no committed actions
    expect(buildResumeDirective({ ...base, phase: "responded", completedActionKeys: ["k"] })).toContain("k");
  });

  it("stores no raw identifiers in the checkpoint document", async () => {
    hoisted.docs.clear();
    const { key } = await writePhaseCheckpoint(identity(), "hydrated", { now });
    const raw = JSON.stringify(hoisted.docs.get(`${PHASE_CHECKPOINT_COLLECTION}/${key}`));
    expect(raw).not.toContain("4085550100");
    expect(raw).not.toContain("chat-1");
    expect(raw).not.toContain("evt-abc");
  });
});
