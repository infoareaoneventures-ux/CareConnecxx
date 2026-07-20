import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Cloud Storage stand-in: path -> contents.
const store = new Map<string, string>();

const hoisted = vi.hoisted(() => ({
  store: new Map<string, string>(),
  // U8: per-object Storage metadata — { timeCreated?, metadata? (custom map) }.
  fileMeta: new Map<
    string,
    { timeCreated?: string; metadata?: Record<string, string> }
  >(),
  // memory_embeddings subcollection mock: docId -> { file, block, embedding, ... }
  embeddings: new Map<string, any>(),
  nextEmbedId: 0,
  // U4a: controllable per-user reconciliation state (KTD9 reader suppression).
  reconciliation: {
    pending: false,
    storageMasked: false,
    zepMasked: false,
    pendingOperationIds: [] as string[],
  },
  sessions: new Map<string, string>(), // userId -> phone, for conversation-summary reconciliation
  // U4b: agent_conversations/{phone}/messages rows for the consolidation tests.
  convMessages: [] as Array<Record<string, unknown>>,
  claudeCreate: vi.fn(async () => ({
    content: [{ type: "text", text: "[]" }],
  })),
}));

// U4a: the shared readers import the suppression check from memoryOperations —
// mock it with a controllable state so suppression is tested at the READER.
vi.mock("./memoryOperations", () => ({
  getMemoryReconciliationState: vi.fn(async () => ({
    ...hoisted.reconciliation,
  })),
  hasUnresolvedReconciliation: vi.fn(
    async () => hoisted.reconciliation.pending,
  ),
}));

vi.mock("firebase-admin", () => {
  const makeFile = (name: string) => ({
    name,
    // Snapshot of the object's Storage metadata at listing time (real GCS
    // populates File.metadata on getFiles) — { timeCreated, metadata: {...} }.
    metadata: hoisted.fileMeta.get(name) ?? {},
    download: vi.fn(async () => {
      if (!hoisted.store.has(name)) throw new Error("404");
      return [Buffer.from(hoisted.store.get(name)!, "utf-8")];
    }),
    save: vi.fn(
      async (
        content: string,
        opts?: { metadata?: { metadata?: Record<string, string> } },
      ) => {
        hoisted.store.set(name, content);
        const existing = hoisted.fileMeta.get(name) ?? {};
        hoisted.fileMeta.set(name, {
          timeCreated: existing.timeCreated ?? new Date().toISOString(),
          metadata: opts?.metadata?.metadata,
        });
      },
    ),
    exists: vi.fn(async () => [hoisted.store.has(name)]),
    delete: vi.fn(async () => {
      hoisted.store.delete(name);
      hoisted.fileMeta.delete(name);
    }),
  });
  const bucket = {
    file: (name: string) => makeFile(name),
    getFiles: vi.fn(
      async ({
        prefix,
        maxResults = Infinity,
        pageToken,
      }: {
        prefix: string;
        maxResults?: number;
        pageToken?: string;
      }) => {
        const files = [...hoisted.store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((name) => makeFile(name));
        const remaining = pageToken
          ? files.filter((file) => file.name > pageToken)
          : files;
        const page = remaining.slice(0, maxResults);
        const nextPage =
          remaining.length > page.length
            ? { pageToken: page[page.length - 1].name }
            : null;
        return [page, nextPage];
      },
    ),
  };
  const storage = () => ({ bucket: () => bucket });

  // Firestore mock — supports the memory_embeddings.doc(userId).blocks subcollection
  // pattern used by reindexMemoryFileEmbeddings + searchMemoryHybrid.
  const docRef = (id: string) => ({
    id,
    delete: vi.fn(async () => {
      hoisted.embeddings.delete(id);
    }),
  });

  const blocksCollection = () => {
    const ref: any = {};
    ref.doc = (id?: string) => {
      const docId = id ?? `auto-${hoisted.nextEmbedId++}`;
      return docRef(docId);
    };
    ref.where = (field: string, _op: string, value: any) => {
      // Only "file == X" is used.
      const filtered: any = { ...ref };
      filtered.get = vi.fn(async () => {
        const docs = [...hoisted.embeddings.entries()]
          .filter(([, v]) => v[field] === value)
          .map(([docId, v]) => ({
            id: docId,
            ref: docRef(docId),
            data: () => v,
          }));
        return { empty: docs.length === 0, docs };
      });
      return filtered;
    };
    ref.get = vi.fn(async () => {
      const docs = [...hoisted.embeddings.entries()].map(([docId, v]) => ({
        id: docId,
        ref: docRef(docId),
        data: () => v,
      }));
      return { empty: docs.length === 0, docs };
    });
    return ref;
  };

  // agent_conversations/{phone}/messages query chain used by
  // consolidateMemoryForUser (where → orderBy → limit → get). Rows come from
  // hoisted.convMessages; filters are not modeled (tests seed in-window rows).
  const messagesCollection = () => {
    const filters: Array<[string, unknown]> = [];
    const q: any = {
      where: (field: string, op: string, value: unknown) => {
        if (op === "==") filters.push([field, value]);
        return q;
      },
      orderBy: () => q,
      limit: () => q,
      get: async () => ({
        empty: hoisted.convMessages.length === 0,
        docs: hoisted.convMessages
          .filter((m) => filters.every(([field, value]) => m[field] === value))
          .map((m, i) => ({
            id: `m${i}`,
            data: () => m,
            ref: {
              delete: async () => {
                const index = hoisted.convMessages.indexOf(m);
                if (index >= 0) hoisted.convMessages.splice(index, 1);
              },
            },
          })),
      }),
    };
    return q;
  };

  const firestore = () => ({
    collection: (name: string) => {
      if (name === "memory_embeddings") {
        return {
          doc: (_userId: string) => ({
            collection: (_sub: string) => blocksCollection(),
          }),
        };
      }
      if (name === "agent_conversations") {
        return {
          doc: (_phone: string) => ({
            collection: (_sub: string) => messagesCollection(),
          }),
        };
      }
      if (name === "agent_sessions") {
        return {
          where: (field: string, _op: string, value: string) => ({
            get: async () => {
              const docs =
                field === "userId"
                  ? [...hoisted.sessions.entries()]
                      .filter(([userId]) => userId === value)
                      .map(([, phone]) => ({
                        id: phone,
                        data: () => ({ userId: value }),
                      }))
                  : [];
              return { empty: docs.length === 0, docs };
            },
          }),
        };
      }
      // Fallback for any other collection access.
      return {
        where: () => ({
          limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
        }),
      };
    },
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: any, data: any) => {
          ops.push(() => {
            hoisted.embeddings.set(ref.id, data);
          });
        },
        delete: (ref: any) => {
          ops.push(() => {
            hoisted.embeddings.delete(ref.id);
          });
        },
        commit: vi.fn(async () => {
          ops.forEach((op) => op());
        }),
      };
    },
  });

  return {
    __esModule: true,
    default: { storage, firestore },
    storage,
    firestore,
  };
});

