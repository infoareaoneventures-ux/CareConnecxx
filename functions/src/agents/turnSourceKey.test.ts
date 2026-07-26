import { describe, expect, it } from "vitest";

import {
  deriveSourceTurnKey,
  deriveBindings,
  validateSourceTurn,
  createVerticalExecutionContext,
  deriveConversationPartitionId,
  careVerticalFromConversationPartitionId,
  CONVERSATION_PARTITION_SCHEMA,
  type SourceTurnIdentity,
} from "./turnSourceKey";

const identity = (over: Partial<SourceTurnIdentity> = {}): SourceTurnIdentity => ({
  channel: "linq",
  principal: "+14085550100",
  conversationId: "chat-1",
  messageId: "evt-abc",
  objectiveVersion: 0,
  careVertical: "senior",
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
    expect(deriveSourceTurnKey(identity({ careVertical: "child" })))
      .not.toBe(deriveSourceTurnKey(identity({ careVertical: "senior" })));
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

describe("deriveConversationPartitionId", () => {
  it("creates stable, distinct physical partitions without embedding the principal", () => {
    const senior = deriveConversationPartitionId("+14085550100", "senior");
    const child = deriveConversationPartitionId("+14085550100", "child");

    expect(senior).toMatch(new RegExp(`^${CONVERSATION_PARTITION_SCHEMA}_senior_[0-9a-f]{32}$`));
    expect(child).toMatch(new RegExp(`^${CONVERSATION_PARTITION_SCHEMA}_child_[0-9a-f]{32}$`));
    expect(senior).not.toBe(child);
    expect(senior + child).not.toContain("4085550100");
    expect(careVerticalFromConversationPartitionId(senior)).toBe("senior");
    expect(careVerticalFromConversationPartitionId(child)).toBe("child");
    expect(careVerticalFromConversationPartitionId("+14085550100")).toBeNull();
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

describe("createVerticalExecutionContext", () => {
  it("creates an immutable child context with a complete source turn", () => {
    const context = createVerticalExecutionContext({
      principal: "family-1",
      careVertical: "child",
      channel: "web",
      conversationPartition: "child:family-1",
      sourceTurn: { conversationId: "chat-1", messageId: "message-1" },
    });

    expect(context).toMatchObject({
      principal: "family-1",
      careVertical: "child",
      channel: "web",
      conversationPartition: "child:family-1",
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.sourceTurn)).toBe(true);
  });

  it("fails closed when identity, partition, vertical, or source turn is incomplete", () => {
    const valid = {
      principal: "family-1",
      careVertical: "child" as const,
      channel: "web" as const,
      conversationPartition: "child:family-1",
      sourceTurn: { conversationId: "chat-1", messageId: "message-1" },
    };

    expect(() => createVerticalExecutionContext({ ...valid, principal: "" })).toThrow(/principal/);
    expect(() => createVerticalExecutionContext({ ...valid, conversationPartition: "" })).toThrow(/partition/);
    expect(() => createVerticalExecutionContext({
      ...valid,
      sourceTurn: { ...valid.sourceTurn, messageId: "" },
    })).toThrow(/source turn/);
  });
});
