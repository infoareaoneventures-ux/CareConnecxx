import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory storage bucket shared with the firebase-admin mock.
const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  return { files };
});

vi.mock("firebase-admin", () => {
  const bucket = {
    file: (path: string) => ({
      download: async () => {
        if (!h.files.has(path)) throw new Error("not found");
        return [Buffer.from(h.files.get(path)!, "utf-8")];
      },
      save: async (content: string) => { h.files.set(path, String(content)); },
    }),
    getFiles: async () => [[]],
  };
  const storage = () => ({ bucket: () => bucket });
  const firestore = Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} });
  return { __esModule: true, default: { storage, firestore }, storage, firestore };
});

// Keep writeMemoryFile's reindex a no-op (no embeddings network).
vi.mock("./embeddings", () => ({
  embedText: vi.fn(async () => null),
  embedMany: vi.fn(async () => []),
  splitIntoBlocks: vi.fn(() => []),
  rankBySimilarity: vi.fn(() => []),
  EMBED_MODEL: "test",
}));

const create = vi.fn();
vi.mock("../utils/claudeClient", () => ({
  getSharedClient: () => ({ messages: { create } }),
}));

import { reconcileMemoryFile, readMemoryFile } from "./memoryFiles";

const USER = "u1";
const llmReply = (text: string) => ({ content: [{ type: "text", text }] });
// Long enough to clear RECONCILE_MIN_CHARS (800).
const padded = (s: string) => s + "\n" + "- note ".repeat(140);

beforeEach(() => {
  h.files.clear();
  create.mockReset();
});

describe("reconcileMemoryFile", () => {
  it("rewrites a file with contradictory/duplicate facts to the reconciled version", async () => {
    const original = padded("- Lisinopril 10mg daily\n- Lisinopril 20mg daily (updated)\n- Penicillin allergy");
    h.files.set(`memory/${USER}/health.md`, original);
    const reconciled = "- Lisinopril 20mg daily\n- Penicillin allergy";
    create.mockResolvedValue(llmReply(reconciled));

    const changed = await reconcileMemoryFile(USER, "health");

    expect(changed).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await readMemoryFile(USER, "health")).toBe(reconciled);
  });

  it("passes the full file to the model so distinct facts can be preserved", async () => {
    const original = padded("- Lives in Austin\n- Daughter Maria is primary contact");
    h.files.set(`memory/${USER}/profile.md`, original);
    create.mockResolvedValue(llmReply("- Lives in Austin\n- Daughter Maria is primary contact"));

    await reconcileMemoryFile(USER, "profile");

    const sentContent = create.mock.calls[0][0].messages[0].content;
    expect(sentContent).toContain("Lives in Austin");
    expect(sentContent).toContain("Daughter Maria is primary contact");
  });

  it("is a no-op when the file is already clean (idempotent)", async () => {
    const clean = padded("- Mom is 82");
    h.files.set(`memory/${USER}/family.md`, clean.trim());
    create.mockResolvedValue(llmReply(clean.trim()));
    expect(await reconcileMemoryFile(USER, "family")).toBe(false);
  });

  it("skips files below the reconcile threshold without calling the model", async () => {
    h.files.set(`memory/${USER}/health.md`, "- short");
    expect(await reconcileMemoryFile(USER, "health")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not write when the model returns empty", async () => {
    const original = padded("- some facts");
    h.files.set(`memory/${USER}/health.md`, original);
    create.mockResolvedValue(llmReply(""));
    expect(await reconcileMemoryFile(USER, "health")).toBe(false);
    expect(await readMemoryFile(USER, "health")).toBe(original);
  });

  it("returns false (no crash) when the model errors", async () => {
    const original = padded("- some facts");
    h.files.set(`memory/${USER}/health.md`, original);
    create.mockRejectedValueOnce(new Error("anthropic down"));
    expect(await reconcileMemoryFile(USER, "health")).toBe(false);
  });
});