// U4b: consolidation-input tests inspect the prompt the model receives.
vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create: hoisted.claudeCreate } }),
}));
vi.mock("../utils/jsonUtils", () => ({ safeParseJson: () => [] }));

// embeddings module — mock so memory file writes don't try to call OpenAI.
// Two regimes: default (returns nulls — fail-open path) and "with-embeddings"
// (specific tests opt in by mocking embedText / embedMany).
vi.mock("./embeddings", async () => {
  const actual =
    await vi.importActual<typeof import("./embeddings")>("./embeddings");
  return {
    ...actual,
    embedText: vi.fn(async () => null),
    embedMany: vi.fn(async (texts: string[]) => texts.map(() => null)),
  };
});

import {
  readMemoryFile,
  writeMemoryFile,
  appendToMemoryFile,
  editMemoryFile,
  searchMemory,
  searchMemoryHybrid,
  listMemoryFiles,
  getMemoryContext,
  handleMemoryQuery,
  consolidateMemoryForUser,
  reconcileFactAcrossMemoryFiles,
  deleteEmbeddingRowsMatching,
  MEMORY_QUERY_RECONCILIATION_COPY,
  isTransientToolFile,
  cleanupExpiredTransientToolFiles,
  TRANSIENT_TOOL_MEMORY_CLASS,
  TRANSIENT_TOOL_TTL_MS,
  TRANSIENT_CLEANUP_PAGE_SIZE,
} from "./memoryFiles";
import * as embeddingsMod from "./embeddings";

beforeEach(() => {
  hoisted.store.clear();
  hoisted.fileMeta.clear();
  hoisted.embeddings.clear();
  hoisted.sessions.clear();
  hoisted.nextEmbedId = 0;
  hoisted.convMessages.length = 0;
  hoisted.claudeCreate.mockClear();
  hoisted.claudeCreate.mockImplementation(async () => ({
    content: [{ type: "text", text: "[]" }],
  }));
  store.clear();
  hoisted.reconciliation = {
    pending: false,
    storageMasked: false,
    zepMasked: false,
    pendingOperationIds: [],
  };
  vi.mocked(embeddingsMod.embedText).mockReset().mockResolvedValue(null);
  vi.mocked(embeddingsMod.embedMany)
    .mockReset()
    .mockImplementation(async (texts: string[]) => texts.map(() => null));
});

