import { describe, expect, it, beforeEach, vi } from "vitest";

// U4a (memory-grounding hardening 2026-07-17-002, R11-R15/R23, KTD9/KTD16):
// bounded active-fact candidate reader, typed correction/forget detection with
// transactional staging, immediate retrieval suppression, HMAC tombstones with
// ONE shared normalization, the passive-extraction guard, and explicit
// confirmed re-remember. Plus the U3 KTD7 idempotent-extraction contract.
//
// Mock style mirrors the module convention: one in-memory Firestore built in
// vi.hoisted, state mutated in beforeEach — never a mock returned from it.

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const DELETE = { __fvDelete: true };
  let autoId = 0;
  return {
    docs,
    DELETE,
    quickComplete: vi.fn(),
    nextAutoId: () => `auto-${++autoId}`,
    resetAutoIds: () => { autoId = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v) && v !== h.DELETE;

  function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const out = { ...target };
    for (const [k, v] of Object.entries(patch)) {
      if (v === h.DELETE) { delete out[k]; continue; }
      if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
      else out[k] = v;
    }
    return out;
  }

  function applyUpdate(current: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...current };
    for (const [k, v] of Object.entries(data)) {
      if (v === h.DELETE) delete out[k];
      else out[k] = v;
    }
    return out;
  }

  function snapshotOf(path: string) {
    const data = h.docs.get(path);
    return {
      exists: data !== undefined,
      id: path.split("/").pop()!,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  function makeDocRef(path: string): any {
    return {
      path,
      id: path.split("/").pop()!,
      get: async () => snapshotOf(path),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        h.docs.set(path, opts?.merge ? deepMerge(h.docs.get(path) ?? {}, data) : applyUpdate({}, data));
      },
      update: async (data: Record<string, unknown>) => {
        if (!h.docs.has(path)) throw new Error("NOT_FOUND: no document to update");
        h.docs.set(path, applyUpdate(h.docs.get(path)!, data));
      },
      collection: (sub: string) => makeCollection(`${path}/${sub}`),
    };
  }

  interface Filter { f: string; op: string; v: unknown }

  function makeQuery(
    prefix: string,
    filters: Filter[] = [],
    order: { f: string; dir: "asc" | "desc" } | null = null,
    lim = Number.POSITIVE_INFINITY,
    after: string | null = null,
  ): any {
    return {
      where: (f: string, op: string, v: unknown) => makeQuery(prefix, [...filters, { f, op, v }], order, lim, after),
      orderBy: (f: unknown, dir: "asc" | "desc" = "asc") => makeQuery(prefix, filters, { f: String(f), dir }, lim, after),
      limit: (n: number) => makeQuery(prefix, filters, order, n, after),
      startAfter: (cursor: string) => makeQuery(prefix, filters, order, lim, cursor),
      get: async () => {
        let rows = [...h.docs.entries()]
          .filter(([p]) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes("/"))
          .map(([p, data]) => ({ id: p.slice(prefix.length + 1), data: data as Record<string, unknown> }));
        for (const { f, op, v } of filters) {
          rows = rows.filter((r) => {
            const val = r.data[f];
            if (op === "==") return val === v;
            if (op === ">")  return val !== undefined && (val as any) > (v as any);
            if (op === ">=") return val !== undefined && (val as any) >= (v as any);
            return true;
          });
        }
        const keyOf = order
          ? (order.f === "__name__" ? (r: any) => r.id : (r: any) => r.data[order.f])
          : (r: any) => r.id;
        rows.sort((a, b) => {
          const x = keyOf(a); const y = keyOf(b);
          const cmp = x < y ? -1 : x > y ? 1 : 0;
          return order?.dir === "desc" ? -cmp : cmp;
        });
        if (after !== null) {
          const idx = rows.findIndex((r) => r.id === after);
          rows = idx >= 0 ? rows.slice(idx + 1) : rows.filter((r) => r.id > after);
        }
        rows = rows.slice(0, lim === Number.POSITIVE_INFINITY ? rows.length : lim);
        return {
          docs: rows.map((r) => ({
            id: r.id,
            data: () => ({ ...r.data }),
            ref: makeDocRef(`${prefix}/${r.id}`),
          })),
        };
      },
    };
  }

  function makeCollection(prefix: string): any {
    return {
      ...makeQuery(prefix),
      doc: (id?: string) => makeDocRef(`${prefix}/${id ?? h.nextAutoId()}`),
    };
  }

  const dbObj = {
    collection: (name: string) => makeCollection(name),
    doc: (path: string) => makeDocRef(path),
    runTransaction: async (fn: (t: any) => Promise<void>) => {
      const t = {
        get: async (ref: any) => snapshotOf(ref.path),
        set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          h.docs.set(ref.path, opts?.merge ? deepMerge(h.docs.get(ref.path) ?? {}, data) : applyUpdate({}, data));
        },
        update: (ref: any, data: Record<string, unknown>) => {
          h.docs.set(ref.path, applyUpdate(h.docs.get(ref.path) ?? {}, data));
        },
      };
      await fn(t);
    },
  };

  const firestore = Object.assign(() => dbObj, {
    FieldValue: {
      delete: () => h.DELETE,
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
    FieldPath: {
      documentId: () => "__name__",
    },
    // U6: buildReRememberOperationDoc stamps expiresAt as a Firestore Timestamp.
    Timestamp: {
      fromMillis: (ms: number) => ({ __timestamp: true, toMillis: () => ms, toDate: () => new Date(ms) }),
    },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("../utils/openaiClient", () => ({
  quickComplete: h.quickComplete,
}));

vi.mock("./embeddings", () => ({
  embedText: vi.fn(async () => null),
  rankBySimilarity: vi.fn((cands: any[], _q: unknown, k: number) => cands.slice(0, k)),
  EMBED_MODEL: "test-embedding",
}));

import {
  detectAndStageFactChange,
  extractAndStoreFacts,
  getRelevantFacts,
  getActiveFactCandidates,
  findTombstonedRestatement,
  confirmReRemember,
  stageMcpMemoryFileChange,
  computeFactFingerprint,
  normalizeFactForFingerprint,
  deterministicFactDocId,
  factChangeAckCopy,
  isActiveLearnedFact,
  ACTIVE_FACT_CANDIDATE_CAP,
  MENTION_TURN_KEYS_MAX,
  FACT_SOURCE_REFS_MAX,
  CORRECTION_PENDING_ACK_COPY,
  FORGET_PENDING_ACK_COPY,
  FORGET_COMPLETED_COPY,
  FACT_CHANGE_AMBIGUOUS_COPY,
  FACT_CHANGE_NO_MATCH_COPY,
} from "./learnedFacts";
import { hmacFingerprint, __setFingerprintKeyForTests } from "./fingerprintKey";
import { MEMORY_RECONCILIATION_COLLECTION } from "./memoryOperations";
import * as embeddingsMod from "./embeddings";

const USER = "u1";
const KEY = { key: "test-fingerprint-key", version: 1 };

function factPath(docId: string): string {
  return `learned_facts/${USER}/facts/${docId}`;
}
function setFact(docId: string, data: Record<string, unknown>): void {
  h.docs.set(factPath(docId), { userId: USER, ...data });
}
function getFact(docId: string): Record<string, unknown> | undefined {
  return h.docs.get(factPath(docId));
}
function operationDocs(): Array<[string, Record<string, unknown>]> {
  return [...h.docs.entries()].filter(([p]) => p.startsWith("memory_operations/"));
}
function flagDoc(): Record<string, unknown> | undefined {
  return h.docs.get(`${MEMORY_RECONCILIATION_COLLECTION}/${USER}`);
}

const SHELLFISH = "Mom is allergic to shellfish";

function seedActiveFact(docId: string, fact: string, weight = 4, extra: Record<string, unknown> = {}): void {
  setFact(docId, {
    fact,
    _norm: normalizeFactForFingerprint(fact),
    weight,
    category: "medical",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastMentionedAt: "2026-07-15T00:00:00.000Z",
    sourceMessageRefs: [`agent_conversations/+1/messages/turn_seed_${docId}_user`],
    ...extra,
  });
}

// Detection mock: picks the numbered line containing `needle` from the prompt
// payload — index-robust regardless of candidate ordering.
function mockDetection(needle: string, reply: (index: number) => string): void {
  h.quickComplete.mockImplementationOnce(async (_sys: string, payload: string) => {
    const line = payload.split("\n").find((l) => l.includes(needle) && /^\d+: /.test(l));
    if (!line) throw new Error(`test fixture: candidate '${needle}' not in prompt`);
    return reply(Number(line.split(":")[0]));
  });
}

beforeEach(() => {
  h.docs.clear();
  h.resetAutoIds();
  h.quickComplete.mockReset();
  __setFingerprintKeyForTests(KEY.key);
  vi.mocked(embeddingsMod.embedText).mockReset().mockResolvedValue(null);
  vi.mocked(embeddingsMod.rankBySimilarity).mockClear();
});

// ── Shared normalization + fingerprints (KTD16) ──────────────────────────────

describe("shared fingerprint normalization (KTD16)", () => {
  it("tombstone writes and extraction checks share ONE normalization — variants collapse to one fingerprint", () => {
    const a = computeFactFingerprint("  MOM is   allergic to Shellfish ", KEY);
    const b = computeFactFingerprint("mom is allergic to shellfish", KEY);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.keyVersion).toBe(1);
    // And it is exactly HMAC(normalize(fact)) — the same primitive staging writes.
    expect(a.fingerprint).toBe(hmacFingerprint(normalizeFactForFingerprint("  MOM is   allergic to Shellfish "), KEY));
    // The deterministic doc key derives from the same normalization.
    expect(deterministicFactDocId("  MOM is   allergic to Shellfish ")).toBe(deterministicFactDocId(SHELLFISH));
  });

  it("staging writes the SAME fingerprint the extraction check computes", async () => {
    seedActiveFact("fact-1", SHELLFISH);
    mockDetection(SHELLFISH, (i) => JSON.stringify({ corrects: i, newFact: null }));
    await detectAndStageFactChange({ userId: USER, text: "please forget mom's shellfish allergy" });
    expect(getFact("fact-1")!.forgottenFingerprint).toBe(computeFactFingerprint(SHELLFISH, KEY).fingerprint);
    expect(getFact("fact-1")!.fingerprintKeyVersion).toBe(1);
  });
});

// ── Bounded candidate reader (R11) ───────────────────────────────────────────

describe("getActiveFactCandidates (R11)", () => {
  it("pages past the ten-fact prompt window and hard-caps at 200", async () => {
    for (let i = 0; i < ACTIVE_FACT_CANDIDATE_CAP + 50; i++) {
      seedActiveFact(`fact-${String(i).padStart(3, "0")}`, `Fact number ${i}`, 5);
    }
    const candidates = await getActiveFactCandidates(USER);
    expect(candidates).toHaveLength(ACTIVE_FACT_CANDIDATE_CAP);
  });

  it("excludes superseded, pending-change, and tombstoned facts", async () => {
    seedActiveFact("fact-a", "Mom walks daily");
    seedActiveFact("fact-b", "Old fact", 5, { supersededAt: "2026-07-01T00:00:00.000Z" });
    seedActiveFact("fact-c", "Mid-forget fact", 5, { pendingForgetOperationId: "forget_x" });
    seedActiveFact("fact-d", "Mid-correction fact", 5, { pendingCorrectionOperationId: "correction_x" });
    setFact("fact-e", { forgottenFingerprint: "abc", fingerprintKeyVersion: 1, forgottenAt: "2026-07-01T00:00:00.000Z", category: "medical" });
    const candidates = await getActiveFactCandidates(USER);
    expect(candidates.map((c) => c._docId)).toEqual(["fact-a"]);
  });
});

// ── Typed detection + transactional staging (R12/R15, KTD9) ─────────────────

describe("detectAndStageFactChange", () => {
  it("AE5: a fact ranked below the ten prompt facts is still found and corrected", async () => {
    // 12 heavier facts crowd the prompt window; the target has the lowest weight.
    for (let i = 0; i < 12; i++) seedActiveFact(`heavy-${i}`, `Heavy fact ${i}`, 9);
    seedActiveFact("zz-target", SHELLFISH, 1);

    const prompt = await getRelevantFacts(USER);
    expect(prompt).toHaveLength(10);
    expect(prompt.some((f) => f.fact === SHELLFISH)).toBe(false); // below the window

    mockDetection(SHELLFISH, (i) =>
      JSON.stringify({ corrects: i, newFact: "Mom is allergic to penicillin", category: "medical" }));
    const outcome = await detectAndStageFactChange({ userId: USER, text: "actually it's penicillin, not shellfish", phone: "+14085550001" });

    expect(outcome.kind).toBe("pending");
    expect(getFact("zz-target")!.pendingCorrectionOperationId).toBeDefined();
  });

  it("correction stages replacement + pending marker + operation + reconciliation flag in ONE transaction", async () => {
    seedActiveFact("fact-1", SHELLFISH, 8);
    mockDetection(SHELLFISH, (i) =>
      JSON.stringify({ corrects: i, newFact: "Mom is allergic to penicillin", category: "medical" }));

    const outcome = await detectAndStageFactChange({ userId: USER, text: "correction: penicillin not shellfish", phone: "+14085550001" });
    expect(outcome).toMatchObject({ kind: "pending", change: "correction" });
    const operationId = (outcome as { operationId: string }).operationId;

    // Old doc: staged, superseded, fingerprinted.
    const old = getFact("fact-1")!;
    expect(old.pendingCorrectionOperationId).toBe(operationId);
    expect(old.supersededAt).toEqual(expect.any(String));
    expect(old.forgottenFingerprint).toBe(computeFactFingerprint(SHELLFISH, KEY).fingerprint);

    // Replacement: active at its deterministic key, weight 2, reference-only link.
    const replacementId = deterministicFactDocId("Mom is allergic to penicillin");
    const replacement = getFact(replacementId)!;
    expect(replacement).toMatchObject({ fact: "Mom is allergic to penicillin", weight: 2, category: "medical", correctionOf: "fact-1" });
    expect(old.supersededBy).toBe(replacementId);

    // Operation: correction kind, per-target pendings, refs only.
    const op = h.docs.get(`memory_operations/${operationId}`)!;
    expect(op.kind).toBe("correction");
    expect(op.status).toBe("pending");
    expect(op.learnedFactRefs).toEqual([factPath("fact-1"), factPath(replacementId)]);
    const targets = op.targets as Record<string, { status: string }>;
    expect(targets.learnedFacts.status).toBe("pending");
    expect(targets.storage.status).toBe("pending");
    expect(targets.embeddings.status).toBe("pending");
    expect(targets.zepEdges.status).toBe("pending");
    expect(targets.zepEpisodes.status).toBe("pending");
    expect(targets.firestore.status).toBe("skipped");
    expect(targets.zepTranscript.status).toBe("skipped");

    // Reconciliation flag: same transaction, operation IDs only.
    const flag = flagDoc()!;
    expect((flag.pendingOperations as Record<string, unknown>)[operationId]).toMatchObject({ kind: "correction" });

    // KTD10: correction ack may state the corrected value is active.
    expect(factChangeAckCopy(outcome)).toBe(CORRECTION_PENDING_ACK_COPY);
  });

  it("forget stages the pending marker + fingerprint + operation + flag — and the ack copy never claims completion", async () => {
    seedActiveFact("fact-1", SHELLFISH, 8);
    mockDetection(SHELLFISH, (i) => JSON.stringify({ corrects: i, newFact: null }));

    const outcome = await detectAndStageFactChange({ userId: USER, text: "forget what I said about the shellfish allergy", phone: "+14085550001" });
    expect(outcome).toMatchObject({ kind: "pending", change: "forget" });
    const operationId = (outcome as { operationId: string }).operationId;

    const old = getFact("fact-1")!;
    expect(old.pendingForgetOperationId).toBe(operationId);
    expect(old.supersededAt).toBeUndefined(); // forget ≠ correction
    expect(old.forgottenFingerprint).toBe(computeFactFingerprint(SHELLFISH, KEY).fingerprint);
    expect(h.docs.get(`memory_operations/${operationId}`)!.kind).toBe("forget");
    expect((flagDoc()!.pendingOperations as Record<string, unknown>)[operationId]).toBeDefined();

    // KTD10: pending copy = stopped using + finishing deletion, never "deleted".
    expect(factChangeAckCopy(outcome)).toBe(FORGET_PENDING_ACK_COPY);
    expect(FORGET_PENDING_ACK_COPY).toContain("stopped using");
    expect(FORGET_PENDING_ACK_COPY).not.toMatch(/fully removed|deletion is complete/i);
  });

  it("ambiguous → outcome ambiguous, ONE clarifying question, and NOTHING changes", async () => {
    seedActiveFact("fact-1", "Mom is allergic to shellfish", 8);
    seedActiveFact("fact-2", "Dad is allergic to shellfish", 8);
    h.quickComplete.mockResolvedValueOnce(JSON.stringify({ ambiguous: [0, 1] }));

    const before = new Map(h.docs);
    const outcome = await detectAndStageFactChange({ userId: USER, text: "forget the shellfish allergy" });

    expect(outcome).toEqual({ kind: "ambiguous" });
    expect(factChangeAckCopy(outcome)).toBe(FACT_CHANGE_AMBIGUOUS_COPY);
    expect(FACT_CHANGE_AMBIGUOUS_COPY).toMatch(/\?/); // it IS a question
    expect(h.docs).toEqual(before); // no staging, no ops, no flag
  });

  it("no_match → honest 'cannot identify that memory' (R15), nothing changed", async () => {
    seedActiveFact("fact-1", "Mom prefers morning visits", 4, { category: "preference" });
    h.quickComplete.mockResolvedValueOnce(JSON.stringify({ noMatch: true }));

    const outcome = await detectAndStageFactChange({ userId: USER, text: "forget my brother's address" });
    expect(outcome).toEqual({ kind: "no_match" });
    expect(factChangeAckCopy(outcome)).toBe(FACT_CHANGE_NO_MATCH_COPY);
    expect(FACT_CHANGE_NO_MATCH_COPY).toContain("can't identify that memory");
    expect(getFact("fact-1")!.pendingForgetOperationId).toBeUndefined();
    expect(operationDocs()).toHaveLength(0);
  });

  it("not a correction → not_correction, no model-visible change, no ack copy", async () => {
    seedActiveFact("fact-1", "Mom prefers morning visits", 4, { category: "preference" });
    h.quickComplete.mockResolvedValueOnce("null");
    const outcome = await detectAndStageFactChange({ userId: USER, text: "thanks that sounds good" });
    expect(outcome).toEqual({ kind: "not_correction" });
    expect(factChangeAckCopy(outcome)).toBeNull();
  });

  // Live-caught false positives (2026-09-09): the user was pointing at a
  // different topic already in the conversation, not correcting a stored
  // fact about the care recipient/caregiver/care situation. The classifier
  // prompt now explicitly contrasts this against a real correction.
  describe("clarifying what the user meant is NOT a fact correction (2026-09-09)", () => {
    it.each([
      "I meant interviews, not jobs",
      "It's not the visit, it's the interview",
    ])("%s → not_correction, nothing staged", async (text) => {
      seedActiveFact("fact-1", "Mom prefers morning visits", 4, { category: "preference" });
      const before = new Map(h.docs);
      h.quickComplete.mockResolvedValueOnce("null");

      const outcome = await detectAndStageFactChange({ userId: USER, text });

      expect(outcome).toEqual({ kind: "not_correction" });
      expect(factChangeAckCopy(outcome)).toBeNull();
      expect(h.docs).toEqual(before);
    });

    it("the classifier prompt itself contrasts self-clarification against a real fact correction", async () => {
      seedActiveFact("fact-1", "Mom prefers morning visits", 4, { category: "preference" });
      h.quickComplete.mockResolvedValueOnce("null");

      await detectAndStageFactChange({ userId: USER, text: "I meant interviews, not jobs" });

      const [systemPrompt] = h.quickComplete.mock.calls[0] as [string, string];
      expect(systemPrompt).toContain("clarifying what THEY THEMSELVES");
      expect(systemPrompt).toContain("I meant interviews, not jobs");
      expect(systemPrompt).toContain("It's not the visit, it's the interview");
      expect(systemPrompt).toContain("her doctor is Dr. Chen, not Dr. Lee");
    });

    it("a real correction phrased similarly still corrects (prompt doesn't over-broaden to null)", async () => {
      seedActiveFact("fact-1", "Mom's doctor is Dr. Lee", 8, { category: "medical" });
      mockDetection("Dr. Lee", (i) =>
        JSON.stringify({ corrects: i, newFact: "Mom's doctor is Dr. Chen", category: "medical" }));

      const outcome = await detectAndStageFactChange({ userId: USER, text: "her doctor is Dr. Chen, not Dr. Lee", phone: "+14085550001" });

      expect(outcome).toMatchObject({ kind: "pending", change: "correction" });
    });
  });

  // Live-caught (2026-09-09, exposed once the cancel-routing dead-end was
  // fixed): "cancel the interview" was matching the forget/remove language
  // in the classifier's own instructions and getting staged as a real
  // forget against an unrelated stored fact, hijacking the turn before
  // cancel_interview ever got a chance to run. The classifier prompt now
  // explicitly carves out cancel/decline/reschedule requests on a real
  // scheduled thing as an action for a dedicated tool, not a memory op.
  describe("canceling a real scheduled interview/visit is NOT a fact forget (2026-09-09)", () => {
    it.each([
      "Can you cancel this interview",
      "Can you cancel the interview",
      "Can you cancel the interview pending for caregiver to accept or decline",
      "Can you cancel my interview request for Saturday",
      // 2026-09-09 live incident: "without" read as forget-shaped ("without
      // the note" ~ "remove the note") even though this modifies a
      // reschedule action, names no stored fact, and got a no_match
      // "I checked what I have remembered, and I can't identify that memory".
      "Can you reschedule without the note",
    ])("%s → not_correction, nothing staged", async (text) => {
      seedActiveFact("fact-1", "Mom prefers morning visits", 4, { category: "preference" });
      const before = new Map(h.docs);
      h.quickComplete.mockResolvedValueOnce("null");

      const outcome = await detectAndStageFactChange({ userId: USER, text });

      expect(outcome).toEqual({ kind: "not_correction" });
      expect(factChangeAckCopy(outcome)).toBeNull();
      expect(h.docs).toEqual(before);
    });

    it("the classifier prompt itself contrasts a booking cancellation against a real forget request", async () => {
      seedActiveFact("fact-1", "Mom prefers morning visits", 4, { category: "preference" });
      h.quickComplete.mockResolvedValueOnce("null");

      await detectAndStageFactChange({ userId: USER, text: "Can you cancel this interview" });

      const [systemPrompt] = h.quickComplete.mock.calls[0] as [string, string];
      expect(systemPrompt).toContain("cancel, decline, reschedule, or call off a real scheduled");
      expect(systemPrompt).toContain("Can you cancel the interview pending for caregiver to accept or decline");
      expect(systemPrompt).toContain("Can you reschedule without the note");
      expect(systemPrompt).toContain("forget what I said about the shellfish allergy");
    });

    it("a real forget request phrased with 'cancel'-adjacent wording still forgets (prompt doesn't over-broaden to null)", async () => {
      seedActiveFact("fact-1", SHELLFISH, 8);
      mockDetection(SHELLFISH, (i) => JSON.stringify({ corrects: i, newFact: null }));

      const outcome = await detectAndStageFactChange({ userId: USER, text: "please stop remembering the shellfish allergy" });

      expect(outcome).toMatchObject({ kind: "pending", change: "forget" });
    });
  });

  it("empty fact store: not_correction normally, honest no_match when the intent classifier already said correction", async () => {
    expect(await detectAndStageFactChange({ userId: USER, text: "forget the allergy" }))
      .toEqual({ kind: "not_correction" });
    expect(await detectAndStageFactChange({ userId: USER, text: "forget the allergy", assumeChangeIntent: true }))
      .toEqual({ kind: "no_match" });
    expect(h.quickComplete).not.toHaveBeenCalled(); // no candidates → no model call
  });

  it("the same forget request repeated while pending never duplicates the operation", async () => {
    seedActiveFact("fact-1", SHELLFISH, 8);
    mockDetection(SHELLFISH, (i) => JSON.stringify({ corrects: i, newFact: null }));
    const first = await detectAndStageFactChange({ userId: USER, text: "forget the shellfish allergy" });
    expect(first.kind).toBe("pending");

    // The pending fact is excluded from candidates on the retry, so the second
    // request cannot re-stage it — and only ONE operation doc ever exists.
    mockDetection("Mom walks daily", () => JSON.stringify({ noMatch: true }));
    seedActiveFact("other", "Mom walks daily", 2);
    const second = await detectAndStageFactChange({ userId: USER, text: "forget the shellfish allergy" });
    expect(["no_match", "not_correction"]).toContain(second.kind);
    expect(operationDocs()).toHaveLength(1);
  });

  it("detection model failure → typed failed outcome, nothing changed", async () => {
    seedActiveFact("fact-1", SHELLFISH, 8);
    h.quickComplete.mockRejectedValueOnce(new Error("model down"));
    const outcome = await detectAndStageFactChange({ userId: USER, text: "forget it" });
    expect(outcome.kind).toBe("failed");
    expect(getFact("fact-1")!.pendingForgetOperationId).toBeUndefined();
  });

  it("operation and flag docs contain refs/statuses only — never the fact text (serialized-doc assertion)", async () => {
    seedActiveFact("fact-1", SHELLFISH, 8);
    mockDetection(SHELLFISH, (i) => JSON.stringify({ corrects: i, newFact: null }));
    await detectAndStageFactChange({ userId: USER, text: "forget the shellfish allergy", phone: "+14085550001" });

    for (const [, op] of operationDocs()) {
      const serialized = JSON.stringify(op);
      expect(serialized).not.toContain("shellfish");
      expect(serialized).not.toContain("allergic");
    }
    const flagSerialized = JSON.stringify(flagDoc());
    expect(flagSerialized).not.toContain("shellfish");
    expect(flagSerialized).not.toContain("allergic");
  });
});

// ── Immediate retrieval suppression (R13/R14) ────────────────────────────────

describe("getRelevantFacts — pending facts invisible on BOTH ranking paths", () => {
  it("weight path: a staged forget is excluded immediately", async () => {
    seedActiveFact("fact-1", SHELLFISH, 9, { pendingForgetOperationId: "forget_x" });
    seedActiveFact("fact-2", "Mom prefers morning visits", 3, { category: "preference" });
    const facts = await getRelevantFacts(USER);
    expect(facts.map((f) => f.fact)).toEqual(["Mom prefers morning visits"]);
  });

  it("topic path: pending facts never even reach the semantic reranker", async () => {
    const vec = [1, 0, 0];
    seedActiveFact("fact-1", SHELLFISH, 9, { pendingCorrectionOperationId: "correction_x", embedding: vec });
    seedActiveFact("fact-2", "Mom takes metformin", 3, { embedding: vec });
    vi.mocked(embeddingsMod.embedText).mockResolvedValueOnce(vec);

    const facts = await getRelevantFacts(USER, "what medication does mom take");
    expect(facts.map((f) => f.fact)).toEqual(["Mom takes metformin"]);
    const rerankerInput = vi.mocked(embeddingsMod.rankBySimilarity).mock.calls[0][0] as unknown as Array<{ fact: string }>;
    expect(rerankerInput.some((c) => c.fact === SHELLFISH)).toBe(false);
  });

  it("stripped tombstone shells are never retrievable", async () => {
    setFact("fact-1", { forgottenFingerprint: "abc", fingerprintKeyVersion: 1, forgottenAt: "2026-07-01T00:00:00.000Z", weight: 9, category: "medical" });
    expect(await getRelevantFacts(USER)).toEqual([]);
    expect(isActiveLearnedFact(getFact("fact-1"))).toBe(false);
  });
});

// ── U5 (R16/KTD11): topic-aware reranking + weight fallback ──────────────────
// The reranker already existed; U5 only wires the current message into it.
// These tests pin the contract qaAgent now depends on: relevance beats raw
// weight when embeddings are available, and EVERY embedding-unavailable shape
// falls back to weight ordering (fail-open, no new algorithm).

describe("getRelevantFacts — topic reranking and weight fallback (U5)", () => {
  const MED_FACT = "Mom takes metformin twice daily";
  const FAMILY_FACT = "Daughter visits every Sunday afternoon";
  const MED_VEC = [1, 0, 0];
  const FAMILY_VEC = [0, 1, 0];
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

  function seedBoth(withEmbeddings = true): void {
    seedActiveFact("fam", FAMILY_FACT, 9, {
      category: "family",
      ...(withEmbeddings ? { embedding: FAMILY_VEC } : {}),
    });
    seedActiveFact("med", MED_FACT, 2, withEmbeddings ? { embedding: MED_VEC } : {});
  }

  it("a medication query outranks an unrelated high-weight family fact on the semantic path", async () => {
    seedBoth();
    vi.mocked(embeddingsMod.embedText).mockResolvedValueOnce(MED_VEC);
    // Similarity-honest reranker (the module mock's default just slices).
    vi.mocked(embeddingsMod.rankBySimilarity).mockImplementationOnce(
      ((cands: Array<{ embedding: number[] }>, q: number[], k: number) =>
        [...cands].sort((a, b) => dot(b.embedding, q) - dot(a.embedding, q)).slice(0, k)) as never,
    );

    const facts = await getRelevantFacts(USER, "what medication does mom take");
    // Weight ordering alone would have put the family fact first (9 vs 2).
    expect(facts.map((f) => f.fact)).toEqual([MED_FACT, FAMILY_FACT]);
    expect(vi.mocked(embeddingsMod.embedText)).toHaveBeenCalledWith("what medication does mom take");
  });

  it("topic-embedding failure falls back to weight ordering without touching the reranker", async () => {
    seedBoth();
    vi.mocked(embeddingsMod.embedText).mockResolvedValueOnce(null); // provider down / no key
    const facts = await getRelevantFacts(USER, "what medication does mom take");
    expect(facts.map((f) => f.fact)).toEqual([FAMILY_FACT, MED_FACT]);
    expect(vi.mocked(embeddingsMod.rankBySimilarity)).not.toHaveBeenCalled();
  });

  it("falls back to weight ordering when no stored fact carries an embedding", async () => {
    seedBoth(false);
    vi.mocked(embeddingsMod.embedText).mockResolvedValueOnce(MED_VEC);
    const facts = await getRelevantFacts(USER, "what medication does mom take");
    expect(facts.map((f) => f.fact)).toEqual([FAMILY_FACT, MED_FACT]);
    expect(vi.mocked(embeddingsMod.rankBySimilarity)).not.toHaveBeenCalled();
  });

  it("a blank topic takes the weight path (qaAgent passes raw text, which may be empty)", async () => {
    seedBoth();
    const facts = await getRelevantFacts(USER, "   ");
    expect(facts.map((f) => f.fact)).toEqual([FAMILY_FACT, MED_FACT]);
    expect(vi.mocked(embeddingsMod.embedText)).not.toHaveBeenCalled();
  });
});

// ── Passive-extraction guard (R23/KTD16) ─────────────────────────────────────

const FACT = SHELLFISH;
const EXTRACTION = JSON.stringify([{ fact: FACT, category: "medical" }]);
const TURN_TEXT = "just so you know, mom is allergic to shellfish";
const PROVENANCE = {
  sourceTurnKeyHash: "hash-turn-1",
  sourceMessageRefs: ["agent_conversations/+1/messages/turn_a_user", "agent_conversations/+1/messages/turn_a_assistant"],
};

describe("extractAndStoreFacts — turn-kind + tombstone guards (U4a)", () => {
  it("a correction/forget/ambiguous turn is never passively extracted — no model call, no writes", async () => {
    for (const turnKind of ["correction", "forget", "ambiguous"] as const) {
      const result = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE, { turnKind });
      expect(result).toEqual({ skipped: "turn_kind", stored: 0, refusals: [] });
    }
    expect(h.quickComplete).not.toHaveBeenCalled();
    expect(h.docs.size).toBe(0);
  });

  it("turnKind 'normal' extracts as usual", async () => {
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);
    const result = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE, { turnKind: "normal" });
    expect(result.stored).toBe(1);
    expect(getFact(deterministicFactDocId(FACT))).toBeDefined();
  });

  it("a STRIPPED tombstone blocks passive exact re-extraction via the HMAC fingerprint (case/whitespace variant)", async () => {
    // Post-U4b shape: plaintext and _norm gone; only the fingerprint remains.
    setFact("tomb-1", {
      forgottenFingerprint: computeFactFingerprint(FACT, KEY).fingerprint,
      fingerprintKeyVersion: 1,
      forgottenAt: "2026-07-10T00:00:00.000Z",
      category: "medical",
    });
    h.quickComplete.mockResolvedValueOnce(JSON.stringify([{ fact: "  MOM is   allergic to Shellfish ", category: "medical" }]));

    const result = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);

    expect(result.stored).toBe(0);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ reason: "tombstoned", blockedByDocId: "tomb-1" });
    // No new doc minted anywhere.
    expect([...h.docs.keys()]).toEqual([factPath("tomb-1")]);
  });

  it("a staged pending-forget fact refuses re-extraction (reason pending_change)", async () => {
    seedActiveFact("fact-1", FACT, 6, { pendingForgetOperationId: "forget_x" });
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);
    const result = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);
    expect(result.refusals[0]).toMatchObject({ reason: "pending_change", blockedByDocId: "fact-1" });
    expect(getFact("fact-1")!.weight).toBe(6); // untouched
  });

  it("refusals are COUNTED (metric) without leaking fact text into the log", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      setFact("tomb-1", {
        forgottenFingerprint: computeFactFingerprint(FACT, KEY).fingerprint,
        fingerprintKeyVersion: 1,
        forgottenAt: "2026-07-10T00:00:00.000Z",
        category: "medical",
      });
      h.quickComplete.mockResolvedValueOnce(EXTRACTION);
      await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);

      const line = infoSpy.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("tombstone_refusals"));
      expect(line).toBeDefined();
      const entry = JSON.parse(line!) as Record<string, unknown>;
      expect(entry.tombstone_refusals).toBe(1);
      expect((entry.reasons as Record<string, number>).tombstoned).toBe(1);
      expect(line).not.toContain("shellfish");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("a superseded fact is refused with a typed reason (was: silent skip)", async () => {
    const docId = deterministicFactDocId(FACT);
    seedActiveFact(docId, FACT, 6, { supersededAt: "2026-07-01T00:00:00.000Z" });
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);

    const result = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);

    expect(result.refusals[0]).toMatchObject({ reason: "superseded", blockedByDocId: docId });
    const stored = getFact(docId)!;
    expect(stored.weight).toBe(6);               // untouched
    expect(stored.supersededAt).toBeDefined();   // still retracted
    expect([...h.docs.keys()]).toEqual([factPath(docId)]); // no replacement doc minted
  });
});

