import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// server.ts (and its transitive imports) call admin.firestore() at module load,
// so importing it requires the firebase-admin mock even though this test only
// reads the static tool arrays.
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: Object.assign(() => ({ collection: vi.fn() }), {
    FieldValue: { arrayUnion: () => ({}), arrayRemove: () => ({}), increment: () => ({}), delete: () => ({}) },
  }),
}));
vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));

import { MCP_TOOLS, CAREGIVER_TOOLS } from "../server";

/**
 * Action-parity guard (U3).
 *
 * Asserts directly against in-code data structures (NOT by parsing the Markdown
 * capability map, which would be brittle): every tool the agent loop exposes must
 * be documented by name in the system-prompt builders in qaAgent.ts, so the model
 * actually knows the tool exists. See context/capability-map.md (KTD-1).
 *
 * The new agent-native tools (U1/U2) are asserted hard. Pre-existing undocumented
 * tools are soft-reported (console.warn) rather than failing the build, so this
 * guard can land without first back-filling every legacy gap.
 */

const qaSource = readFileSync(join(__dirname, "../../agents/qaAgent.ts"), "utf8");

// Tools that are intentionally not surfaced as individual prompt lines (internal
// helpers / scheduled-job markers / dynamically described tools).
const PROMPT_EXEMPT = new Set<string>([
  "task", "write_todos", "resume_execution_agent",
  "morning-caregiver-briefing", "weekly-care-summary",
]);

const NEW_AGENT_NATIVE_TOOLS = ["pause_account", "reactivate_account", "accept_shift", "decline_shift"];

describe("action parity (U3)", () => {
  it("registers the new agent-native tools in MCP_TOOLS and the caregiver subset", () => {
    const all = new Set(MCP_TOOLS.map(t => t.name));
    const caregiver = new Set(CAREGIVER_TOOLS.map(t => t.name));
    for (const name of NEW_AGENT_NATIVE_TOOLS) {
      expect(all.has(name), `${name} missing from MCP_TOOLS`).toBe(true);
      expect(caregiver.has(name), `${name} missing from CAREGIVER_TOOLS`).toBe(true);
    }
  });

  it("documents the new agent-native tools in the caregiver system prompt", () => {
    for (const name of NEW_AGENT_NATIVE_TOOLS) {
      expect(qaSource.includes(name), `${name} not documented in qaAgent.ts system prompt`).toBe(true);
    }
  });

  it("reports any tools not documented in the system prompt (soft guard)", () => {
    const undocumented = MCP_TOOLS
      .map(t => t.name)
      .filter(n => !PROMPT_EXEMPT.has(n) && !qaSource.includes(n));
    if (undocumented.length > 0) {
      // Informational only — known gaps are allowed (capability-map ⚠️ rows).
      console.warn(`[parity] ${undocumented.length} tool(s) not named in qaAgent.ts prompt:`, undocumented.join(", "));
    }
    // The guard never fails on legacy gaps; it only surfaces them.
    expect(Array.isArray(undocumented)).toBe(true);
  });
});