describe("editMemoryFile", () => {
  it("replaces a matching fact and reports the count", async () => {
    await writeMemoryFile("u1", "profile", "Senior: Margaret, age 78");
    const n = await editMemoryFile("u1", "profile", "age 78", "age 82");
    expect(n).toBe(1);
    expect(await readMemoryFile("u1", "profile")).toBe(
      "Senior: Margaret, age 82",
    );
  });

  it("is a no-op when the text is not found", async () => {
    await writeMemoryFile("u1", "profile", "Senior: Margaret");
    const n = await editMemoryFile("u1", "profile", "age 78", "age 82");
    expect(n).toBe(0);
    expect(await readMemoryFile("u1", "profile")).toBe("Senior: Margaret");
  });

  it("replaces every occurrence", async () => {
    await writeMemoryFile("u1", "health", "metformin\nmetformin");
    const n = await editMemoryFile("u1", "health", "metformin", "Metformin");
    expect(n).toBe(2);
    expect(await readMemoryFile("u1", "health")).toBe("Metformin\nMetformin");
  });
});

describe("searchMemory", () => {
  it("returns matching sections across files", async () => {
    await writeMemoryFile(
      "u1",
      "health",
      "## meds\nMetformin 500mg\n\n## allergies\nPenicillin",
    );
    await writeMemoryFile("u1", "family", "Son: John\n\nDaughter: Jane");
    const hits = await searchMemory("u1", "penicillin");
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("health");
    expect(hits[0].section).toContain("Penicillin");
  });

  it("returns empty on no match or empty query", async () => {
    await writeMemoryFile("u1", "health", "nothing relevant");
    expect(await searchMemory("u1", "xyz")).toEqual([]);
    expect(await searchMemory("u1", "  ")).toEqual([]);
  });
});

describe("arbitrary keys", () => {
  it("reads and writes ad-hoc file slugs and lists them", async () => {
    await writeMemoryFile("u1", "adhoc_output_123", "offloaded payload");
    expect(await readMemoryFile("u1", "adhoc_output_123")).toBe(
      "offloaded payload",
    );
    expect(await listMemoryFiles("u1")).toContain("adhoc_output_123");
  });

  it("sanitizes slugs so they cannot escape the user prefix", async () => {
    await writeMemoryFile("u1", "../../etc/passwd", "x");
    const listed = await listMemoryFiles("u1");
    expect(listed.every((f) => !f.includes("/"))).toBe(true);
    expect(await readMemoryFile("u1", "../../etc/passwd")).toBe("x");
  });
});

describe("searchMemoryHybrid", () => {
  it("falls back cleanly to substring when embedding API returns null", async () => {
    await writeMemoryFile("u1", "health", "Penicillin allergy");
    // Both mocks default to null — pure substring path.
    const hits = await searchMemoryHybrid("u1", "penicillin");
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("substring");
    expect(hits[0].section).toContain("Penicillin");
  });

  it("merges substring + semantic hits and dedups", async () => {
    // First, write a file. embedMany returns null so no embeddings get written.
    await writeMemoryFile(
      "u1",
      "health",
      "Type 2 diabetes managed with metformin",
    );

    // Now backfill an embedding manually into the hoisted store, simulating a
    // prior successful indexing pass.
    const vec = new Array(1536).fill(0);
    vec[0] = 1;
    hoisted.embeddings.set("emb1", {
      file: "health",
      block: "Type 2 diabetes managed with metformin",
      embedding: vec,
    });

    // Query embedding mock — return a vector that's similar to the stored one.
    vi.mocked(embeddingsMod.embedText).mockResolvedValueOnce(vec);

    const hits = await searchMemoryHybrid("u1", "T2DM");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.section.includes("diabetes"))).toBe(true);
  });

  it("returns empty on whitespace query without any API call", async () => {
    await writeMemoryFile("u1", "health", "nothing relevant");
    const hits = await searchMemoryHybrid("u1", "   ");
    expect(hits).toEqual([]);
    expect(vi.mocked(embeddingsMod.embedText)).not.toHaveBeenCalled();
  });
});

describe("writeMemoryFile reindexing", () => {
  it("calls embedMany for blocks on write and persists the vectors", async () => {
    const vec = new Array(1536).fill(0);
    vec[0] = 1;
    vi.mocked(embeddingsMod.embedMany).mockResolvedValueOnce([vec, vec]);

    await writeMemoryFile(
      "u1",
      "health",
      "## meds\nMetformin 500mg\n\n## allergies\nPenicillin",
    );
    // Wait a microtask — the reindex is fire-and-forget.
    await new Promise((r) => setTimeout(r, 5));

    expect(hoisted.embeddings.size).toBe(2);
    const entries = [...hoisted.embeddings.values()];
    expect(entries.every((e) => e.file === "health")).toBe(true);
  });

  it("does not throw when embedMany fails (graceful)", async () => {
    vi.mocked(embeddingsMod.embedMany).mockRejectedValueOnce(new Error("oops"));
    await expect(
      writeMemoryFile("u1", "health", "data"),
    ).resolves.toBeUndefined();
  });
});

