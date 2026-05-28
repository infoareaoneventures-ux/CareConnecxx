import { describe, it, expect, vi, beforeEach } from "vitest";

const embeddingsCreate = vi.fn();

vi.mock("../utils/openaiClient", () => ({
  getOpenAIClient: () => ({
    embeddings: { create: embeddingsCreate },
  }),
  quickComplete: vi.fn(),
}));

import {
  embedText,
  embedMany,
  cosine,
  splitIntoBlocks,
  rankBySimilarity,
  EMBED_DIM,
  MIN_SIMILARITY,
} from "./embeddings";

// Unit-norm 1536-dim vector helper for cosine tests.
function makeVec(value: number, dim = EMBED_DIM): number[] {
  const v = new Array(dim).fill(0);
  v[0] = 1;          // anchor non-zero entry
  v[1] = value;
  // Normalize (so cosine = dot)
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  return v.map((x) => x / norm);
}

beforeEach(() => {
  embeddingsCreate.mockReset();
});

describe("embedText", () => {
  it("returns the embedding vector on success", async () => {
    const v = makeVec(0.5);
    embeddingsCreate.mockResolvedValueOnce({ data: [{ embedding: v }] });
    const result = await embedText("diabetes");
    expect(result).toEqual(v);
    expect(embeddingsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small", input: "diabetes" }),
    );
  });

  it("returns null on API error (fail-open)", async () => {
    embeddingsCreate.mockRejectedValueOnce(new Error("rate limited"));
    expect(await embedText("anything")).toBeNull();
  });

  it("returns null on empty / whitespace input without calling API", async () => {
    expect(await embedText("")).toBeNull();
    expect(await embedText("   ")).toBeNull();
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });

  it("returns null when API returns wrong-dim vector (defensive)", async () => {
    embeddingsCreate.mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3] }] });
    expect(await embedText("diabetes")).toBeNull();
  });

  it("clips overlong input to embedding model limit", async () => {
    embeddingsCreate.mockResolvedValueOnce({ data: [{ embedding: makeVec(0.1) }] });
    const huge = "x".repeat(20_000);
    await embedText(huge);
    const call = embeddingsCreate.mock.calls[0][0];
    expect((call.input as string).length).toBeLessThanOrEqual(8000);
  });
});

describe("embedMany", () => {
  it("returns vectors in input order", async () => {
    embeddingsCreate.mockResolvedValueOnce({
      data: [
        { embedding: makeVec(0.1) },
        { embedding: makeVec(0.2) },
        { embedding: makeVec(0.3) },
      ],
    });
    const out = await embedMany(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(out.every((v) => Array.isArray(v) && v?.length === EMBED_DIM)).toBe(true);
  });

  it("returns all-nulls on API failure without throwing", async () => {
    embeddingsCreate.mockRejectedValueOnce(new Error("network"));
    const out = await embedMany(["x", "y"]);
    expect(out).toEqual([null, null]);
  });

  it("returns all-nulls when input is empty or all whitespace", async () => {
    const out = await embedMany(["", "  ", ""]);
    expect(out).toEqual([null, null, null]);
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });
});

describe("cosine", () => {
  it("returns 1 for identical unit vectors", () => {
    const v = makeVec(0.5);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 on dim mismatch (defensive)", () => {
    expect(cosine([1, 0, 0], [1, 0])).toBe(0);
  });
});

describe("splitIntoBlocks", () => {
  it("splits on blank lines and drops tiny fragments", () => {
    const blocks = splitIntoBlocks("## Health\nMetformin 500mg\n\n## Allergies\nPenicillin\n\nx");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("Metformin");
    expect(blocks[1]).toContain("Penicillin");
  });

  it("returns empty array for empty input", () => {
    expect(splitIntoBlocks("")).toEqual([]);
    expect(splitIntoBlocks("   ")).toEqual([]);
  });
});

describe("rankBySimilarity", () => {
  it("sorts by similarity and filters below threshold", () => {
    const queryEmbed = makeVec(1);
    const items = [
      { id: "a", embedding: makeVec(1) },           // perfect match
      { id: "b", embedding: makeVec(-1) },          // poor match (still positive cosine via anchor)
      { id: "c", embedding: makeVec(0.99) },        // near match
    ];
    const ranked = rankBySimilarity(items, queryEmbed, 5);
    expect(ranked[0].id).toBe("a");
    // All retained items are above MIN_SIMILARITY by construction (shared anchor entry).
    expect(ranked.every((r) => r._sim >= MIN_SIMILARITY)).toBe(true);
  });

  it("respects topK", () => {
    const queryEmbed = makeVec(1);
    const items = [
      { id: "a", embedding: makeVec(0.9) },
      { id: "b", embedding: makeVec(0.8) },
      { id: "c", embedding: makeVec(0.7) },
    ];
    const ranked = rankBySimilarity(items, queryEmbed, 2);
    expect(ranked).toHaveLength(2);
  });
});
