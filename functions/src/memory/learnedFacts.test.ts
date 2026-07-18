import { describe, expect, it, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  facts: new Map<string, Record<string, unknown>>(),
  quickComplete: vi.fn(),
}));

vi.mock("firebase-admin", () => {
  const factDoc = (id: string) => ({
    id,
    get: async () => ({
      exists: h.facts.has(id),
      data: () => h.facts.get(id),
    }),
  });

  const factsCollection = {
    doc: (id?: string) => factDoc(id ?? `auto-${h.facts.size + 1}`),
    add: async (data: Record<string, unknown>) => {
      const id = `auto-${h.facts.size + 1}`;
      h.facts.set(id, data);
      return { id };
    },
    // Functional _norm filter (KTD7 legacy-doc lookup path); matched docs carry
    // id/data/ref like real query snapshots.
    where: (field: string, _op: string, value: unknown) => ({
      limit: () => ({
        get: async () => ({
          docs: [...h.facts.entries()]
            .filter(([, data]) => (data as Record<string, unknown>)[field] === value)
            .map(([id, data]) => ({ id, data: () => data, ref: factDoc(id) })),
        }),
      }),
    }),
    orderBy: () => ({
      limit: () => ({
        get: async () => ({
          docs: [...h.facts.entries()].map(([id, data]) => ({
            id,
            data: () => data,
          })),
        }),
      }),
    }),
  };

  const firestore = () => ({
    collection: (name: string) => ({
      doc: (_userId: string) => ({
        collection: (_sub: string) => {
          if (name !== "learned_facts") throw new Error(`unexpected collection ${name}`);
          return factsCollection;
        },
      }),
    }),
    runTransaction: async (fn: (t: { get: (ref: { id: string }) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>; set: (ref: { id: string }, data: Record<string, unknown>) => void; update: (ref: { id: string }, data: Record<string, unknown>) => void }) => Promise<void>) => {
      await fn({
        get: async (ref) => ({
          exists: h.facts.has(ref.id),
          data: () => h.facts.get(ref.id),
        }),
        set: (ref, data) => { h.facts.set(ref.id, data); },
        update: (ref, data) => {
          h.facts.set(ref.id, { ...(h.facts.get(ref.id) ?? {}), ...data });
        },
      });
    },
  });

  return { __esModule: true, default: { firestore }, firestore };
});

vi.mock("../utils/openaiClient", () => ({
  quickComplete: h.quickComplete,
}));

vi.mock("./embeddings", () => ({
  embedText: vi.fn(async () => null),
  rankBySimilarity: vi.fn(),
  EMBED_MODEL: "test-embedding",
}));

import {
  detectAndApplyCorrection,
  extractAndStoreFacts,
  deterministicFactDocId,
  MENTION_TURN_KEYS_MAX,
  FACT_SOURCE_REFS_MAX,
} from "./learnedFacts";

beforeEach(() => {
  h.facts.clear();
  h.quickComplete.mockReset();
});

describe("detectAndApplyCorrection", () => {
  it("retracts a learned fact when the user asks Evia to forget it", async () => {
    h.facts.set("fact-1", {
      userId: "u1",
      fact: "Mom is allergic to shellfish",
      weight: 8,
      category: "medical",
      createdAt: "2026-06-01T00:00:00.000Z",
      lastMentionedAt: "2026-06-10T00:00:00.000Z",
    });
    h.quickComplete.mockResolvedValueOnce('{"corrects":0,"newFact":null}');

    const applied = await detectAndApplyCorrection("u1", "forget what I said about the shellfish allergy");

    expect(applied).toBe(true);
    expect(h.facts.get("fact-1")?.supersededAt).toEqual(expect.any(String));
    expect(h.facts.get("fact-1")?.supersededBy).toBeUndefined();
  });

  it("leaves facts untouched when the model judges the message is not a correction", async () => {
    h.facts.set("fact-1", {
      userId: "u1",
      fact: "Mom prefers morning visits",
      weight: 4,
      category: "preference",
      createdAt: "2026-06-01T00:00:00.000Z",
      lastMentionedAt: "2026-06-10T00:00:00.000Z",
    });
    // Intent is judged by the LLM (no regex pre-filter); for an ordinary
    // message it returns "null" and no fact is changed.
    h.quickComplete.mockResolvedValueOnce("null");

    const applied = await detectAndApplyCorrection("u1", "thanks that sounds good");

    expect(applied).toBe(false);
    expect(h.facts.get("fact-1")?.supersededAt).toBeUndefined();
  });
});

// ── KTD7: concurrency/retry-safe fact writes (memory-grounding U3) ───────────
//
// New facts land at a DETERMINISTIC normalized-fact doc key inside a
// transaction (the query-then-add() race is structurally gone), a retried
// extraction increments a fact at most once per source-turn key, and bounded
// source-turn/message provenance is recorded (R23 groundwork).

const FACT = "Mom is allergic to shellfish";
const EXTRACTION = JSON.stringify([{ fact: FACT, category: "medical" }]);
const TURN_TEXT = "just so you know, mom is allergic to shellfish";
const PROVENANCE = {
  sourceTurnKeyHash: "hash-turn-1",
  sourceMessageRefs: ["agent_conversations/+1/messages/turn_a_user", "agent_conversations/+1/messages/turn_a_assistant"],
};

