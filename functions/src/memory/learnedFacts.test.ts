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
    where: () => ({
      limit: () => ({
        get: async () => ({ docs: [] }),
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

import { detectAndApplyCorrection } from "./learnedFacts";

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
