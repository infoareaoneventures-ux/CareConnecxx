import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { quickComplete } from "../utils/openaiClient";
import { embedText, rankBySimilarity, EMBED_MODEL } from "./embeddings";

const db = admin.firestore();

export type FactCategory = "medical" | "preference" | "routine" | "family";

export interface LearnedFact {
  userId:          string;
  fact:            string;
  weight:          number;           // 1–10; increments on re-mention
  category:        FactCategory;
  createdAt:       string;
  lastMentionedAt: string;
  supersededAt?:   string;           // ISO — set when this fact is replaced or retracted
  supersededBy?:   string;           // docId of the replacement fact
  /** Bounded per-turn mention ledger (KTD7): a retried extraction increments at most once per source-turn key. */
  mentionTurnKeys?: string[];
  /** Bounded source-row provenance (R23 groundwork) — Firestore paths, never copied text. */
  sourceMessageRefs?: string[];
}

export interface LearnedFactWithId extends LearnedFact {
  _docId: string;
}

// Normalize a fact string for deduplication comparison
function normalizeFact(fact: string): string {
  return fact.toLowerCase().replace(/\s+/g, " ").trim();
}

// KTD7: deterministic normalized-fact doc key. Two concurrent extractions of
// the same fact target the SAME document ref inside a transaction, so the
// query-then-add() race that produced duplicate facts is structurally gone.
// Legacy auto-ID facts remain addressable via the _norm index (see below).
export function deterministicFactDocId(fact: string): string {
  return `nf_${createHash("sha256").update(normalizeFact(fact)).digest("hex").slice(0, 24)}`;
}

/** Bounds for the per-fact mention/provenance ledgers (KTD7 / R23). */
export const MENTION_TURN_KEYS_MAX = 20;
export const FACT_SOURCE_REFS_MAX = 6;

export interface FactWriteProvenance {
  /** Opaque source-turn key hash — makes retried extraction idempotent per turn. */
  sourceTurnKeyHash?: string;
  /** Firestore paths of the turn's source rows (bounded; never copied text). */
  sourceMessageRefs?: string[];
}

function mergeBoundedRefs(existing: unknown, incoming: string[] | undefined): string[] | null {
  if (!incoming || incoming.length === 0) return null;
  const base = Array.isArray(existing) ? (existing as string[]) : [];
  const merged = [...base];
  for (const ref of incoming) if (!merged.includes(ref)) merged.push(ref);
  return merged.slice(-FACT_SOURCE_REFS_MAX);
}

// Recency decay applied at QUERY time (not at write time — stored weight is the
// underlying truth). Half-life of 90 days, so a fact mentioned 90 days ago has
// half the effective weight of one mentioned today. Prevents old facts from
// dominating retrieval just because they accumulated weight long ago.
const DECAY_HALF_LIFE_DAYS = 90;

function effectiveWeight(weight: number, lastMentionedAt?: string): number {
  if (!lastMentionedAt) return weight;
  const ts = Date.parse(lastMentionedAt);
  if (!Number.isFinite(ts)) return weight;
  const daysAgo = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  const decay   = Math.pow(0.5, daysAgo / DECAY_HALF_LIFE_DAYS);
  return weight * decay;
}

