import { describe, expect, it } from "vitest";

import {
  deriveSourceTurnKey,
  deriveBindings,
  validateSourceTurn,
  type SourceTurnIdentity,
} from "./turnSourceKey";

const identity = (over: Partial<SourceTurnIdentity> = {}): SourceTurnIdentity => ({
  channel: "linq",
  principal: "+14085550100",
  conversationId: "chat-1",
  messageId: "evt-abc",
  objectiveVersion: 0,
  ...over,
});

describe("deriveSourceTurnKey (U4/R21/AE21)", () => {
  it("is deterministic and shaped like a 32-hex doc id", () => {
    const k = deriveSourceTurnKey(identity());
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveSourceTurnKey(identity())).toBe(k);
  });

  it("AE21: same client message id under a different account or channel yields a different key", () => {
    const base = deriveSourceTurnKey(identity());
    expect(deriveSourceTurnKey(identity({ principal: "+14085550999" }))).not.toBe(base);
    expect(deriveSourceTurnKey(identity({ channel: "web", principal: "uid-1" }))).not.toBe(base);
    expect(deriveSourceTurnKey(identity({ conversationId: "chat-2" }))).not.toBe(base);
  });

  it("a newer objective version produces a new key — stale checkpoints cannot attach to newer state", () => {
    expect(deriveSourceTurnKey(identity({ objectiveVersion: 1 })))
      .not.toBe(deriveSourceTurnKey(identity({ objectiveVersion: 0 })));
  });

  it("fails closed on incomplete identity — raw/partial ids never become keys", () => {
    expect(() => deriveSourceTurnKey(identity({ messageId: "" }))).toThrow(/incomplete turn identity/);
    expect(() => deriveSourceTurnKey(identity({ principal: "" }))).toThrow(/incomplete/);
    expect(() => deriveSourceTurnKey(identity({ objectiveVersion: -1 }))).toThrow(/objectiveVersion/);
    expect(() => deriveSourceTurnKey(identity({ objectiveVersion: 1.5 }))).toThrow(/objectiveVersion/);
  });

  it("never embeds raw identifiers in the key or bindings", () => {
    const id = identity();
    const key = deriveSourceTurnKey(id);
    const bindings = deriveBindings(id);
    const all = key + JSON.stringify(bindings);
    expect(all).not.toContain("4085550100");
    expect(all).not.toContain("chat-1");
    expect(all).not.toContain("evt-abc");
  });
});

describe("validateSourceTurn (resume gate)", () => {
  const stored = (id: SourceTurnIdentity) => ({
    key: deriveSourceTurnKey(id),
    bindings: deriveBindings(id),
  });

  it("accepts the exact same verified identity", () => {
    expect(validateSourceTurn(identity(), stored(identity()))).toBe(true);
  });

  it("refuses a different principal, channel, or conversation — even with the right key shape", () => {
    const s = stored(identity());
    expect(validateSourceTurn(identity({ principal: "+14085550999" }), s)).toBe(false);
    expect(validateSourceTurn(identity({ channel: "web" }), s)).toBe(false);
    expect(validateSourceTurn(identity({ conversationId: "chat-2" }), s)).toBe(false);
  });

  it("refuses when the stored binding hashes were tampered", () => {
    const s = stored(identity());
    expect(validateSourceTurn(identity(), {
      key: s.key,
      bindings: { ...s.bindings, principalHash: "0".repeat(32) },
    })).toBe(false);
  });

  it("incomplete identity can never validate (no throw leak)", () => {
    expect(validateSourceTurn(identity({ messageId: "" }), stored(identity()))).toBe(false);
  });
});
