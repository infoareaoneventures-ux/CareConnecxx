import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { quickComplete } from "../utils/openaiClient";
import { embedText, rankBySimilarity, EMBED_MODEL } from "./embeddings";
import {
  buildFactChangeOperationDoc,
  buildReRememberOperationDoc,
  factChangeOperationId,
  MEMORY_OPERATIONS_COLLECTION,
  MEMORY_RECONCILIATION_COLLECTION,
  reconciliationFlagAdd,
} from "./memoryOperations";
import { hmacFingerprint, tryGetFingerprintKey } from "./fingerprintKey";

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
  /** Bounded source-row provenance (R23) — Firestore paths, never copied text. */
  sourceMessageRefs?: string[];
  // ── U4 correction/forget staging + tombstone fields (KTD9/KTD16, Data Changes) ──
  /** Set while a staged correction's cross-store propagation is unresolved. */
  pendingCorrectionOperationId?: string;
  /** Set while a staged forget's cross-store propagation is unresolved. */
  pendingForgetOperationId?: string;
  /** Server-only HMAC-SHA256 of the normalized retired plaintext — blocks passive re-extraction. */
  forgottenFingerprint?: string;
  /** Key version the fingerprint was stamped with (rotation-safe verification). */
  fingerprintKeyVersion?: number;
  /** Set at forget COMPLETION (U4b) when plaintext/embedding are stripped. */
  forgottenAt?: string;
  /** Bumped by a confirmed re-remember — versions the deterministic operation IDs. */
  changeGeneration?: number;
  /** Set by a confirmed explicit re-remember (KTD16/R23). */
  reRememberedAt?: string;
}

export interface LearnedFactWithId extends LearnedFact {
  _docId: string;
}

// ── Shared normalization (KTD16) ─────────────────────────────────────────────
// ONE function feeds the `_norm` dedupe index, the deterministic doc key, the
// tombstone fingerprint WRITES (staging/completion), and the extraction-side
// fingerprint CHECKS. Tombstones and checks structurally cannot drift.