// Strip common LLM JSON wrappers (markdown code fences, leading prose).
// gpt-4o-mini and Claude both occasionally return JSON wrapped in ```json ... ```
// or with a stray sentence before the array; we extract the JSON substring.
function unwrapJson(raw: string): string {
  let s = (raw ?? "").trim();
  // Strip leading/trailing markdown code fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // If extra prose precedes the array, find the first '[' and last ']'
  const start = s.indexOf("[");
  const end   = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

export async function extractAndStoreFacts(
  userId:     string,
  text:       string,
  zepUserId?:  string,
  provenance?: FactWriteProvenance
): Promise<void> {
  if (!text || text.length < 10) return;

  let extracted: Array<{ fact: string; category: FactCategory }> = [];
  try {
    const raw = await quickComplete(
      "Extract persistent, reusable facts about the user's care situation from this message. " +
        "Categories: medical (diagnoses, meds, allergies), preference (likes/dislikes, habits), " +
        "routine (schedule, recurring activities), family (relationships, names). " +
        "Only extract facts that are clearly stated and would be useful in future conversations. " +
        "Reply with ONLY a raw JSON array (no markdown, no prose): " +
        "[{\"fact\": \"...\", \"category\": \"medical|preference|routine|family\"}]. " +
        "Return [] if nothing worth storing.",
      text,
      { maxTokens: 300 },
    );
    const cleaned = unwrapJson(raw);
    if (!cleaned) return;
    extracted = JSON.parse(cleaned);
  } catch (err) {
    console.warn("[learnedFacts] extractAndStoreFacts failed:", err instanceof Error ? err.message : err, { userId });
    return;
  }

  if (!Array.isArray(extracted) || extracted.length === 0) return;

  const factsCol  = db.collection("learned_facts").doc(userId).collection("facts");
  const nowIso    = new Date().toISOString();
  const newFacts: Array<{ fact: string; category: FactCategory }> = [];

  for (const item of extracted) {
    if (!item.fact || !item.category) continue;
    const norm = normalizeFact(item.fact);
    const deterministicRef = factsCol.doc(deterministicFactDocId(item.fact));

    // Legacy auto-ID docs predate the deterministic key — find an ACTIVE one
    // through the _norm index so a re-mention updates it instead of minting a
    // deterministic duplicate. Fail-open: a failed query falls back to the
    // deterministic ref.
    const legacySnap = await factsCol
      .where("_norm", "==", norm)
      .limit(5)
      .get()
      .catch(() => ({ docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] }));
    const legacyActive = legacySnap.docs.find(
      (d) => d.id !== deterministicRef.id && !d.data().supersededAt,
    );

    // Embed BEFORE the transaction (no network calls inside transactions);
    // only used on create. Fail-open: null embedding still stores the fact.
    const embedding = await embedText(item.fact);

    let createdNew = false;
    // KTD7: the read-modify-write is transactional, so two concurrent
    // extractions serialize instead of both passing a stale dedupe check.
    await db.runTransaction(async (t) => {
      createdNew = false;
      const targetRef = legacyActive ? legacyActive.ref : deterministicRef;
      const snap = await t.get(targetRef);
      if (snap.exists) {
        const data = snap.data() ?? {};
        // Superseded/retracted facts are never passively resurrected here —
        // correction/forget semantics own that doc (R23 groundwork).
        if (data.supersededAt) return;
        const mentionKeys: string[] = Array.isArray(data.mentionTurnKeys) ? data.mentionTurnKeys : [];
        const turnKey = provenance?.sourceTurnKeyHash;
        // Retried extraction (worker retry, duplicate delivery) increments a
        // fact AT MOST ONCE per source-turn key.
        if (turnKey && mentionKeys.includes(turnKey)) return;
        const mergedRefs = mergeBoundedRefs(data.sourceMessageRefs, provenance?.sourceMessageRefs);
        t.update(targetRef, {
          weight:          Math.min(Number(data.weight ?? 1) + 1, 10),
          lastMentionedAt: nowIso,
          ...(turnKey ? { mentionTurnKeys: [...mentionKeys, turnKey].slice(-MENTION_TURN_KEYS_MAX) } : {}),
          ...(mergedRefs ? { sourceMessageRefs: mergedRefs } : {}),
        });
      } else {
        createdNew = true;
        t.set(targetRef, {
          userId,
          fact:            item.fact,
          _norm:           norm,
          weight:          1,
          category:        item.category,
          createdAt:       nowIso,
          lastMentionedAt: nowIso,
          mentionTurnKeys: provenance?.sourceTurnKeyHash ? [provenance.sourceTurnKeyHash] : [],
          sourceMessageRefs: (provenance?.sourceMessageRefs ?? []).slice(0, FACT_SOURCE_REFS_MAX),
          ...(embedding ? { embedding, embeddingModel: EMBED_MODEL } : {}),
        });
      }
    });
    if (createdNew) newFacts.push({ fact: item.fact, category: item.category });
  }

  // Push newly-stored facts to Zep knowledge graph (fire-and-forget)
  if (zepUserId && newFacts.length > 0) {
    const { addBusinessDataToZep } = await import("./zepClient");
    addBusinessDataToZep({
      userId: zepUserId,
      data: {
        event_type:  "learned_facts_extracted",
        facts:       newFacts,
        source_text: text.slice(0, 200),
        timestamp:   nowIso,
        data_source: "cara_fact_extraction",
      },
    }).catch(() => {});
  }
}

