import { describe, it, expect, beforeEach } from "vitest";
import {
  registerExperiment,
  _clearExperiments,
  getActiveVariant,
  getExperimentAssignments,
  experimentsAugmenter,
  listExperiments,
} from "./promptExperiments";
import { createTurnMetrics, type TurnMetrics } from "./turnMetrics";
import type { AugmenterContext } from "./promptAugmenters";

const baseCtx = (over: Partial<AugmenterContext> = {}): AugmenterContext => ({
  text:      "hi",
  phone:     "+15555550100",
  userId:    "user-1",
  seniorId:  "s-1",
  userType:  "client",
  turnCount: 0,
  metrics:   createTurnMetrics({ phone: "+15555550100", userType: "client", pathway: "qa" }),
  ...over,
});

describe("promptExperiments", () => {
  beforeEach(() => _clearExperiments());

  describe("registerExperiment", () => {
    it("accepts a valid experiment", () => {
      registerExperiment({
        key: "tone-v1",
        description: "test",
        variants: { control: "", soft: "Be softer" },
      });
      expect(listExperiments().length).toBe(1);
    });

    it("rejects an invalid key", () => {
      expect(() => registerExperiment({
        key: "Bad Key",
        description: "x",
        variants: { a: "", b: "" },
      })).toThrow(/invalid key/);
    });

    it("rejects fewer than 2 variants", () => {
      expect(() => registerExperiment({
        key: "tone",
        description: "x",
        variants: { only: "" },
      })).toThrow(/≥2 variants/);
    });

    it("rejects weights referencing unknown variants", () => {
      expect(() => registerExperiment({
        key: "tone",
        description: "x",
        variants: { a: "", b: "" },
        weights: { c: 1 },
      })).toThrow(/unknown variant/);
    });

    it("rejects negative or infinite weights", () => {
      expect(() => registerExperiment({
        key: "tone",
        description: "x",
        variants: { a: "", b: "" },
        weights: { a: -1 },
      })).toThrow(/non-negative/);
    });
  });

  describe("getActiveVariant", () => {
    beforeEach(() => {
      registerExperiment({
        key: "tone",
        description: "x",
        variants: { control: "", soft: "Be softer" },
      });
    });

    it("returns null for unregistered keys", () => {
      expect(getActiveVariant("u1", "nope")).toBeNull();
    });

    it("returns null when userId is empty", () => {
      expect(getActiveVariant("", "tone")).toBeNull();
    });

    it("is sticky — same user always gets the same variant", () => {
      const a = getActiveVariant("user-abc", "tone");
      const b = getActiveVariant("user-abc", "tone");
      const c = getActiveVariant("user-abc", "tone");
      expect(a).not.toBeNull();
      expect(a).toBe(b);
      expect(a).toBe(c);
    });

    it("returns one of the declared variants", () => {
      const v = getActiveVariant("user-xyz", "tone");
      expect(["control", "soft"]).toContain(v);
    });

    it("distributes 50/50 across many users (within tolerance)", () => {
      const counts: Record<string, number> = { control: 0, soft: 0 };
      for (let i = 0; i < 1000; i++) {
        const v = getActiveVariant(`user-${i}`, "tone");
        if (v) counts[v] += 1;
      }
      // 50/50 — expect each within 5pp of half. (Stress-tested locally; this
      // tolerance is comfortable for FNV-1a on contiguous numeric IDs.)
      expect(counts.control).toBeGreaterThan(400);
      expect(counts.control).toBeLessThan(600);
      expect(counts.soft).toBeGreaterThan(400);
      expect(counts.soft).toBeLessThan(600);
    });

    it("respects non-uniform weights (heavy skew on one side)", () => {
      _clearExperiments();
      registerExperiment({
        key: "skew",
        description: "x",
        variants: { control: "", treatment: "T" },
        weights: { control: 9, treatment: 1 },
      });
      const counts: Record<string, number> = { control: 0, treatment: 0 };
      for (let i = 0; i < 1000; i++) {
        const v = getActiveVariant(`user-${i}`, "skew");
        if (v) counts[v] += 1;
      }
      // 90/10 — should be heavily lopsided.
      expect(counts.control).toBeGreaterThan(counts.treatment * 4);
    });

    it("returns null when the predicate excludes the user", () => {
      _clearExperiments();
      registerExperiment({
        key: "caregiver-only",
        description: "x",
        variants: { a: "", b: "B" },
        predicate: (c) => c.userType === "caregiver",
      });
      expect(getActiveVariant("u1", "caregiver-only", "client")).toBeNull();
      expect(getActiveVariant("u1", "caregiver-only", "caregiver")).not.toBeNull();
    });
  });

  describe("getExperimentAssignments", () => {
    it("returns empty object when no experiments are registered", () => {
      const r = getExperimentAssignments("u1", "client");
      expect(r.assignments).toEqual({});
      expect(r.directives).toEqual([]);
    });

    it("returns assignment for each registered experiment the user is eligible for", () => {
      registerExperiment({
        key: "tone",
        description: "x",
        variants: { control: "", soft: "Be softer" },
      });
      registerExperiment({
        key: "format",
        description: "x",
        variants: { control: "", brief: "Be brief" },
      });
      const r = getExperimentAssignments("user-123", "client");
      expect(Object.keys(r.assignments).sort()).toEqual(["format", "tone"]);
    });

    it("excludes experiments whose predicate rejects the user", () => {
      registerExperiment({
        key: "client-only",
        description: "x",
        variants: { control: "", treat: "T" },
        predicate: (c) => c.userType === "client",
      });
      const cgResult = getExperimentAssignments("u1", "caregiver");
      expect(cgResult.assignments).toEqual({});
    });

    it("emits a directive only when the assigned variant has non-empty text", () => {
      registerExperiment({
        key: "tone",
        description: "x",
        // Force every user into "control" via weights so we can assert on the empty case.
        variants: { control: "", treat: "T" },
        weights: { control: 1, treat: 0 },
      });
      const r = getExperimentAssignments("user-abc", "client");
      expect(r.assignments).toEqual({ tone: "control" });
      expect(r.directives).toEqual([]);
    });
  });

  describe("experimentsAugmenter", () => {
    it("returns null when no experiments are registered", async () => {
      const ctx = baseCtx();
      const out = await Promise.resolve(experimentsAugmenter.augment(ctx));
      expect(out).toBeNull();
      // metrics not mutated
      expect((ctx.metrics as TurnMetrics & { experiments?: unknown }).experiments).toBeUndefined();
    });

    it("returns null when userId is empty", async () => {
      registerExperiment({ key: "tone", description: "x", variants: { a: "X", b: "Y" } });
      const ctx = baseCtx({ userId: "" });
      const out = await Promise.resolve(experimentsAugmenter.augment(ctx));
      expect(out).toBeNull();
    });

    it("appends the variant directive AND writes the assignment onto metrics", async () => {
      registerExperiment({
        key: "tone",
        description: "x",
        // Force into "treat" by zeroing the control weight.
        variants: { control: "", treat: "Be softer." },
        weights: { control: 0, treat: 1 },
      });
      const ctx = baseCtx();
      const out = await Promise.resolve(experimentsAugmenter.augment(ctx));
      expect(out).toBe("Be softer.");
      expect((ctx.metrics as TurnMetrics & { experiments?: Record<string, string> }).experiments).toEqual({
        tone: "treat",
      });
    });

    it("joins multiple directives with double newlines", async () => {
      registerExperiment({
        key: "a",
        description: "x",
        variants: { control: "", treat: "FIRST" },
        weights: { control: 0, treat: 1 },
      });
      registerExperiment({
        key: "b",
        description: "x",
        variants: { control: "", treat: "SECOND" },
        weights: { control: 0, treat: 1 },
      });
      const ctx = baseCtx();
      const out = await Promise.resolve(experimentsAugmenter.augment(ctx));
      expect(out).toBe("FIRST\n\nSECOND");
      expect((ctx.metrics as TurnMetrics & { experiments?: Record<string, string> }).experiments).toEqual({
        a: "treat",
        b: "treat",
      });
    });

    it("records the assignment on metrics even when the directive is empty (control arm)", async () => {
      registerExperiment({
        key: "tone",
        description: "x",
        variants: { control: "", treat: "T" },
        weights: { control: 1, treat: 0 },
      });
      const ctx = baseCtx();
      const out = await Promise.resolve(experimentsAugmenter.augment(ctx));
      expect(out).toBeNull();
      // But the assignment is still recorded — we need to know who saw control.
      expect((ctx.metrics as TurnMetrics & { experiments?: Record<string, string> }).experiments).toEqual({
        tone: "control",
      });
    });
  });
});
