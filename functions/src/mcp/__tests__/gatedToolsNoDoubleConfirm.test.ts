import { describe, it, expect, vi } from "vitest";

// server.ts reads Firestore at import time; a stub is enough because only the tool definitions are inspected here.
vi.mock("firebase-admin", () => {
  const col: any = () => ({ doc: () => col(), collection: col, where: col, orderBy: col, limit: col, get: async () => ({ docs: [], exists: false, data: () => ({}) }) });
  const firestore: any = Object.assign(() => ({ collection: col, runTransaction: async () => undefined, batch: () => ({}) }), {
    FieldValue: { serverTimestamp: () => "ts", delete: () => "del", increment: () => 1, arrayUnion: (...a: unknown[]) => a, arrayRemove: (...a: unknown[]) => a },
    FieldPath: { documentId: () => "id" }, Timestamp: { now: () => ({}), fromMillis: () => ({}), fromDate: () => ({}) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore, auth: () => ({}), storage: () => ({}), messaging: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});
import { MCP_TOOLS } from "../server";
import { gatedToolNames } from "../../agents/pendingActions";

// The platform's confirmation gate reads the change back and asks the person to reply YES before a gated tool runs. A
// tool description that ALSO tells the model to collect a yes first makes people confirm the same thing twice (the
// founders' emergency-contact test, 2026-11-15: "ready to add… reply yes" → yes → "I'm about to add… Reply YES").
// delete_account is the one exception by design: it runs only on the exact phrase DELETE MY ACCOUNT.
const MODEL_ASKS_FIRST = /wait for (?:their |an? |explicit )*(?:confirmation|yes)|MANDATORY: read|confirm (?:with|before)|only call after .{0,40}confirm|explicit confirmation before calling/i;

describe("gated tools do not also ask the model to collect a yes", () => {
  const gated = gatedToolNames().filter((n) => n !== "delete_account");

  it("the gate covers the tools this test expects", () => {
    expect(gated).toEqual(expect.arrayContaining(["cancel_interview", "cancel_job_post", "update_care_plan", "set_block_status", "set_subscription_status", "delete_memory_file", "review_shift_hours"]));
  });

  for (const name of gated) {
    it(`${name}: the description does not tell the model to ask first`, () => {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      expect(tool, `tool ${name} exists`).toBeTruthy();
      const text = String(tool!.description ?? "");
      // A sentence that says "do NOT ask" is the fix, not the problem.
      // A sentence about update_care_plan's 'notes' is about the one ungated section, which does need the model's yes.
      const withoutNegations = text
        .replace(/[^.]*\b(?:do not|don't|never)\b[^.]*\bask\b[^.]*\./gi, "")
        .replace(/[^.]*'notes'[^.]*\./gi, "");
      expect(withoutNegations).not.toMatch(MODEL_ASKS_FIRST);
    });
  }
});