export async function getRelevantFacts(
  userId: string,
  topic?: string
): Promise<LearnedFactWithId[]> {
  // Fetch top-30 by stored weight (oversample) then re-rank by EFFECTIVE weight
  // = weight × half-life-decay(daysSinceLastMention). Oversampling lets a
  // recent-low-weight fact beat a stale-high-weight fact, which is the whole
  // point of decay. Filter superseded client-side (avoids composite index).
  const snap = await db
    .collection("learned_facts")
    .doc(userId)
    .collection("facts")
    .orderBy("weight", "desc")
    .limit(30)
    .get();

  const active = snap.docs
    .filter((d) => !d.data().supersededAt)
    .map((d) => ({
      userId:          d.data().userId,
      fact:            d.data().fact,
      weight:          d.data().weight,
      category:        d.data().category,
      createdAt:       d.data().createdAt,
      lastMentionedAt: d.data().lastMentionedAt,
      _docId:          d.id,
      _embedding:      (d.data().embedding as number[] | undefined),
      _effectiveWeight: effectiveWeight(d.data().weight ?? 1, d.data().lastMentionedAt),
    }))
    .sort((a, b) => b._effectiveWeight - a._effectiveWeight);

  // When a topic is supplied, re-rank by semantic similarity over the weight-top-20.
  // This blends weight (frequency × salience) with topical relevance — a fact about
  // medications still wins over an irrelevant high-weight family fact when the
  // user asks about meds. Fail-open: if the topic embedding fails, fall back to
  // weight ordering.
  if (topic && topic.trim()) {
    const queryEmbed = await embedText(topic);
    if (queryEmbed) {
      const withEmbed = active.filter((f) => Array.isArray(f._embedding));
      if (withEmbed.length > 0) {
        const ranked = rankBySimilarity(
          withEmbed.map((f) => ({ ...f, embedding: f._embedding as number[] })),
          queryEmbed,
          10,
        );
        return ranked.map((r) => ({
          userId:          r.userId,
          fact:            r.fact,
          weight:          r.weight,
          category:        r.category,
          createdAt:       r.createdAt,
          lastMentionedAt: r.lastMentionedAt,
          _docId:          r._docId,
        } as LearnedFactWithId));
      }
    }
  }

  return active.slice(0, 10).map((f) => ({
    userId:          f.userId,
    fact:            f.fact,
    weight:          f.weight,
    category:        f.category,
    createdAt:       f.createdAt,
    lastMentionedAt: f.lastMentionedAt,
    _docId:          f._docId,
  } as LearnedFactWithId));
}

