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
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

import { MCP_TOOLS, CAREGIVER_TOOLS, CLIENT_TOOLS } from "../server";

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
  // `complete_task` is a U4 loop-control signal intercepted before dispatch in
  // qaAgent.ts (it ends the turn), not a user-facing action — internal-only like
  // `task`/`resume_execution_agent`, so it is not a capability-map row.
  "task", "write_todos", "resume_execution_agent", "complete_task",
  "morning-caregiver-briefing",
  // Onboarding-loop plumbing: described per-turn by the onboarding directive
  // (buildOnboardingDirective / caregiverOnboardingDirective), not by the static
  // system prompts this guard scans — the directive is the authoritative doc.
  "save_onboarding_field", "complete_collection",
]);

const NEW_AGENT_NATIVE_TOOLS = [
  "pause_account", "reactivate_account",
  // U2 caregiver action-parity wave — hard-asserted since the 2026-07-06 audit
  // found them bound but invisible (schemas only, no prompt line).
  "start_shift", "complete_shift", "update_shift_task",
  "respond_to_booking_request", "withdraw_job_application",
  "create_caregiver_referral",
  // Payments › Timesheets (2026-10-01): the tab + its two modals as flows replaced respond_to_shift_hour_correction / get_shifts.
  "show_timesheets", "start_submit_hours_flow", "start_review_correction_flow",
];

// Client-side money tools added by the 2026-07-06 parity audit.
// update_booking_payment_method was removed along with cash itself
// (Hamse, 2026-08-23) — every booking is charged by card now.
const NEW_CLIENT_MONEY_TOOLS = ["retry_shift_payment"];

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
      // Match the tool name as a whole word so it must appear as an actual token
      // (e.g. a prompt line), not as a substring of an unrelated identifier.
      const wordRe = new RegExp(`\\b${name}\\b`);
      expect(wordRe.test(qaSource), `${name} not documented in qaAgent.ts system prompt`).toBe(true);
    }
  });

  it("keeps both role tool surfaces under OpenAI's 128-tool hard cap", () => {
    // OpenAI rejects >128 tools (400 "array too long"); capToolsForOpenAi then
    // drops an arbitrary tail. Role surfaces must fit so nothing is ever trimmed.
    const OPENAI_MAX_TOOLS = 128;
    expect(CLIENT_TOOLS.length, `CLIENT_TOOLS ${CLIENT_TOOLS.length} > ${OPENAI_MAX_TOOLS}`).toBeLessThanOrEqual(OPENAI_MAX_TOOLS);
    expect(CAREGIVER_TOOLS.length, `CAREGIVER_TOOLS ${CAREGIVER_TOOLS.length} > ${OPENAI_MAX_TOOLS}`).toBeLessThanOrEqual(OPENAI_MAX_TOOLS);
  });

  it("keeps every client-prompt-documented tool in the client surface", () => {
    // Extract tool names referenced in the client system prompt catalog and
    // assert each resolves to a tool the client loop actually passes to the
    // model — a prompt that advertises a tool the filter excludes would make
    // Evia promise actions she cannot take.
    const clientNames = new Set(CLIENT_TOOLS.map(t => t.name));
    const allNames = new Set(MCP_TOOLS.map(t => t.name));
    const clientPromptStart = qaSource.indexOf("buildClientSystemPrompt");
    const clientPromptEnd = qaSource.indexOf("buildCaregiverSystemPrompt");
    const clientPromptSrc = qaSource.slice(clientPromptStart, clientPromptEnd);
    const referenced = [...allNames].filter(n => new RegExp(`\\b${n}\\b`).test(clientPromptSrc));
    const missing = referenced.filter(n => !clientNames.has(n) && !PROMPT_EXEMPT.has(n));
    expect(missing, `client prompt names tools missing from CLIENT_TOOLS: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers the client money tools in MCP_TOOLS and the client subset", () => {
    const all = new Set(MCP_TOOLS.map(t => t.name));
    const client = new Set(CLIENT_TOOLS.map(t => t.name));
    for (const name of NEW_CLIENT_MONEY_TOOLS) {
      expect(all.has(name), `${name} missing from MCP_TOOLS`).toBe(true);
      expect(client.has(name), `${name} missing from CLIENT_TOOLS`).toBe(true);
    }
  });

  it("documents every non-exempt tool in a qaAgent.ts system prompt (hard guard)", () => {
    // Was a soft console.warn guard until 2026-07-06; the legacy back-fill is
    // done (28 gaps closed), so an undocumented tool is now a build failure —
    // a bound-but-invisible tool depends on schema text alone for discovery.
    const undocumented = MCP_TOOLS
      .map(t => t.name)
      .filter(n => !PROMPT_EXEMPT.has(n) && !qaSource.includes(n));
    expect(undocumented, `tool(s) not named in any qaAgent.ts prompt: ${undocumented.join(", ")}`).toEqual([]);
  });
});
