/**
 * Vector embedding layer for Evia's memory.
 *
 * Sprint 2 / roadmap §4.5 — substring search alone misses "T2DM" → "diabetes",
 * "fall" → "tripped Tuesday", "Dr. Patel" → "doctor". We add semantic recall
 * on top, fed by OpenAI text-embedding-3-small. Hybrid (substring ∪ cosine)
 * gives both exact recall and synonym recall.
 *
 * Design notes:
 *   • Fail open. If the embedding API errors or the key is missing, we return
 *     null and callers fall back to substring. NEVER throw from these helpers.
 *   • text-embedding-3-small is 1536-dim, $0.02 per 1M tokens — basically free
 *     at our volume. Storage cost on Firestore (~6KB per vector) is the bigger
 *     concern; we keep ≤30 blocks per user per file.
 *   • Cosine similarity is plain dot product over normalized vectors. OpenAI
 *     returns unit-norm vectors so we skip the norm step.
 */

import { getOpenAIClient } from "../utils/openaiClient";

export const EMBED_MODEL  = "text-embedding-3-small";
export const EMBED_DIM    = 1536;

// Below this threshold we don't treat a hit as semantically relevant. Picked
// empirically — adjust after telemetry shows real recall/precision numbers.
export const MIN_SIMILARITY = 0.35;

/**
 * Embed a single piece of text. Returns null on any failure (missing key,
 * network, API error, malformed response). Callers should treat null as
 * "skip semantic, use substring only".
 */
export async function embedText(text: string): Promise<number[] | null> {
  const clean = (text ?? "").trim();
  if (!clean) return null;

  try {
    const res = await getOpenAIClient().embeddings.create({
      model: EMBED_MODEL,
      input: clean.slice(0, 8000), // text-embedding-3-small input cap is 8191 tokens
    });
    const vec = res.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) return null;
    return vec;
  } catch (err) {
    console.warn("[embeddings] embedText failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Embed multiple texts in a single API call. Same fail-open semantics — if
 * any error occurs, returns an array of nulls so per-item logic can degrade
 * to substring.
 */
export async function embedMany(texts: string[]): Promise<Array<number[] | null>> {
  const input = texts.map((t) => (t ?? "").trim().slice(0, 8000));
  if (input.length === 0 || input.every((t) => !t)) {
    return texts.map(() => null);
  }

  try {
    const res = await getOpenAIClient().embeddings.create({
      model: EMBED_MODEL,
      input,
    });
    return texts.map((_, i) => {
      const vec = res.data?.[i]?.embedding;
      return Array.isArray(vec) && vec.length === EMBED_DIM ? vec : null;
    });
  } catch (err) {
    console.warn("[embeddings] embedMany failed:", err instanceof Error ? err.message : err);
    return texts.map(() => null);
  }
}

/**
 * Cosine similarity. OpenAI returns unit-norm vectors so this collapses to a
 * dot product. Defensive against mismatched dims (returns 0).
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Split memory-file content into searchable blocks. We split on blank lines
 * (paragraphs / sections) to match the existing substring search's block
 * boundaries, and skip tiny fragments that would just match noise.
 */
export function splitIntoBlocks(content: string): string[] {
  return (content ?? "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 8);
}

/**
 * Rank items by cosine similarity to a query embedding. Returns items above
 * MIN_SIMILARITY, sorted descending, capped at `topK`.
 */
export function rankBySimilarity<T extends { embedding: number[] }>(
  items:        T[],
  queryEmbed:   number[],
  topK     = 8,
  minSim   = MIN_SIMILARITY,
): Array<T & { _sim: number }> {
  return items
    .map((it) => ({ ...it, _sim: cosine(it.embedding, queryEmbed) }))
    .filter((it) => it._sim >= minSim)
    .sort((a, b) => b._sim - a._sim)
    .slice(0, topK);
}