// Soft-delete an existing fact and optionally replace it with a corrected version.
// Both the new-fact creation and the old-fact supersession are wrapped in a single
// Firestore transaction to prevent the "both facts active" corruption if we crash between writes.
export async function updateOrRetractFact(
  userId:     string,
  oldDocId:   string,
  newFact?:   { fact: string; category: FactCategory },
  zepUserId?: string
): Promise<void> {
  const factsCol = db.collection("learned_facts").doc(userId).collection("facts");
  const nowIso   = new Date().toISOString();

  const oldRef   = factsCol.doc(oldDocId);
  const newRef   = newFact ? factsCol.doc() : null;

  let oldFactText: string | undefined;

  // Embed the corrected fact BEFORE opening the transaction (no network calls
  // allowed inside Firestore transactions). Embedding is best-effort.
  const newEmbedding = newFact ? await embedText(newFact.fact) : null;

  await db.runTransaction(async (t) => {
    const oldSnap = await t.get(oldRef);
    oldFactText   = oldSnap.exists ? (oldSnap.data()?.fact as string | undefined) : undefined;

    if (newRef && newFact) {
      t.set(newRef, {
        userId,
        fact:            newFact.fact,
        _norm:           normalizeFact(newFact.fact),
        weight:          2,   // user explicitly stated — start higher than passive extraction
        category:        newFact.category,
        createdAt:       nowIso,
        lastMentionedAt: nowIso,
        ...(newEmbedding ? { embedding: newEmbedding, embeddingModel: EMBED_MODEL } : {}),
      });
    }

    t.update(oldRef, {
      supersededAt: nowIso,
      ...(newRef ? { supersededBy: newRef.id } : {}),
    });
  });

  // Sync correction to Zep as a bi-temporal event (fire-and-forget, non-blocking)
  if (zepUserId) {
    const { addBusinessDataToZep } = await import("./zepClient");
    addBusinessDataToZep({
      userId:      zepUserId,
      data: {
        event_type:   "fact_correction",
        old_fact:     oldFactText ?? oldDocId,
        new_fact:     newFact?.fact ?? null,
        category:     newFact?.category ?? null,
        corrected_at: nowIso,
        data_source:  "cara_correction",
      },
    }).catch(() => {});
  }
}

// Detect if the user's message corrects a known fact, and apply the correction.
// Returns true if a correction was found and applied.
export async function detectAndApplyCorrection(
  userId:     string,
  text:       string,
  zepUserId?: string
): Promise<boolean> {
  // Per CLAUDE.md, intent (is this a correction/retraction?) must be judged by an
  // LLM, never a regex. We fetch the user's known facts and let the LLM below
  // decide; if there's nothing stored, there's nothing to correct, so bail early.
  const currentFacts = await getRelevantFacts(userId).catch(() => [] as LearnedFactWithId[]);
  if (currentFacts.length === 0) return false;

  const factsJson = currentFacts
    .map((f, i) => `${i}: "${f.fact}" [${f.category}]`)
    .join("\n");

  let raw: string;
  try {
    raw = await quickComplete(
      "The user may be correcting previously stated information about their care situation. " +
        "You are given a numbered list of known facts and the user's message. " +
        "If the message directly corrects one of the known facts, reply with JSON only (no markdown fences): " +
        "{\"corrects\": <index>, \"newFact\": \"<corrected text>\", \"category\": \"medical|preference|routine|family\"}. " +
        "If the message asks you to forget, remove, stop remembering, delete from memory, or retract a fact without replacement, return: " +
        "{\"corrects\": <index>, \"newFact\": null}. " +
        "Only retract a fact the user clearly identifies; do not delete unrelated facts. " +
        "If this is NOT a correction of a known fact, reply with the single word: null",
      `Known facts:\n${factsJson}\n\nUser message: "${text}"`,
      { maxTokens: 200 },
    );
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  } catch {
    return false;
  }

  if (raw === "null" || !raw.startsWith("{")) return false;

  let parsed: { corrects: number; newFact: string | null; category?: FactCategory };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  const targetFact = currentFacts[parsed.corrects];
  if (!targetFact) return false;

  await updateOrRetractFact(
    userId,
    targetFact._docId,
    parsed.newFact
      ? { fact: parsed.newFact, category: parsed.category ?? targetFact.category }
      : undefined,
    zepUserId
  );

  return true;
}