describe("getMemoryContext", () => {
  it("orders canonical files first, then ad-hoc, and skips empty", async () => {
    await writeMemoryFile("u1", "zzz_adhoc", "adhoc");
    await writeMemoryFile("u1", "profile", "P");
    await writeMemoryFile("u1", "health", "H");
    const ctx = await getMemoryContext("u1");
    expect(ctx.indexOf("## profile")).toBeLessThan(ctx.indexOf("## health"));
    expect(ctx.indexOf("## health")).toBeLessThan(ctx.indexOf("## zzz_adhoc"));
  });

  it("appends across append calls", async () => {
    await appendToMemoryFile("u1", "recent_episodes", "- fall, no injury");
    await appendToMemoryFile("u1", "recent_episodes", "- doctor visit");
    expect(await readMemoryFile("u1", "recent_episodes")).toContain("fall");
    expect(await readMemoryFile("u1", "recent_episodes")).toContain(
      "doctor visit",
    );
  });
});

// ── U4a: reader-level reconciliation suppression (KTD9, R13/R14) ─────────────
// A stale (even PARAPHRASED) copy of a corrected/forgotten fact sitting in a
// memory file must not reach any prompt or tool result while the user's
// correction/forget operation is unresolved — enforced INSIDE these shared
// readers, so briefing/digest/trigger/matching and MCP cara_knows/search paths
// inherit it without per-call-site wiring.

describe("reconciliation suppression (U4a)", () => {
  const STALE = "## health\nMom cannot take shellfish — severe reaction noted"; // paraphrase, not exact text

  beforeEach(async () => {
    await writeMemoryFile("u1", "health", STALE);
    await writeMemoryFile("u1", "profile", "Senior: Margaret");
    // Semantic candidate for the paraphrase path.
    const vec = new Array(8).fill(0);
    vec[0] = 1;
    hoisted.embeddings.set("emb1", {
      file: "health",
      block: "Mom cannot take shellfish",
      embedding: vec,
    });
  });

  it("getMemoryContext returns EMPTY while Storage reconciliation is pending", async () => {
    hoisted.reconciliation = {
      pending: true,
      storageMasked: true,
      zepMasked: true,
      pendingOperationIds: ["forget_x"],
    };
    expect(await getMemoryContext("u1")).toBe("");
  });

  it("substring search returns nothing for the masked user (paraphrased stale fixture)", async () => {
    hoisted.reconciliation = {
      pending: true,
      storageMasked: true,
      zepMasked: false,
      pendingOperationIds: ["forget_x"],
    };
    expect(await searchMemory("u1", "shellfish")).toEqual([]);
  });

  it("hybrid (semantic) search returns nothing for the masked user — no embedding call is even made", async () => {
    hoisted.reconciliation = {
      pending: true,
      storageMasked: true,
      zepMasked: false,
      pendingOperationIds: ["forget_x"],
    };
    expect(await searchMemoryHybrid("u1", "seafood allergy")).toEqual([]);
    expect(vi.mocked(embeddingsMod.embedText)).not.toHaveBeenCalled();
  });

  it("per-store unmask: once Storage targets confirm, files return even while Zep is still masked", async () => {
    hoisted.reconciliation = {
      pending: true,
      storageMasked: false,
      zepMasked: true,
      pendingOperationIds: ["forget_x"],
    };
    const ctx = await getMemoryContext("u1");
    expect(ctx).toContain("Margaret");
    expect(await searchMemory("u1", "shellfish")).toHaveLength(1);
  });

  it("handleMemoryQuery answers with the deterministic 'updating my memory' copy — not stale recall, not an outage claim", async () => {
    hoisted.reconciliation = {
      pending: true,
      storageMasked: true,
      zepMasked: true,
      pendingOperationIds: ["forget_x"],
    };
    const send = vi.fn(async () => ({}));
    await handleMemoryQuery(
      "u1",
      "chat-1",
      send,
      "what do you know about mom?",
    );
    expect(send).toHaveBeenCalledWith(
      "chat-1",
      MEMORY_QUERY_RECONCILIATION_COPY,
    );
    expect(MEMORY_QUERY_RECONCILIATION_COPY).toContain("updating my memory");
    expect(MEMORY_QUERY_RECONCILIATION_COPY).not.toMatch(
      /unavailable|down|outage/i,
    );
  });

  it("nightly consolidation SKIPS a user with unresolved reconciliation (no resurrection from old rows)", async () => {
    hoisted.reconciliation = {
      pending: true,
      storageMasked: true,
      zepMasked: true,
      pendingOperationIds: ["forget_x"],
    };
    // Rows exist — only the early reconciliation skip prevents the model call.
    hoisted.convMessages.push({
      role: "user",
      content: "Mom cannot take shellfish",
      timestamp: Date.now() - 1000,
    });
    await expect(
      consolidateMemoryForUser("u1", "+14085550001"),
    ).resolves.toBeUndefined();
    expect(hoisted.claudeCreate).not.toHaveBeenCalled();
    expect(await readMemoryFile("u1", "health")).toBe(STALE); // untouched
  });

  it("all-clear users read normally (no false suppression)", async () => {
    const ctx = await getMemoryContext("u1");
    expect(ctx).toContain("Margaret");
    expect(await searchMemory("u1", "shellfish")).toHaveLength(1);
  });
});

