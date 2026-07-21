import { describe, expect, it, vi } from "vitest";

// weeklyDigest touches admin.firestore() and transports at module load; only
// the pure journal-context builder is under test here.
vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  const stubStorage = () => ({ bucket: () => ({}) });
  return {
    __esModule: true,
    default: { firestore: stubFs, storage: stubStorage },
    firestore: stubFs,
    storage: stubStorage,
  };
});
vi.mock("../../memory/memoryFiles", () => ({ getMemoryContext: vi.fn(async () => "") }));
vi.mock("../../memory/learnedFacts", () => ({ getRelevantFacts: vi.fn(async () => []) }));
vi.mock("firebase-functions/v1", () => {
  const chain: any = { schedule: () => chain, timeZone: () => chain, onRun: (fn: any) => fn };
  return {
    __esModule: true,
    pubsub: chain,
    https: { onCall: (fn: any) => fn, HttpsError: class extends Error {} },
  };
});
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({}) }));
vi.mock("../../linq/client", () => ({}));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn() }));
vi.mock("../../agents/permissionsConversation", () => ({ getPermissions: vi.fn() }));
vi.mock("../../mcp/server", () => ({ handlePromptGet: vi.fn(() => "digest prompt") }));

import { buildJournalContext } from "../weeklyDigest";

describe("buildJournalContext (U1/R2/AE1 — tri-state wellness in the digest prompt)", () => {
  it("renders explicit observations as recorded facts", () => {
    const ctx = buildJournalContext([{
      timestamp: "2026-07-18T09:00:00Z",
      wellness:  { mood: "bright", ateWell: true, tookMeds: false },
      notes:     "skipped evening pills",
    }]);
    expect(ctx).toContain("2026-07-18: mood bright, ate well, meds missed (recorded)");
    expect(ctx).toContain("Notes: skipped evening pills");
  });

  it("renders omitted fields as not recorded — never appetite concerns or meds missed", () => {
    const ctx = buildJournalContext([{
      timestamp: "2026-07-18T09:00:00Z",
      wellness:  { mood: "ok" },
      notes:     "watched the game together",
    }]);
    expect(ctx).toContain("appetite not recorded");
    expect(ctx).toContain("med status not recorded");
    expect(ctx).not.toContain("appetite concerns");
    expect(ctx).not.toContain("meds missed");
  });

  it("handles an entry with no wellness map at all", () => {
    const ctx = buildJournalContext([{ timestamp: "2026-07-18T09:00:00Z" }]);
    expect(ctx).toContain("mood not recorded, appetite not recorded, med status not recorded");
  });
});