// ── KTD7: concurrency/retry-safe fact writes (unchanged contract from U3) ────

describe("extractAndStoreFacts — deterministic idempotent writes (KTD7)", () => {
  it("creates a new fact at the deterministic normalized-fact doc ID with mention + provenance ledgers", async () => {
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);

    await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);

    const docId = deterministicFactDocId(FACT);
    expect(docId).toMatch(/^nf_[0-9a-f]{24}$/);
    const stored = getFact(docId);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      userId: USER,
      fact: FACT,
      weight: 1,
      category: "medical",
      mentionTurnKeys: ["hash-turn-1"],
      sourceMessageRefs: PROVENANCE.sourceMessageRefs,
    });
  });

  it("a RETRIED extraction with the same source-turn key increments at most once (worker retry safety)", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);
    await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE); // retry, same turn key
    await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE); // retry again

    const stored = getFact(deterministicFactDocId(FACT))!;
    expect(stored.weight).toBe(1);
    expect(stored.mentionTurnKeys).toEqual(["hash-turn-1"]);
    // And no duplicate doc was minted anywhere.
    expect([...h.docs.keys()]).toEqual([factPath(deterministicFactDocId(FACT))]);
  });

  it("a genuinely NEW mention (different source-turn key) increments the weight and appends the key", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);
    await extractAndStoreFacts(USER, TURN_TEXT, undefined, { ...PROVENANCE, sourceTurnKeyHash: "hash-turn-2" });

    const stored = getFact(deterministicFactDocId(FACT))!;
    expect(stored.weight).toBe(2);
    expect(stored.mentionTurnKeys).toEqual(["hash-turn-1", "hash-turn-2"]);
  });

  it("a legacy auto-ID active fact with the same normalized text is updated in place — no deterministic duplicate", async () => {
    setFact("legacy-1", {
      fact: FACT, _norm: FACT.toLowerCase(), weight: 4, category: "medical",
      createdAt: "2026-06-01T00:00:00.000Z", lastMentionedAt: "2026-06-10T00:00:00.000Z",
    });
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);

    await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);

    expect(getFact("legacy-1")!.weight).toBe(5);
    expect(getFact("legacy-1")!.mentionTurnKeys).toEqual(["hash-turn-1"]);
    expect(getFact(deterministicFactDocId(FACT))).toBeUndefined();
  });

  it("the legacy 3-arg signature still works: facts store without provenance and re-mentions increment (back-compat)", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    await extractAndStoreFacts(USER, TURN_TEXT);
    await extractAndStoreFacts(USER, TURN_TEXT);

    const stored = getFact(deterministicFactDocId(FACT))!;
    expect(stored.fact).toBe(FACT);
    // No turn key → no idempotency claim; each call is a distinct mention
    // (pre-U3 behavior preserved for legacy callers).
    expect(stored.weight).toBe(2);
    expect(stored.mentionTurnKeys).toEqual([]);
  });

  it("mention and provenance ledgers stay bounded", async () => {
    h.quickComplete.mockResolvedValue(EXTRACTION);

    for (let i = 0; i < MENTION_TURN_KEYS_MAX + 5; i++) {
      await extractAndStoreFacts(USER, TURN_TEXT, undefined, {
        sourceTurnKeyHash: `turn-${i}`,
        sourceMessageRefs: [`agent_conversations/+1/messages/turn_${i}_user`],
      });
    }

    const stored = getFact(deterministicFactDocId(FACT))!;
    expect((stored.mentionTurnKeys as string[]).length).toBe(MENTION_TURN_KEYS_MAX);
    // Most-recent keys are the ones retained.
    expect((stored.mentionTurnKeys as string[]).at(-1)).toBe(`turn-${MENTION_TURN_KEYS_MAX + 4}`);
    expect((stored.sourceMessageRefs as string[]).length).toBeLessThanOrEqual(FACT_SOURCE_REFS_MAX);
    expect(stored.weight).toBe(10); // capped
  });
});