// ── U4b: cross-file fact reconciliation for the correction/forget worker ─────

describe("reconcileFactAcrossMemoryFiles (U4b)", () => {
  const RETIRED = "Mom is allergic to penicillin";

  beforeEach(async () => {
    await writeMemoryFile(
      "u1",
      "health",
      "# Health\n\n**Allergies:** Mom is allergic to penicillin\n\n**Meds:** metformin",
    );
    await writeMemoryFile(
      "u1",
      "profile",
      "Senior: Margaret\nmom IS ALLERGIC TO penicillin (noted)",
    );
    await writeMemoryFile("u1", "family", "Daughter Jane lives in Austin");
  });

  it("correction rewrites every exact (case-insensitive) occurrence with the corrected value", async () => {
    const result = await reconcileFactAcrossMemoryFiles(
      "u1",
      RETIRED,
      "Mom is allergic to amoxicillin",
    );
    expect(result.filesRewritten).toBe(2);
    expect(result.occurrencesReplaced).toBe(2);
    expect(await readMemoryFile("u1", "health")).toContain(
      "Mom is allergic to amoxicillin",
    );
    expect((await readMemoryFile("u1", "health")).toLowerCase()).not.toContain(
      "penicillin",
    );
    expect((await readMemoryFile("u1", "profile")).toLowerCase()).not.toContain(
      "penicillin",
    );
    // Untouched file left exactly as written.
    expect(await readMemoryFile("u1", "family")).toBe(
      "Daughter Jane lives in Austin",
    );
  });

  it("forget removes the assertion and collapses the hole it left", async () => {
    const result = await reconcileFactAcrossMemoryFiles("u1", RETIRED, "");
    expect(result.filesRewritten).toBe(2);
    const health = await readMemoryFile("u1", "health");
    expect(health.toLowerCase()).not.toContain("penicillin");
    expect(health).toContain("metformin"); // unrelated facts survive
    expect(health).not.toMatch(/\n\s*\n\s*\n/); // no double blank runs
  });

  it("KNOWN LIMITATION (accepted by KTD9 masking): a paraphrased copy is NOT matched", async () => {
    // Fresh user so only the paraphrase exists.
    await writeMemoryFile(
      "u2",
      "health",
      "**Allergies:** severe reaction to penicillin-class antibiotics",
    );
    const result = await reconcileFactAcrossMemoryFiles("u2", RETIRED, "");
    expect(result.occurrencesReplaced).toBe(0);
    // The paraphrase survives — which is exactly why the Storage store stays
    // masked at the readers until reconciliation completes and why nightly
    // reconcile owns long-term supersede.
    expect(await readMemoryFile("u2", "health")).toContain("penicillin-class");
  });

  it("empty inputs are a safe no-op", async () => {
    expect(await reconcileFactAcrossMemoryFiles("u1", "", "x")).toEqual({
      filesScanned: 0,
      filesRewritten: 0,
      occurrencesReplaced: 0,
    });
    expect(await reconcileFactAcrossMemoryFiles("", "x", "y")).toEqual({
      filesScanned: 0,
      filesRewritten: 0,
      occurrencesReplaced: 0,
    });
  });

  it("removes conversation summaries before reconciliation can unmask the user", async () => {
    hoisted.sessions.set("u1", "+14085550001");
    hoisted.convMessages.push(
      {
        role: "summary",
        content: "<summary> Mom is allergic to penicillin.",
        timestamp: 1,
      },
      { role: "user", content: "Recent unrelated update", timestamp: 2 },
    );

    await reconcileFactAcrossMemoryFiles("u1", RETIRED, "");

    expect(hoisted.convMessages.some((row) => row.role === "summary")).toBe(
      false,
    );
    expect(hoisted.convMessages).toEqual([
      { role: "user", content: "Recent unrelated update", timestamp: 2 },
    ]);
  });
});

describe("deleteEmbeddingRowsMatching (U4b)", () => {
  it("deletes only the rows whose block text carries the retired assertion", async () => {
    hoisted.embeddings.set("e1", {
      file: "health",
      block: "Mom is allergic to penicillin",
      embedding: [1],
    });
    hoisted.embeddings.set("e2", {
      file: "health",
      block: "MOM IS ALLERGIC TO PENICILLIN (case)",
      embedding: [1],
    });
    hoisted.embeddings.set("e3", {
      file: "family",
      block: "Daughter Jane lives in Austin",
      embedding: [1],
    });

    const deleted = await deleteEmbeddingRowsMatching(
      "u1",
      "Mom is allergic to penicillin",
    );

    expect(deleted).toBe(2);
    expect(hoisted.embeddings.has("e1")).toBe(false);
    expect(hoisted.embeddings.has("e2")).toBe(false);
    expect(hoisted.embeddings.has("e3")).toBe(true);
  });

  it("no matches / empty needle are safe no-ops", async () => {
    hoisted.embeddings.set("e1", {
      file: "health",
      block: "metformin",
      embedding: [1],
    });
    expect(await deleteEmbeddingRowsMatching("u1", "penicillin")).toBe(0);
    expect(await deleteEmbeddingRowsMatching("u1", "")).toBe(0);
    expect(hoisted.embeddings.has("e1")).toBe(true);
  });
});