describe("extractAndStoreFacts — deterministic idempotent writes (KTD7)", () => {
  it("creates a new fact at the deterministic normalized-fact doc ID with mention + provenance ledgers", async () => {
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);

    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE);

    const docId = deterministicFactDocId(FACT);
    expect(docId).toMatch(/^nf_[0-9a-f]{24}$/);
    const stored = h.facts.get(docId);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      userId: "u1",
      fact: FACT,
      weight: 1,
      category: "medical",
      mentionTurnKeys: ["hash-turn-1"],
      sourceMessageRefs: PROVENANCE.sourceMessageRefs,
    });
    // Same normalization → same doc ID regardless of casing/whitespace.
    expect(deterministicFactDocId("  MOM is   allergic to Shellfish ")).toBe(docId);
  });

  it("a RETRIED extraction with the same source-turn key increments at most once (worker retry safety)", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE);
    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE); // retry, same turn key
    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE); // retry again

    const stored = h.facts.get(deterministicFactDocId(FACT))!;
    expect(stored.weight).toBe(1);
    expect(stored.mentionTurnKeys).toEqual(["hash-turn-1"]);
    // And no duplicate doc was minted anywhere.
    expect([...h.facts.keys()]).toEqual([deterministicFactDocId(FACT)]);
  });

  it("a genuinely NEW mention (different source-turn key) increments the weight and appends the key", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE);
    await extractAndStoreFacts("u1", TURN_TEXT, undefined, { ...PROVENANCE, sourceTurnKeyHash: "hash-turn-2" });

    const stored = h.facts.get(deterministicFactDocId(FACT))!;
    expect(stored.weight).toBe(2);
    expect(stored.mentionTurnKeys).toEqual(["hash-turn-1", "hash-turn-2"]);
  });

  it("a legacy auto-ID active fact with the same normalized text is updated in place — no deterministic duplicate", async () => {
    h.facts.set("legacy-1", {
      userId: "u1", fact: FACT, _norm: FACT.toLowerCase(), weight: 4, category: "medical",
      createdAt: "2026-06-01T00:00:00.000Z", lastMentionedAt: "2026-06-10T00:00:00.000Z",
    });
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);

    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE);

    expect(h.facts.get("legacy-1")!.weight).toBe(5);
    expect(h.facts.get("legacy-1")!.mentionTurnKeys).toEqual(["hash-turn-1"]);
    expect(h.facts.has(deterministicFactDocId(FACT))).toBe(false);
  });

  it("a superseded fact at the deterministic key is NEVER passively resurrected (R23 groundwork)", async () => {
    const docId = deterministicFactDocId(FACT);
    h.facts.set(docId, {
      userId: "u1", fact: FACT, _norm: FACT.toLowerCase(), weight: 6, category: "medical",
      createdAt: "2026-06-01T00:00:00.000Z", lastMentionedAt: "2026-06-10T00:00:00.000Z",
      supersededAt: "2026-07-01T00:00:00.000Z",
    });
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);

    await extractAndStoreFacts("u1", TURN_TEXT, undefined, PROVENANCE);

    const stored = h.facts.get(docId)!;
    expect(stored.weight).toBe(6);              // untouched
    expect(stored.supersededAt).toBeDefined();  // still retracted
    expect([...h.facts.keys()]).toEqual([docId]); // no replacement doc minted
  });

  it("the legacy 3-arg signature still works: facts store without provenance and re-mentions increment (back-compat)", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    await extractAndStoreFacts("u1", TURN_TEXT);
    await extractAndStoreFacts("u1", TURN_TEXT);

    const stored = h.facts.get(deterministicFactDocId(FACT))!;
    expect(stored.fact).toBe(FACT);
    // No turn key → no idempotency claim; each call is a distinct mention
    // (pre-U3 behavior preserved for legacy callers).
    expect(stored.weight).toBe(2);
    expect(stored.mentionTurnKeys).toEqual([]);
  });

  it("mention and provenance ledgers stay bounded", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    for (let i = 0; i < MENTION_TURN_KEYS_MAX + 5; i++) {
      await extractAndStoreFacts("u1", TURN_TEXT, undefined, {
        sourceTurnKeyHash: `turn-${i}`,
        sourceMessageRefs: [`agent_conversations/+1/messages/turn_${i}_user`],
      });
    }

    const stored = h.facts.get(deterministicFactDocId(FACT))!;
    expect((stored.mentionTurnKeys as string[]).length).toBe(MENTION_TURN_KEYS_MAX);
    // Most-recent keys are the ones retained.
    expect((stored.mentionTurnKeys as string[]).at(-1)).toBe(`turn-${MENTION_TURN_KEYS_MAX + 4}`);
    expect((stored.sourceMessageRefs as string[]).length).toBeLessThanOrEqual(FACT_SOURCE_REFS_MAX);
    expect(stored.weight).toBe(10); // capped
  });
});