// ── Re-remember (R23/KTD16) ──────────────────────────────────────────────────

describe("tombstone restatement + confirmed re-remember", () => {
  const TOMB_FP = () => computeFactFingerprint(FACT, KEY).fingerprint;

  function seedStrippedTombstone(docId = "tomb-1"): void {
    setFact(docId, {
      forgottenFingerprint: TOMB_FP(),
      fingerprintKeyVersion: 1,
      forgottenAt: "2026-07-10T00:00:00.000Z",
      category: "medical",
      weight: 6,
      changeGeneration: 0,
    });
  }

  it("a re-stated forgotten fact is detected so the caller can ask THE confirmation question", async () => {
    seedStrippedTombstone();
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);
    const hit = await findTombstonedRestatement(USER, TURN_TEXT);
    expect(hit).toMatchObject({ factDocId: "tomb-1", fact: FACT, category: "medical" });
  });

  it("users with no tombstones pay no model call (cheap gate)", async () => {
    seedActiveFact("fact-1", "Mom walks daily");
    const hit = await findTombstonedRestatement(USER, TURN_TEXT);
    expect(hit).toBeNull();
    expect(h.quickComplete).not.toHaveBeenCalled();
  });

  it("confirmed re-remember clears the tombstone, restores plaintext, bumps the generation, and records a completed audit operation", async () => {
    seedStrippedTombstone();
    const result = await confirmReRemember({
      userId: USER, factDocId: "tomb-1", phone: "+14085550001",
      restatedFact: { fact: FACT, category: "medical" },
    });
    expect(result.ok).toBe(true);

    const doc = getFact("tomb-1")!;
    expect(doc.forgottenFingerprint).toBeUndefined();
    expect(doc.fingerprintKeyVersion).toBeUndefined();
    expect(doc.forgottenAt).toBeUndefined();
    expect(doc.fact).toBe(FACT);
    expect(doc._norm).toBe(normalizeFactForFingerprint(FACT));
    expect(doc.changeGeneration).toBe(1);
    expect(doc.reRememberedAt).toEqual(expect.any(String));

    const opId = (result as { operationId: string }).operationId;
    const op = h.docs.get(`memory_operations/${opId}`)!;
    expect(op.kind).toBe("re_remember");
    expect(op.status).toBe("completed");
    expect(op.learnedFactRefs).toEqual([factPath("tomb-1")]);
    expect(JSON.stringify(op)).not.toContain("shellfish"); // no plaintext on the audit record

    // The fact is retrievable and extractable again.
    expect(isActiveLearnedFact(getFact("tomb-1"))).toBe(true);
    h.quickComplete.mockResolvedValueOnce(EXTRACTION);
    const extraction = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);
    expect(extraction.refusals).toHaveLength(0);
  });

  it("UNconfirmed: without confirmReRemember the tombstone keeps blocking", async () => {
    seedStrippedTombstone();
    h.quickComplete.mockResolvedValue(EXTRACTION);
    const first = await extractAndStoreFacts(USER, TURN_TEXT, undefined, PROVENANCE);
    const second = await extractAndStoreFacts(USER, TURN_TEXT, undefined, { ...PROVENANCE, sourceTurnKeyHash: "hash-turn-2" });
    expect(first.refusals).toHaveLength(1);
    expect(second.refusals).toHaveLength(1);
    expect(getFact("tomb-1")!.forgottenFingerprint).toBe(TOMB_FP());
  });

  it("re-remember is refused while the fact's forget is still reconciling", async () => {
    seedActiveFact("fact-1", FACT, 6, { pendingForgetOperationId: "forget_x" });
    const result = await confirmReRemember({ userId: USER, factDocId: "fact-1" });
    expect(result).toEqual({ ok: false, reason: "reconciliation_pending" });
    expect(getFact("fact-1")!.pendingForgetOperationId).toBe("forget_x");
  });

  it("does not reactivate a superseded fact while its replacement is still active", async () => {
    setFact("old-fact", {
      fact: FACT,
      _norm: normalizeFactForFingerprint(FACT),
      category: "medical",
      weight: 6,
      supersededAt: "2026-07-10T00:00:00.000Z",
      supersededBy: "replacement-fact",
    });
    setFact("replacement-fact", {
      fact: "Mom is allergic to amoxicillin",
      _norm: "mom is allergic to amoxicillin",
      category: "medical",
      weight: 6,
    });

    const result = await confirmReRemember({
      userId: USER,
      factDocId: "old-fact",
      restatedFact: { fact: FACT, category: "medical" },
    });

    expect(result).toEqual({ ok: false, reason: "replacement_active" });
    expect(isActiveLearnedFact(getFact("old-fact"))).toBe(false);
    expect(isActiveLearnedFact(getFact("replacement-fact"))).toBe(true);
  });
});