// ── U4b: consolidation input excludes marked source rows (KTD16/R23) ─────────

describe("consolidateMemoryForUser — excludeFromMemoryConsolidationAt rows (U4b)", () => {
  it("marked rows never enter the consolidation prompt; unmarked rows do", async () => {
    hoisted.convMessages.push(
      {
        role: "user",
        content: "Mom loves gardening",
        timestamp: Date.now() - 2000,
      },
      {
        role: "user",
        content: "Mom is allergic to penicillin",
        timestamp: Date.now() - 1000,
        excludeFromMemoryConsolidationAt: new Date().toISOString(),
        excludeFromMemoryConsolidationReason: "forget",
      },
    );

    await consolidateMemoryForUser("u1", "+14085550001");

    expect(hoisted.claudeCreate).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls[0]);
    expect(prompt).toContain("Mom loves gardening");
    expect(prompt).not.toContain("penicillin");
  });

  it("when EVERY row is marked, no model call happens at all", async () => {
    hoisted.convMessages.push({
      role: "user",
      content: "Mom is allergic to penicillin",
      timestamp: Date.now() - 1000,
      excludeFromMemoryConsolidationAt: new Date().toISOString(),
    });

    await consolidateMemoryForUser("u1", "+14085550001");

    expect(hoisted.claudeCreate).not.toHaveBeenCalled();
  });
});

// ── U8: transient tool-file isolation (R20) ──────────────────────────────────
// Offloaded tool results are transient working data: readable by exact pointer
// during their 24h lifetime, but invisible to every default retrieval surface
// — prompt concatenation, substring search, semantic candidates, consolidation
// context, and (via listMemoryFiles/getMemoryContext) MCP cara_knows.

describe("transient tool-file isolation (U8, R20)", () => {
  const TOOL_SLUG = "tool_get_invoice_history_1752700000000";

  beforeEach(async () => {
    await writeMemoryFile("u1", "profile", "Senior: Margaret");
    await writeMemoryFile(
      "u1",
      "durable_notes",
      "Family prefers morning visits",
    );
    await writeMemoryFile("u1", TOOL_SLUG, "invoice INV-9932 total $412.50", {
      memoryClass: TRANSIENT_TOOL_MEMORY_CLASS,
      expiresAt: new Date(Date.now() + TRANSIENT_TOOL_TTL_MS).toISOString(),
    });
  });

  it("isTransientToolFile classifies by metadata OR legacy tool_ prefix", () => {
    expect(isTransientToolFile(TOOL_SLUG)).toBe(true); // prefix
    expect(
      isTransientToolFile({
        name: "opaque_snapshot",
        memoryClass: "transient_tool",
      }),
    ).toBe(true); // metadata
    expect(isTransientToolFile("durable_notes")).toBe(false);
    expect(isTransientToolFile("profile")).toBe(false);
    expect(
      isTransientToolFile({ name: "health", memoryClass: undefined }),
    ).toBe(false);
  });

  it("writeMemoryFile stamps memoryClass/expiresAt onto the Storage object", () => {
    const meta = hoisted.fileMeta.get(`memory/u1/${TOOL_SLUG}.md`);
    expect(meta?.metadata?.memoryClass).toBe("transient_tool");
    expect(Date.parse(meta?.metadata?.expiresAt ?? "")).toBeGreaterThan(
      Date.now(),
    );
    // Durable writes carry no memory class.
    expect(
      hoisted.fileMeta.get("memory/u1/profile.md")?.metadata,
    ).toBeUndefined();
  });

  it("listMemoryFiles excludes transient files by default; includeTransient opts in (cleanup/maintenance only)", async () => {
    const listed = await listMemoryFiles("u1");
    expect(listed).toContain("profile");
    expect(listed).toContain("durable_notes");
    expect(listed).not.toContain(TOOL_SLUG);
    expect(await listMemoryFiles("u1", { includeTransient: true })).toContain(
      TOOL_SLUG,
    );
  });

  it("getMemoryContext (prompt/cara_knows context) excludes transient content but keeps canonical + durable ad-hoc files", async () => {
    const ctx = await getMemoryContext("u1");
    expect(ctx).toContain("Margaret");
    expect(ctx).toContain("morning visits"); // intentional durable ad-hoc file survives
    expect(ctx).not.toContain("INV-9932");
  });

  it("substring search cannot surface a transient file; durable ad-hoc files stay searchable", async () => {
    expect(await searchMemory("u1", "INV-9932")).toEqual([]);
    expect(await searchMemory("u1", "morning visits")).toHaveLength(1);
  });

  it("writeMemoryFile never indexes embeddings for a transient file even when the embedding API works", async () => {
    // Let the beforeEach durable writes' fire-and-forget reindexes settle,
    // then reset the call count so only the transient write is measured.
    await new Promise((r) => setTimeout(r, 5));
    vi.mocked(embeddingsMod.embedMany).mockClear();

    const vec = new Array(8).fill(1);
    vi.mocked(embeddingsMod.embedMany).mockResolvedValue([vec]);
    await writeMemoryFile("u2", "tool_snapshot_999", "big payload");
    await new Promise((r) => setTimeout(r, 5)); // reindex is fire-and-forget
    expect(hoisted.embeddings.size).toBe(0);
    expect(vi.mocked(embeddingsMod.embedMany)).not.toHaveBeenCalled();
  });

  it("semantic search filters LEGACY tool_ embedding rows out of the candidate set", async () => {
    const vec = new Array(8).fill(0);
    vec[0] = 1;
    // A row left behind by an old (pre-U8) tool offload.
    hoisted.embeddings.set("legacy1", {
      file: "tool_old_offload_123",
      block: "invoice INV-9932 total $412.50",
      embedding: vec,
    });
    // A durable row that must still rank.
    hoisted.embeddings.set("durable1", {
      file: "health",
      block: "Type 2 diabetes managed with metformin",
      embedding: vec,
    });
    vi.mocked(embeddingsMod.embedText).mockResolvedValueOnce(vec);

    const hits = await searchMemoryHybrid("u1", "diabetes management");
    expect(hits.some((h) => h.section.includes("metformin"))).toBe(true);
    expect(hits.every((h) => !h.file.startsWith("tool_"))).toBe(true);
    expect(hits.some((h) => h.section.includes("INV-9932"))).toBe(false);
  });

  it("exact pointer read keeps working during the transient lifetime (active-loop read path)", async () => {
    expect(await readMemoryFile("u1", TOOL_SLUG)).toBe(
      "invoice INV-9932 total $412.50",
    );
  });

  it("consolidation context excludes transient files (they never become durable memory)", async () => {
    hoisted.convMessages.push({
      role: "user",
      content: "Mom loves gardening",
      timestamp: Date.now() - 1000,
    });

    await consolidateMemoryForUser("u1", "+14085550001");

    expect(hoisted.claudeCreate).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(hoisted.claudeCreate.mock.calls[0]);
    expect(prompt).not.toContain("INV-9932");
    expect(prompt).toContain("Margaret"); // durable memory still present
  });
});