export function normalizeFactForFingerprint(fact: string): string {
  return (fact ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Internal alias — historical name used throughout this module.
const normalizeFact = normalizeFactForFingerprint;

/** HMAC tombstone fingerprint of a fact's plaintext (normalizes internally). */
export function computeFactFingerprint(
  fact: string,
  material: { key: string; version: number },
): { fingerprint: string; keyVersion: number } {
  return {
    fingerprint: hmacFingerprint(normalizeFactForFingerprint(fact), material),
    keyVersion: material.version,
  };
}

// KTD7: deterministic normalized-fact doc key. Two concurrent extractions of
// the same fact target the SAME document ref inside a transaction, so the
// query-then-add() race that produced duplicate facts is structurally gone.
// Legacy auto-ID facts remain addressable via the _norm index (see below).
export function deterministicFactDocId(fact: string): string {
  return `nf_${createHash("sha256").update(normalizeFact(fact)).digest("hex").slice(0, 24)}`;
}

function factsCollection(userId: string) {
  return db.collection("learned_facts").doc(userId).collection("facts");
}

function factDocPath(userId: string, docId: string): string {
  return `learned_facts/${userId}/facts/${docId}`;
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

// ── Active-fact predicate (R13/R14 immediate suppression) ────────────────────
// Shared by EVERY fact reader in this module: superseded facts, facts staged
// for correction/forget (pending markers), and tombstoned/stripped facts are
// ineligible for retrieval the moment staging commits.

export function isActiveLearnedFact(data: Record<string, unknown> | undefined | null): boolean {
  if (!data) return false;
  if (data.supersededAt) return false;
  if (data.pendingCorrectionOperationId || data.pendingForgetOperationId) return false;
  if (data.forgottenAt || data.forgottenFingerprint) return false;
  if (!data.fact) return false; // stripped tombstone shell
  return true;
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

// Shared extraction model call — used by extractAndStoreFacts and by the live
// turn's tombstone-restatement check so both see the same candidate facts.
async function runFactExtractionModel(
  text: string,
): Promise<Array<{ fact: string; category: FactCategory }>> {
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
  if (!cleaned) return [];
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? parsed : [];
}

// ── Tombstone / staging guard for writes (R23/KTD16) ─────────────────────────

export type FactWriteBlockReason = "tombstoned" | "superseded" | "pending_change";

interface BlockingFactDoc {
  docId: string;
  reason: FactWriteBlockReason;
}

/**
 * Finds a doc that forbids passively (re)storing `factText`:
 *  • exact deterministic-key / legacy `_norm` match that is superseded, staged
 *    pending correction/forget, or tombstoned;
 *  • a stripped tombstone matched by HMAC fingerprint (post-completion docs
 *    whose plaintext/_norm are gone — the fingerprint is the ONLY link).
 * Uses the SAME normalizeFactForFingerprint as tombstone writes (KTD16).
 * Fail-open on query errors, like every other reader in this module.
 */
async function findBlockingFactDoc(
  userId: string,
  factText: string,
): Promise<BlockingFactDoc | null> {
  const factsCol = factsCollection(userId);
  const norm = normalizeFact(factText);
  const candidates: Array<{ id: string; data: Record<string, unknown> }> = [];

  const detId = deterministicFactDocId(factText);
  const detSnap = await factsCol.doc(detId).get().catch(() => null);
  if (detSnap?.exists) candidates.push({ id: detId, data: (detSnap.data() ?? {}) as Record<string, unknown> });

  const legacySnap = await factsCol
    .where("_norm", "==", norm)
    .limit(5)
    .get()
    .catch(() => ({ docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] }));
  for (const d of legacySnap.docs) {
    if (!candidates.some((c) => c.id === d.id)) {
      candidates.push({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> });
    }
  }

  const material = tryGetFingerprintKey();
  if (material) {
    const fp = hmacFingerprint(norm, material);
    const fpSnap = await factsCol
      .where("forgottenFingerprint", "==", fp)
      .limit(3)
      .get()
      .catch(() => ({ docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] }));
    for (const d of fpSnap.docs) {
      if (!candidates.some((c) => c.id === d.id)) {
        candidates.push({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> });
      }
    }
  }

  for (const c of candidates) {
    if (c.data.pendingForgetOperationId || c.data.pendingCorrectionOperationId) {
      return { docId: c.id, reason: "pending_change" };
    }
    if (c.data.forgottenAt || c.data.forgottenFingerprint) {
      return { docId: c.id, reason: "tombstoned" };
    }
    if (c.data.supersededAt) {
      return { docId: c.id, reason: "superseded" };
    }
  }
  return null;
}

// ── Passive extraction (KTD7 idempotency + R23 turn/tombstone guards) ────────

/** Turn kind the CALLER judged for this text (detection outcome). Correction/
 *  forget/ambiguous turns are never passively extracted (R23/KTD16). */
export type FactTurnKind = "normal" | "correction" | "forget" | "ambiguous";

export interface FactExtractionRefusal {
  /** In-memory only — callers may use it to ask the re-remember confirmation.
   *  NEVER logged or persisted (R21). */
  fact: string;
  category: FactCategory;
  reason: FactWriteBlockReason;
  blockedByDocId: string;
}

export interface FactExtractionResult {
  skipped?: "turn_kind" | "too_short" | "extraction_failed" | "nothing_extracted";
  stored: number;
  refusals: FactExtractionRefusal[];
}

export interface FactExtractionOptions {
  turnKind?: FactTurnKind;
}

export async function extractAndStoreFacts(
  userId:     string,
  text:       string,
  zepUserId?:  string,
  provenance?: FactWriteProvenance,
  options?:    FactExtractionOptions,
): Promise<FactExtractionResult> {
  // R23/KTD16: a correction, forget, or ambiguous-change turn is never a source
  // of new passive facts — the staged operation owns that turn's meaning.
  if (options?.turnKind && options.turnKind !== "normal") {
    return { skipped: "turn_kind", stored: 0, refusals: [] };
  }
  if (!text || text.length < 10) return { skipped: "too_short", stored: 0, refusals: [] };

  let extracted: Array<{ fact: string; category: FactCategory }> = [];
  try {
    extracted = await runFactExtractionModel(text);
  } catch (err) {
    console.warn("[learnedFacts] extractAndStoreFacts failed:", err instanceof Error ? err.message : err, { userId });
    return { skipped: "extraction_failed", stored: 0, refusals: [] };
  }

  if (!Array.isArray(extracted) || extracted.length === 0) {
    return { skipped: "nothing_extracted", stored: 0, refusals: [] };
  }

  const factsCol  = factsCollection(userId);
  const nowIso    = new Date().toISOString();
  const newFacts: Array<{ fact: string; category: FactCategory }> = [];
  const refusals: FactExtractionRefusal[] = [];
  let stored = 0;

  for (const item of extracted) {
    if (!item.fact || !item.category) continue;

    // R23/KTD16 write guard: a fingerprint/staging hit on a fresh assertion is
    // a typed REFUSAL, never a silent store and never a silent drop — the
    // caller decides whether to ask the explicit re-remember confirmation.
    const blocking = await findBlockingFactDoc(userId, item.fact).catch(() => null);
    if (blocking) {
      refusals.push({
        fact: item.fact,
        category: item.category,
        reason: blocking.reason,
        blockedByDocId: blocking.docId,
      });
      continue;
    }

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
      (d) => d.id !== deterministicRef.id && isActiveLearnedFact(d.data()),
    );

    // Embed BEFORE the transaction (no network calls inside transactions);
    // only used on create. Fail-open: null embedding still stores the fact.
    const embedding = await embedText(item.fact);

    let createdNew = false;
    let wroteMention = false;
    // KTD7: the read-modify-write is transactional, so two concurrent
    // extractions serialize instead of both passing a stale dedupe check.
    await db.runTransaction(async (t) => {
      createdNew = false;
      wroteMention = false;
      const targetRef = legacyActive ? legacyActive.ref : deterministicRef;
      const snap = await t.get(targetRef);
      if (snap.exists) {
        const data = snap.data() ?? {};
        // In-transaction backstop for the pre-read guard above (R23): a doc
        // that became superseded/staged/tombstoned between the read and the
        // transaction is never passively resurrected.
        if (!isActiveLearnedFact(data)) return;
        const mentionKeys: string[] = Array.isArray(data.mentionTurnKeys) ? data.mentionTurnKeys : [];
        const turnKey = provenance?.sourceTurnKeyHash;
        // Retried extraction (worker retry, duplicate delivery) increments a
        // fact AT MOST ONCE per source-turn key.
        if (turnKey && mentionKeys.includes(turnKey)) return;
        const mergedRefs = mergeBoundedRefs(data.sourceMessageRefs, provenance?.sourceMessageRefs);
        wroteMention = true;
        t.update(targetRef, {
          weight:          Math.min(Number(data.weight ?? 1) + 1, 10),
          lastMentionedAt: nowIso,
          ...(turnKey ? { mentionTurnKeys: [...mentionKeys, turnKey].slice(-MENTION_TURN_KEYS_MAX) } : {}),
          ...(mergedRefs ? { sourceMessageRefs: mergedRefs } : {}),
        });
      } else {
        createdNew = true;
        wroteMention = true;
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
    if (wroteMention) stored++;
    if (createdNew) newFacts.push({ fact: item.fact, category: item.category });
  }

  // R21 refusal metric: counts + reason enums only. No fact text, ever.
  if (refusals.length > 0) {
    const byReason: Record<string, number> = {};
    for (const r of refusals) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    console.info(JSON.stringify({
      learned_fact_write_refused: true,
      tombstone_refusals: refusals.length,
      reasons: byReason,
      timestamp: nowIso,
    }));
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

  return { stored, refusals };
}

// ── Prompt retrieval ──────────────────────────────────────────────────────────

export async function getRelevantFacts(
  userId: string,
  topic?: string
): Promise<LearnedFactWithId[]> {
  // Fetch top-30 by stored weight (oversample) then re-rank by EFFECTIVE weight
  // = weight × half-life-decay(daysSinceLastMention). Oversampling lets a
  // recent-low-weight fact beat a stale-high-weight fact, which is the whole
  // point of decay. Filter superseded/pending/tombstoned client-side (avoids a
  // composite index) — R13/R14: a staged correction/forget is invisible HERE,
  // on BOTH the weight and topic paths, the moment staging commits.
  const snap = await db
    .collection("learned_facts")
    .doc(userId)
    .collection("facts")
    .orderBy("weight", "desc")
    .limit(30)
    .get();

  const active = snap.docs
    .filter((d) => isActiveLearnedFact(d.data()))
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
  // weight ordering. Both paths rank over the same pending-filtered `active` set.
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

// ── Bounded active-fact candidate reader (R11) ───────────────────────────────
// Correction/forget matching runs over ALL of a user's active facts (paginated,
// hard-capped) — never the ten-fact prompt reader, so a fact ranked below the
// prompt window can still be corrected (AE5). Candidate identity comes ONLY
// from the caller-supplied verified userId.

export const ACTIVE_FACT_CANDIDATE_CAP = 200;
export const ACTIVE_FACT_PAGE_SIZE = 100;

export async function getActiveFactCandidates(userId: string): Promise<LearnedFactWithId[]> {
  if (!userId) return [];
  const factsCol = factsCollection(userId);
  const out: LearnedFactWithId[] = [];
  let cursor: string | null = null;

  while (out.length < ACTIVE_FACT_CANDIDATE_CAP) {
    let q = factsCol
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(ACTIVE_FACT_PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      const data = d.data();
      if (!isActiveLearnedFact(data)) continue;
      out.push({
        userId:          data.userId,
        fact:            data.fact,
        weight:          data.weight,
        category:        data.category,
        createdAt:       data.createdAt,
        lastMentionedAt: data.lastMentionedAt,
        _docId:          d.id,
      } as LearnedFactWithId);
      if (out.length >= ACTIVE_FACT_CANDIDATE_CAP) break;
    }
    if (snap.docs.length < ACTIVE_FACT_PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
  return out;
}

// ── Typed correction/forget detection + transactional staging (R12, KTD9) ────

export type FactChangeOutcome =
  | { kind: "not_correction" }
  | { kind: "no_match" }
  | { kind: "ambiguous" }
  | { kind: "pending";   change: "correction" | "forget"; operationId: string }
  | { kind: "completed"; change: "correction" | "forget"; operationId: string }
  | { kind: "failed"; errorClass: string };

export interface DetectFactChangeParams {
  /** Verified/authenticated user identity — never model-supplied (R11). */
  userId: string;
  text:   string;
  /** Session phone for the operation's sessionRef (optional). */
  phone?: string;
  /**
   * true when an upstream intent classifier already judged this message a
   * correction/forget (routeIntent FACT_CORRECTION). With zero stored facts
   * that yields an honest no_match instead of not_correction (R15).
   */
  assumeChangeIntent?: boolean;
}

/**
 * Detects whether `text` corrects or retracts ONE stored fact and, if so,
 * transactionally stages the change (KTD9):
 *  • correction — creates the replacement fact, marks the old doc
 *    `pendingCorrectionOperationId` (+ supersededAt/By), stamps the retired
 *    plaintext's HMAC fingerprint, creates the deterministic correction
 *    operation, and flags the user's reconciliation doc — one transaction;
 *  • forget — marks `pendingForgetOperationId` + fingerprint, creates the
 *    forget operation, flags reconciliation — one transaction.
 * Ambiguity → the caller asks ONE clarifying question and NOTHING changes.
 * No match → the caller says it cannot identify that memory (R15).
 * The operation doc carries refs/statuses only — no fact text (R14/R21).
 */
export async function detectAndStageFactChange(
  params: DetectFactChangeParams,
): Promise<FactChangeOutcome> {
  const { userId, text } = params;
  if (!userId || !text?.trim()) return { kind: "not_correction" };

  let candidates: LearnedFactWithId[];
  try {
    candidates = await getActiveFactCandidates(userId);
  } catch (err) {
    return { kind: "failed", errorClass: err instanceof Error ? err.constructor.name : typeof err };
  }
  if (candidates.length === 0) {
    return params.assumeChangeIntent ? { kind: "no_match" } : { kind: "not_correction" };
  }

  // Per CLAUDE.md, intent (is this a correction/retraction?) is judged by an
  // LLM, never a regex — over the FULL bounded candidate set, not the ten
  // prompt facts (R11). Exactly one unambiguous target is required.
  const factsJson = candidates
    .map((f, i) => `${i}: "${f.fact}" [${f.category}]`)
    .join("\n");

  let raw: string;
  try {
    raw = await quickComplete(
      "The user may be correcting previously stated information about their care situation, or asking you to " +
        "forget/remove/stop remembering a stored fact. You are given a numbered list of every known fact and the " +
        "user's message. Reply with JSON ONLY (no markdown fences), exactly one of:\n" +
        '{"corrects": <index>, "newFact": "<corrected text>", "category": "medical|preference|routine|family"} — ' +
        "the message clearly corrects exactly ONE listed fact.\n" +
        '{"corrects": <index>, "newFact": null} — the message asks to forget, remove, delete from memory, or ' +
        "retract exactly ONE listed fact without replacement.\n" +
        '{"ambiguous": [<index>, <index>, ...]} — the message is clearly a correction or forget request but could ' +
        "refer to MORE THAN ONE listed fact and you cannot pick exactly one.\n" +
        '{"noMatch": true} — the message is clearly a correction or forget request but NONE of the listed facts is ' +
        "the one it refers to.\n" +
        "null — the message is NOT correcting or retracting stored information.\n" +
        "Only pick a fact the user clearly identifies; never guess.",
      `Known facts:\n${factsJson}\n\nUser message: "${text}"`,
      { maxTokens: 220 },
    );
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  } catch (err) {
    return { kind: "failed", errorClass: err instanceof Error ? err.constructor.name : typeof err };
  }

  if (raw === "null" || !raw.startsWith("{")) return { kind: "not_correction" };

  let parsed: { corrects?: number; newFact?: string | null; category?: FactCategory; ambiguous?: number[]; noMatch?: boolean };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "not_correction" };
  }

  if (parsed.noMatch) return { kind: "no_match" };
  if (Array.isArray(parsed.ambiguous) && parsed.ambiguous.length > 0) return { kind: "ambiguous" };
  if (typeof parsed.corrects !== "number") return { kind: "not_correction" };

  const target = candidates[parsed.corrects];
  if (!target) return { kind: "no_match" };

  try {
    return await stageFactChange({
      userId,
      phone: params.phone,
      target,
      newFact: parsed.newFact
        ? { fact: parsed.newFact, category: parsed.category ?? target.category }
        : undefined,
    });
  } catch (err) {
    return { kind: "failed", errorClass: err instanceof Error ? err.constructor.name : typeof err };
  }
}

async function stageFactChange(params: {
  userId: string;
  phone?: string;
  target: LearnedFactWithId;
  /** Present → correction; absent → forget. */
  newFact?: { fact: string; category: FactCategory };
}): Promise<FactChangeOutcome> {
  const { userId, target, newFact } = params;
  const change: "correction" | "forget" = newFact ? "correction" : "forget";
  const nowIso = new Date().toISOString();
  const factsCol = factsCollection(userId);

  // Embed the corrected fact BEFORE the transaction (no network calls inside
  // Firestore transactions). Best-effort.
  const newEmbedding = newFact ? await embedText(newFact.fact) : null;
  // Fingerprint key: fail-open at staging (the plaintext + pending marker still
  // protect the doc until U4b completion, which REQUIRES the key to finalize).
  const material = tryGetFingerprintKey();

  let outcome: FactChangeOutcome = { kind: "failed", errorClass: "transaction_incomplete" };

  await db.runTransaction(async (t) => {
    const oldRef = factsCol.doc(target._docId);
    const oldSnap = await t.get(oldRef);
    if (!oldSnap.exists) {
      outcome = { kind: "no_match" };
      return;
    }
    const old = (oldSnap.data() ?? {}) as Record<string, unknown>;
    const generation = Number(old.changeGeneration ?? 0);
    const operationId = factChangeOperationId(change, userId, target._docId, generation);

    // Idempotency: the same request while a change is already staged returns
    // the EXISTING operation — nothing is re-staged, nothing duplicates.
    if (old.pendingForgetOperationId || old.pendingCorrectionOperationId) {
      outcome = {
        kind: "pending",
        change: old.pendingForgetOperationId ? "forget" : "correction",
        operationId: String(old.pendingForgetOperationId ?? old.pendingCorrectionOperationId),
      };
      return;
    }

    const opRef = db.collection(MEMORY_OPERATIONS_COLLECTION).doc(operationId);
    const opSnap = await t.get(opRef);
    if (opSnap.exists) {
      outcome = opSnap.data()?.status === "completed"
        ? { kind: "completed", change, operationId }
        : { kind: "pending", change, operationId };
      return;
    }

    // Fingerprint of the RETIRED plaintext (KTD16): stamped at staging for both
    // forget AND superseded corrections, so passive extraction of the old
    // normalized fact is refused even before the worker finalizes.
    const oldNorm = String(old._norm ?? normalizeFact(String(old.fact ?? "")));
    const fingerprintFields = material && oldNorm
      ? { forgottenFingerprint: hmacFingerprint(oldNorm, material), fingerprintKeyVersion: material.version }
      : {};

    let replacementPath: string | undefined;
    if (newFact) {
      const replacementDocId = deterministicFactDocId(newFact.fact);
      const newRef = factsCol.doc(replacementDocId);
      replacementPath = factDocPath(userId, replacementDocId);
      // Full overwrite by design: an explicit user correction is authoritative
      // — even over an old superseded/tombstoned doc at the same key (the
      // explicit statement IS the higher-authority signal, per the Memory
      // Authority Order).
      t.set(newRef, {
        userId,
        fact:            newFact.fact,
        _norm:           normalizeFact(newFact.fact),
        weight:          2,   // user explicitly stated — start higher than passive extraction
        category:        newFact.category,
        createdAt:       nowIso,
        lastMentionedAt: nowIso,
        correctionOf:    target._docId, // reference only — never old fact text
        ...(newEmbedding ? { embedding: newEmbedding, embeddingModel: EMBED_MODEL } : {}),
      });
      t.update(oldRef, {
        supersededAt: nowIso,
        supersededBy: replacementDocId,
        pendingCorrectionOperationId: operationId,
        ...fingerprintFields,
      });
    } else {
      t.update(oldRef, {
        pendingForgetOperationId: operationId,
        ...fingerprintFields,
      });
    }

    const { doc: opDoc } = buildFactChangeOperationDoc({
      kind: change,
      userId,
      phone: params.phone,
      targetFactDocId: target._docId,
      changeGeneration: generation,
      targetFactPath: factDocPath(userId, target._docId),
      replacementFactPath: replacementPath,
      sourceMessageRefs: Array.isArray(old.sourceMessageRefs)
        ? (old.sourceMessageRefs as string[]).slice(0, FACT_SOURCE_REFS_MAX)
        : [],
    });
    t.set(opRef, opDoc);

    // Reconciliation flag — SAME transaction as staging (KTD9), so the shared
    // readers' suppression check can never lag a staged change.
    t.set(
      db.collection(MEMORY_RECONCILIATION_COLLECTION).doc(userId),
      reconciliationFlagAdd(operationId, change),
      { merge: true },
    );

    outcome = { kind: "pending", change, operationId };
  });

  return outcome;
}

// ── Live-turn tombstone restatement + explicit re-remember (R23/KTD16) ───────

export interface TombstoneRestatement {
  factDocId: string;
  /** The user's freshly restated fact — user-facing use only, never logged. */
  fact: string;
  category: FactCategory;
}

/**
 * Checks whether the CURRENT verified user message re-states a forgotten or
 * superseded fact. Cheap gate first: users with no fingerprinted tombstones
 * (the overwhelming majority) pay one indexed limit-1 query and no model call.
 * A hit is the R23 entry point — the caller asks the explicit re-remember
 * confirmation question in that turn. Mid-flight (`pending_change`) docs are
 * NOT surfaced: their change is still reconciling.
 */
export async function findTombstonedRestatement(
  userId: string,
  text: string,
): Promise<TombstoneRestatement | null> {
  if (!userId || !text || text.length < 10) return null;

  const gate = await factsCollection(userId)
    .where("forgottenFingerprint", ">", "")
    .limit(1)
    .get()
    .catch(() => null);
  if (!gate || gate.docs.length === 0) return null;

  let extracted: Array<{ fact: string; category: FactCategory }>;
  try {
    extracted = await runFactExtractionModel(text);
  } catch {
    return null;
  }

  for (const item of extracted) {
    if (!item?.fact || !item.category) continue;
    const blocking = await findBlockingFactDoc(userId, item.fact).catch(() => null);
    if (blocking && (blocking.reason === "tombstoned" || blocking.reason === "superseded")) {
      return { factDocId: blocking.docId, fact: item.fact, category: item.category };
    }
  }
  return null;
}

export type ReRememberResult =
  | { ok: true; operationId: string }
  | { ok: false; reason: "not_found" | "reconciliation_pending" | "no_plaintext" | "failed" };

/**
 * Explicit CONFIRMED re-remember (R23): clears the tombstone/superseded state,
 * reactivates the fact (restoring plaintext from the user's restatement when
 * the doc was stripped), bumps changeGeneration, and records a small
 * deterministic already-completed memory_operations doc for audit-by-reference.
 * Refused while the fact still has an unresolved correction/forget operation.
 */
export async function confirmReRemember(params: {
  userId: string;
  factDocId: string;
  phone?: string;
  restatedFact?: { fact: string; category: FactCategory };
}): Promise<ReRememberResult> {
  const { userId, factDocId } = params;
  const factsCol = factsCollection(userId);
  const embedding = params.restatedFact ? await embedText(params.restatedFact.fact) : null;

  let result: ReRememberResult = { ok: false, reason: "failed" };
  try {
    await db.runTransaction(async (t) => {
      const ref = factsCol.doc(factDocId);
      const snap = await t.get(ref);
      if (!snap.exists) {
        result = { ok: false, reason: "not_found" };
        return;
      }
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      if (data.pendingForgetOperationId || data.pendingCorrectionOperationId) {
        result = { ok: false, reason: "reconciliation_pending" };
        return;
      }
      const factText = String(data.fact ?? "") || params.restatedFact?.fact || "";
      if (!factText) {
        // Stripped tombstone and no restatement — nothing to restore from.
        result = { ok: false, reason: "no_plaintext" };
        return;
      }
      const generation = Number(data.changeGeneration ?? 0);
      const nowIso = new Date().toISOString();
      const del = admin.firestore.FieldValue.delete();

      t.update(ref, {
        fact:            factText,
        _norm:           normalizeFact(factText),
        category:        (data.category as FactCategory | undefined) ?? params.restatedFact?.category ?? "preference",
        weight:          Math.max(1, Number(data.weight ?? 1)),
        lastMentionedAt: nowIso,
        reRememberedAt:  nowIso,
        changeGeneration: generation + 1,
        forgottenFingerprint:  del,
        fingerprintKeyVersion: del,
        forgottenAt:           del,
        supersededAt:          del,
        supersededBy:          del,
        ...(embedding ? { embedding, embeddingModel: EMBED_MODEL } : {}),
      });

      const { operationId, doc } = buildReRememberOperationDoc({
        userId,
        phone: params.phone,
        targetFactDocId: factDocId,
        targetFactPath: factDocPath(userId, factDocId),
        changeGeneration: generation,
      });
      t.set(db.collection(MEMORY_OPERATIONS_COLLECTION).doc(operationId), doc);
      result = { ok: true, operationId };
    });
  } catch {
    return { ok: false, reason: "failed" };
  }

  if (result.ok) {
    // R21: outcome only — no fact text, no doc IDs.
    console.info(JSON.stringify({
      re_remember_confirmed: true,
      timestamp: new Date().toISOString(),
    }));
  }
  return result;
}

/**
 * Classifies the user's reply to the one-shot re-remember question. LLM-judged
 * (never a regex, per CLAUDE.md); anything unclear is "other" → no change.
 */
export async function classifyReRememberReply(text: string): Promise<"confirm" | "decline" | "other"> {
  if (!text?.trim()) return "other";
  try {
    const raw = await quickComplete(
      "Evia just asked the user ONE yes/no question: whether Evia should start remembering a detail again that " +
        "the user previously asked it to forget. Classify the user's reply. Respond with exactly one word: " +
        "confirm (a clear yes), decline (a clear no), or other (new topic, unclear, or conditional).",
      text,
      { maxTokens: 5 },
    );
    const v = (raw ?? "").trim().toLowerCase();
    return v === "confirm" ? "confirm" : v === "decline" ? "decline" : "other";
  } catch {
    return "other";
  }
}

// ── Deterministic acknowledgement copy (KTD10) ───────────────────────────────
// These strings are the ONLY user-facing acknowledgements for staged fact
// changes — no generic model response may override them. A pending forget says
// Evia STOPPED USING the fact and is finishing deletion; it never claims
// deletion is complete. Completion copy discloses that original message
// history is retained under the platform's separate data-erasure policy.

export const CORRECTION_PENDING_ACK_COPY =
  "Got it — I've updated that. The corrected detail is what I'll go by from now on, and I'm cleaning up the old version in my long-term memory behind the scenes.";

export const FORGET_PENDING_ACK_COPY =
  "Done — I've stopped using that detail as of right now, and I'm finishing removing it from my long-term memory. Until every stored copy is cleared I won't treat the deletion as fully complete.";

export const FORGET_COMPLETED_COPY =
  "That detail is now fully removed from my long-term memory. One note: the original messages in our conversation history are retained under the platform's data-erasure policy — erasing those is handled as a separate data-erasure request.";

export const FACT_CHANGE_AMBIGUOUS_COPY =
  "I want to make sure I change the right thing — could you tell me a bit more about exactly which detail you'd like me to update or remove? I haven't changed anything yet.";

export const FACT_CHANGE_NO_MATCH_COPY =
  "I checked what I have remembered, and I can't identify that memory, so I haven't changed anything. Could you tell me what I said that needs fixing?";

export const RE_REMEMBER_QUESTION_COPY =
  "Quick check before I save that: you'd previously asked me to forget that detail, so I haven't stored it again. Would you like me to start remembering it going forward?";

export const RE_REMEMBER_CONFIRMED_COPY =
  "Okay — I'll remember that again going forward.";

export const RE_REMEMBER_BLOCKED_COPY =
  "I'm still finishing an earlier memory update for that detail, so I've left it out for now. Once that update completes you can ask me to remember it again.";

/** Deterministic reply for a detection outcome; null → continue the normal turn. */
export function factChangeAckCopy(outcome: FactChangeOutcome): string | null {
  switch (outcome.kind) {
    case "pending":
      return outcome.change === "forget" ? FORGET_PENDING_ACK_COPY : CORRECTION_PENDING_ACK_COPY;
    case "completed":
      return outcome.change === "forget" ? FORGET_COMPLETED_COPY : CORRECTION_PENDING_ACK_COPY;
    case "ambiguous":
      return FACT_CHANGE_AMBIGUOUS_COPY;
    case "no_match":
      return FACT_CHANGE_NO_MATCH_COPY;
    default:
      return null;
  }
}