describe("MCP memory-file staging", () => {
  it("creates the tombstone shell, pending all-target operation, and reconciliation flag before Storage mutation", async () => {
    const retiredText = "Mom is allergic to penicillin";
    const result = await stageMcpMemoryFileChange({
      kind: "forget",
      userId: USER,
      phone: "+14085550001",
      fileSlug: "health",
      retiredText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fact = getFact(result.factDocId)!;
    expect(fact).toMatchObject({
      fact: retiredText,
      pendingForgetOperationId: result.operationId,
      retiredVia: "mcp_memory_tool",
    });
    const op = h.docs.get(`memory_operations/${result.operationId}`)!;
    expect(op).toMatchObject({ kind: "forget", status: "pending", fileSlug: "health" });
    for (const target of ["learnedFacts", "storage", "embeddings", "zepEdges", "zepEpisodes"]) {
      expect((op.targets as Record<string, { status: string }>)[target].status).toBe("pending");
    }
    expect(JSON.stringify(op)).not.toContain(retiredText);
    expect((flagDoc()!.pendingOperations as Record<string, unknown>)[result.operationId]).toMatchObject({ kind: "forget" });
  });
});

// ── KTD10 completion copy (defined here; U4b sends it) ──────────────────────

describe("KTD10 acknowledgement copy", () => {
  it("completion copy discloses that original message history is retained under the data-erasure policy", () => {
    expect(FORGET_COMPLETED_COPY).toContain("conversation history are retained");
    expect(FORGET_COMPLETED_COPY).toContain("data-erasure");
  });

  it("correction ack states the corrected value is active without claiming physical cleanup finished", () => {
    expect(CORRECTION_PENDING_ACK_COPY).toContain("I've updated that");
    expect(CORRECTION_PENDING_ACK_COPY).toContain("cleaning up the old version");
  });
});