// ── U8/KTD14: expired transient cleanup ──────────────────────────────────────

describe("cleanupExpiredTransientToolFiles (U8, KTD14)", () => {
  const DAY = TRANSIENT_TOOL_TTL_MS;
  const iso = (ms: number) => new Date(ms).toISOString();

  const seedObject = (
    path: string,
    content: string,
    meta?: { timeCreated?: string; metadata?: Record<string, string> },
  ) => {
    hoisted.store.set(path, content);
    if (meta) hoisted.fileMeta.set(path, meta); // omitted = legacy object without usable metadata
  };

  it("never deletes a file younger than 24h — even when its expiresAt claims otherwise (hard guard)", async () => {
    seedObject("memory/u1/tool_fresh_1.md", "x", {
      timeCreated: iso(Date.now() - 60_000),
      metadata: {
        memoryClass: "transient_tool",
        expiresAt: iso(Date.now() - 1),
      }, // lying expiry
    });

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: 1,
      retained: 1,
      deleted: 0,
      malformed: 0,
      failed: 0,
    });
    expect(hoisted.store.has("memory/u1/tool_fresh_1.md")).toBe(true);
  });

  it("deletes an expired transient file AND its embedding rows; unrelated rows survive", async () => {
    seedObject("memory/u1/tool_expired_2.md", "invoice data", {
      timeCreated: iso(Date.now() - DAY - 3_600_000),
      metadata: {
        memoryClass: "transient_tool",
        expiresAt: iso(Date.now() - 3_600_000),
      },
    });
    hoisted.embeddings.set("e1", {
      file: "tool_expired_2",
      block: "invoice data",
      embedding: [1],
    });
    hoisted.embeddings.set("e2", {
      file: "health",
      block: "unrelated durable block",
      embedding: [1],
    });

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: 1,
      retained: 0,
      deleted: 1,
      malformed: 0,
      failed: 0,
    });
    expect(hoisted.store.has("memory/u1/tool_expired_2.md")).toBe(false);
    expect(hoisted.embeddings.has("e1")).toBe(false);
    expect(hoisted.embeddings.has("e2")).toBe(true);
  });

  it("never scans canonical or durable ad-hoc files, however old they are", async () => {
    seedObject("memory/u1/profile.md", "Senior: Margaret", {
      timeCreated: iso(Date.now() - 40 * DAY),
    });
    seedObject("memory/u1/durable_notes.md", "notes", {
      timeCreated: iso(Date.now() - 40 * DAY),
    });

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: 0,
      retained: 0,
      deleted: 0,
      malformed: 0,
      failed: 0,
    });
    expect(hoisted.store.size).toBe(2);
  });

  it("legacy tool_ slug with no metadata at all: the slug epoch-ms timestamp decides (fallback)", async () => {
    const oldTs = Date.now() - 2 * DAY;
    const freshTs = Date.now() - 60_000;
    seedObject(`memory/u1/tool_legacy_${oldTs}.md`, "old offload");
    seedObject(`memory/u1/tool_legacy_${freshTs}.md`, "fresh offload");

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: 2,
      retained: 1,
      deleted: 1,
      malformed: 0,
      failed: 0,
    });
    expect(hoisted.store.has(`memory/u1/tool_legacy_${oldTs}.md`)).toBe(false);
    expect(hoisted.store.has(`memory/u1/tool_legacy_${freshTs}.md`)).toBe(true);
  });

  it("a malformed slug without metadata is RETAINED and counted — never guessed at", async () => {
    seedObject("memory/u1/tool_no_timestamp.md", "who knows how old");

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: 1,
      retained: 0,
      deleted: 0,
      malformed: 1,
      failed: 0,
    });
    expect(hoisted.store.has("memory/u1/tool_no_timestamp.md")).toBe(true);
  });

  it("a metadata-classified transient file with a non-tool slug is still cleaned by class", async () => {
    seedObject("memory/u1/opaque_snapshot.md", "x", {
      timeCreated: iso(Date.now() - 2 * DAY),
      metadata: {
        memoryClass: "transient_tool",
        expiresAt: iso(Date.now() - DAY),
      },
    });

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: 1,
      retained: 0,
      deleted: 1,
      malformed: 0,
      failed: 0,
    });
    expect(hoisted.store.has("memory/u1/opaque_snapshot.md")).toBe(false);
  });

  it("repeated runs are idempotent — the second pass deletes nothing and fails nothing", async () => {
    seedObject("memory/u1/tool_expired_3.md", "x", {
      timeCreated: iso(Date.now() - 2 * DAY),
      metadata: {
        memoryClass: "transient_tool",
        expiresAt: iso(Date.now() - DAY),
      },
    });

    const first = await cleanupExpiredTransientToolFiles();
    expect(first.deleted).toBe(1);

    const second = await cleanupExpiredTransientToolFiles();
    expect(second).toEqual({
      scanned: 0,
      retained: 0,
      deleted: 0,
      malformed: 0,
      failed: 0,
    });
  });

  it("cleanup respects the freshly written offload end-to-end: written now → retained; expiry passed → deleted", async () => {
    // Written through the real writer (metadata path), not seeded by hand.
    await writeMemoryFile("u1", "tool_roundtrip_1", "payload", {
      memoryClass: TRANSIENT_TOOL_MEMORY_CLASS,
      expiresAt: new Date(Date.now() + TRANSIENT_TOOL_TTL_MS).toISOString(),
    });

    const fresh = await cleanupExpiredTransientToolFiles();
    expect(fresh).toEqual({
      scanned: 1,
      retained: 1,
      deleted: 0,
      malformed: 0,
      failed: 0,
    });
    expect(await readMemoryFile("u1", "tool_roundtrip_1")).toBe("payload"); // exact read still works

    // Age the object past its lifetime.
    hoisted.fileMeta.set("memory/u1/tool_roundtrip_1.md", {
      timeCreated: new Date(
        Date.now() - 2 * TRANSIENT_TOOL_TTL_MS,
      ).toISOString(),
      metadata: {
        memoryClass: "transient_tool",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });

    const later = await cleanupExpiredTransientToolFiles();
    expect(later).toEqual({
      scanned: 1,
      retained: 0,
      deleted: 1,
      malformed: 0,
      failed: 0,
    });
    expect(await readMemoryFile("u1", "tool_roundtrip_1")).toBe("");
  });

  it("paginates Storage listings while preserving aggregate counts and the 24h guard", async () => {
    for (let i = 0; i < TRANSIENT_CLEANUP_PAGE_SIZE; i++) {
      seedObject(`memory/u1/tool_expired_${i}.md`, "x", {
        timeCreated: iso(Date.now() - 2 * DAY),
        metadata: {
          memoryClass: "transient_tool",
          expiresAt: iso(Date.now() - DAY),
        },
      });
    }
    seedObject("memory/u1/tool_fresh_last.md", "x", {
      timeCreated: iso(Date.now() - 60_000),
      metadata: {
        memoryClass: "transient_tool",
        expiresAt: iso(Date.now() - DAY),
      },
    });

    const counts = await cleanupExpiredTransientToolFiles();

    expect(counts).toEqual({
      scanned: TRANSIENT_CLEANUP_PAGE_SIZE + 1,
      retained: 1,
      deleted: TRANSIENT_CLEANUP_PAGE_SIZE,
      malformed: 0,
      failed: 0,
    });
  });
});
