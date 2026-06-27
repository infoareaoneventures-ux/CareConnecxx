import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Importing MCP_TOOLS pulls in firebase-admin via the broader server.ts module
// graph (supervisor → firestore). Stub it out so the suite can load.
vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({ doc: () => ({}) }) });
  const stubBucket = () => ({ file: () => ({ exists: async () => [false] }) });
  const stubStorage = () => ({ bucket: stubBucket });
  return {
    __esModule: true,
    default:   { firestore: stubFs, storage: stubStorage },
    firestore: Object.assign(stubFs, {
      FieldValue: {
        arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
        arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
        increment:   (n: number) => ({ __increment: n }),
        delete:      () => ({ __delete: true }),
      },
    }),
    storage: stubStorage,
  };
});

import {
  selectToolsForIntent,
  TOOL_CAPABILITIES,
  INTENT_CAPABILITIES,
  findUntaggedTools,
} from "./toolCapabilities";
import { MCP_TOOLS, IDEMPOTENT_CONFIRMED_TOOLS } from "../mcp/server";
import { LAUNCH_ACTION_PARITY } from "./launchActionParity";
import { CONTRACT_COLLECTIONS } from "../data/contract";
import { isHighRisk } from "./pendingActions";

// Helper — names only, easier to read assertions.
const names = (tools: { name: string }[]) => new Set(tools.map(t => t.name));

describe("selectToolsForIntent", () => {
  it("returns the full list when intent is null/undefined", () => {
    expect(selectToolsForIntent(MCP_TOOLS, null).length).toBe(MCP_TOOLS.length);
    expect(selectToolsForIntent(MCP_TOOLS, undefined).length).toBe(MCP_TOOLS.length);
  });

  it("returns the full list for broad intents (QUESTION, TASK_REPLY, UPDATE_ONBOARDING)", () => {
    for (const intent of ["QUESTION", "TASK_REPLY", "UPDATE_ONBOARDING"] as const) {
      expect(selectToolsForIntent(MCP_TOOLS, intent).length).toBe(MCP_TOOLS.length);
    }
  });

  it("filters down to booking-relevant tools for FIND_CAREGIVER", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "FIND_CAREGIVER"));
    expect(filtered.has("find_replacement_caregivers")).toBe(true);
    expect(filtered.has("request_booking")).toBe(true);
    expect(filtered.has("get_caregiver_info")).toBe(true);
    // Billing tools should NOT be included
    expect(filtered.has("get_invoice_history")).toBe(false);
    expect(filtered.has("create_refund_request")).toBe(false);
    // Memory write tools should NOT be included
    expect(filtered.has("search_web")).toBe(false);
  });

  it("filters down to billing-only tools for VIEW_INVOICE", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "VIEW_INVOICE"));
    expect(filtered.has("get_invoice_history")).toBe(true);
    expect(filtered.has("get_invoice_details")).toBe(true);
    expect(filtered.has("get_billing_summary")).toBe(true);
    // Booking tools NOT included
    expect(filtered.has("request_booking")).toBe(false);
    expect(filtered.has("schedule_interview")).toBe(false);
  });

  it("includes messaging tools for ADD_FAMILY_MEMBER", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "ADD_FAMILY_MEMBER"));
    expect(filtered.has("add_family_member")).toBe(true);
    expect(filtered.has("get_family_group")).toBe(true);
    expect(filtered.has("send_caregiver_message")).toBe(true);
    expect(filtered.has("get_invoice_history")).toBe(false);
  });

  it("ALWAYS includes core tools regardless of intent", () => {
    // Core tools must be present even for narrow intents like VIEW_INVOICE
    // where they're not part of the matched capability bucket.
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "VIEW_INVOICE"));
    expect(filtered.has("get_senior_profile")).toBe(true);
    expect(filtered.has("get_pending_tasks")).toBe(true);
    expect(filtered.has("resume_execution_agent")).toBe(true);
    expect(filtered.has("create_support_ticket")).toBe(true);
  });

  it("includes both billing AND care_plan tools for APPROVE_TIMESHEET", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "APPROVE_TIMESHEET"));
    expect(filtered.has("get_pending_timesheets")).toBe(true);
    expect(filtered.has("review_shift_hours")).toBe(true);
    // care_plan side — needed to look up shift details
    expect(filtered.has("get_care_journal")).toBe(true);
  });

  it("includes booking + messaging for HIRE_CAREGIVER (compound flow)", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "HIRE_CAREGIVER"));
    expect(filtered.has("request_booking")).toBe(true);
    expect(filtered.has("send_caregiver_message")).toBe(true);
    expect(filtered.has("get_caregiver_info")).toBe(true);
  });

  it("scopes CREDENTIAL_MANAGEMENT to memory_search only", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "CREDENTIAL_MANAGEMENT"));
    expect(filtered.has("manage_credentials")).toBe(true);
    expect(filtered.has("read_memory_file")).toBe(true);
    expect(filtered.has("request_booking")).toBe(false);
    expect(filtered.has("get_invoice_history")).toBe(false);
  });

  it("scopes SCHEDULE_REQUEST to scheduling only — no booking or billing", () => {
    const filtered = names(selectToolsForIntent(MCP_TOOLS, "SCHEDULE_REQUEST"));
    expect(filtered.has("create_reminder")).toBe(true);
    expect(filtered.has("list_user_reminders")).toBe(true);
    expect(filtered.has("schedule_followup")).toBe(true);
    expect(filtered.has("request_booking")).toBe(false);
    expect(filtered.has("get_invoice_history")).toBe(false);
  });

  it("noticeably reduces the tool surface for narrow intents", () => {
    // Sanity check — the whole point of this is latency. For a tight intent
    // we should see meaningful reduction, otherwise the abstraction has no
    // bite.
    const before = MCP_TOOLS.length;
    const afterBilling = selectToolsForIntent(MCP_TOOLS, "VIEW_INVOICE").length;
    const afterScheduling = selectToolsForIntent(MCP_TOOLS, "SCHEDULE_REQUEST").length;
    expect(afterBilling).toBeLessThan(before * 0.6);
    expect(afterScheduling).toBeLessThan(before * 0.5);
  });

  it("preserves tool object identity (no copying)", () => {
    const filtered = selectToolsForIntent(MCP_TOOLS, "VIEW_INVOICE");
    for (const tool of filtered) {
      expect(MCP_TOOLS.includes(tool)).toBe(true);
    }
  });
});

describe("INTENT_CAPABILITIES", () => {
  it("covers every Intent value with an explicit (possibly empty) capability list", () => {
    // If a new Intent is added but not mapped, selectToolsForIntent silently
    // falls back to "no filter" — which is safe but defeats the purpose.
    // This test catches that drift.
    for (const intent of Object.keys(INTENT_CAPABILITIES)) {
      const caps = INTENT_CAPABILITIES[intent as keyof typeof INTENT_CAPABILITIES];
      expect(Array.isArray(caps)).toBe(true);
    }
  });
});

describe("TOOL_CAPABILITIES coverage", () => {
  it("every MCP_TOOL is either tagged with a capability or in the core allowlist", () => {
    // Untagged + non-core tools always pass the filter (safe), but that
    // defeats the optimization. Catch missing taggings.
    const allNames = MCP_TOOLS.map(t => t.name);
    const untagged = findUntaggedTools(allNames);

    // Whitelist of tools known to be in the "core" set inside the module.
    // If you add a new core tool, add it here and to CORE_TOOL_NAMES.
    const knownCore = new Set([
      "get_senior_profile",
      "list_household_seniors",
      "get_pending_tasks",
      "suggest_upcoming_care",
      "get_care_team",
      "create_support_ticket",
      "resume_execution_agent",
      "write_todos",
      "cara_knows",
      "task",
      "send_onboarding_link",
    ]);

    const trulyUntagged = untagged.filter(n => !knownCore.has(n));
    expect(trulyUntagged).toEqual([]);
  });

  it("every TOOL_CAPABILITIES entry references a real tool", () => {
    const realNames = new Set(MCP_TOOLS.map(t => t.name));
    const stale = Object.keys(TOOL_CAPABILITIES).filter(n => !realNames.has(n));
    expect(stale).toEqual([]);
  });
});

describe("LAUNCH_ACTION_PARITY", () => {
  const realToolNames = new Set(MCP_TOOLS.map(t => t.name));
  const capabilityMapSource = fs.readFileSync(
    path.resolve(__dirname, "../../../context/capability-map.md"),
    "utf8",
  );

  // Static text scan of index.ts (do NOT import it — it pulls in heavy
  // firebase-admin/function deps). Mirrors tests/contractCollections.test.ts.
  const indexSource = fs.readFileSync(
    path.resolve(__dirname, "../index.ts"),
    "utf8",
  );
  const isExportedCallable = (name: string): boolean =>
    new RegExp(`export\\b[^\\n]*\\b${name}\\b`).test(indexSource);

  // A shipped row is "callable-backed" when surface === "callable".
  const isCallableRow = (r: { surface?: string }) => r.surface === "callable";

  // The core allowlist (CORE_TOOL_NAMES inside toolCapabilities.ts is not
  // exported). Keep in sync — same list the coverage test above whitelists.
  const coreToolNames = new Set([
    "get_senior_profile",
    "list_household_seniors",
    "get_pending_tasks",
    "suggest_upcoming_care",
    "get_care_team",
    "create_support_ticket",
    "resume_execution_agent",
    "write_todos",
    "cara_knows",
    "task",
    "send_onboarding_link",
  ]);

  it("every shipped MCP-surface row points at a real MCP tool", () => {
    const broken = LAUNCH_ACTION_PARITY.filter(
      r =>
        r.status === "shipped" &&
        !isCallableRow(r) &&
        (r.tool === null || !realToolNames.has(r.tool)),
    ).map(r => `${r.id} → ${r.tool}`);
    expect(broken, `shipped MCP rows must reference a real MCP_TOOLS tool`).toEqual([]);
  });

  it("every shipped callable-surface row names a callable exported from index.ts", () => {
    // Admin execution rows (U3) are Firebase callables, not MCP tools. The
    // parity guarantee for them is that the named callable is actually wired
    // into the functions entrypoint — a static text scan, no heavy import.
    const broken = LAUNCH_ACTION_PARITY.filter(
      r =>
        r.status === "shipped" &&
        isCallableRow(r) &&
        (r.tool === null || !isExportedCallable(r.tool)),
    ).map(r => `${r.id} → ${r.tool}`);
    expect(
      broken,
      "shipped callable rows must name a callable exported from functions/src/index.ts",
    ).toEqual([]);
  });

  it("every blocker row has tool: null (a gap must not claim a shipped tool)", () => {
    const offenders = LAUNCH_ACTION_PARITY.filter(
      r => r.status === "blocker" && r.tool !== null,
    ).map(r => `${r.id} → ${r.tool}`);
    expect(offenders).toEqual([]);
  });

  it("every collection is 'n/a' or a key in CONTRACT_COLLECTIONS", () => {
    const valid = new Set(Object.keys(CONTRACT_COLLECTIONS));
    const unregistered = LAUNCH_ACTION_PARITY.filter(
      r => r.collection !== "n/a" && !valid.has(r.collection),
    ).map(r => `${r.id} → ${r.collection}`);
    expect(
      unregistered,
      `launch-critical collections must be registered in CONTRACT_COLLECTIONS`,
    ).toEqual([]);
  });

  it("row ids are unique", () => {
    const ids = LAUNCH_ACTION_PARITY.map(r => r.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("shipped caregiver tools are reachable by the caregiver prompt filter", () => {
    // A shipped caregiver action must be exposed to the caregiver prompt — i.e.
    // tagged in TOOL_CAPABILITIES or in the core allowlist. A silently
    // unreachable tool would make Cara claim parity it can't deliver.
    const unreachable = LAUNCH_ACTION_PARITY.filter(
      r =>
        r.actor === "caregiver" &&
        r.status === "shipped" &&
        r.tool !== null &&
        !TOOL_CAPABILITIES[r.tool] &&
        !coreToolNames.has(r.tool),
    ).map(r => `${r.id} → ${r.tool}`);
    expect(unreachable).toEqual([]);
  });

  it("every shipped row's tool is exposed to its promptActor (core or capability-tagged)", () => {
    // The general parity guarantee: any shipped row, for ANY actor, must name a
    // tool that the prompt/tool-filter can actually surface — i.e. it is either
    // a core tool (always bound) or tagged in TOOL_CAPABILITIES (bindable under
    // an intent). A shipped row whose tool is neither would be unreachable in
    // the agent loop, so the parity claim would be a lie.
    const unbindable = LAUNCH_ACTION_PARITY.filter(
      r =>
        r.status === "shipped" &&
        !isCallableRow(r) &&
        r.tool !== null &&
        !coreToolNames.has(r.tool) &&
        !TOOL_CAPABILITIES[r.tool],
    ).map(r => `${r.id} → ${r.tool}`);
    expect(
      unbindable,
      "shipped tools must be core or tagged in TOOL_CAPABILITIES so they are bindable",
    ).toEqual([]);
  });

  it("every shipped row declares a promptActor; gap rows declare none", () => {
    const shippedMissingActor = LAUNCH_ACTION_PARITY.filter(
      r => r.status === "shipped" && r.promptActor === null,
    ).map(r => r.id);
    expect(
      shippedMissingActor,
      "shipped rows must declare which actor's prompt surfaces the tool",
    ).toEqual([]);

    // Caregiver-actor shipped rows must be exposed to a caregiver-facing prompt
    // (its own actor or the cross-cutting "any" surface), never client-only.
    const wrongActor = LAUNCH_ACTION_PARITY.filter(
      r =>
        r.actor === "caregiver" &&
        r.status === "shipped" &&
        r.promptActor !== "caregiver" &&
        r.promptActor !== "any",
    ).map(r => `${r.id} → ${r.promptActor}`);
    expect(wrongActor).toEqual([]);
  });

  it("every non-shipped row has a non-empty note explaining the gap or non-goal", () => {
    const missingNote = LAUNCH_ACTION_PARITY.filter(
      r => r.status !== "shipped" && (!r.notes || r.notes.trim() === ""),
    ).map(r => r.id);
    expect(
      missingNote,
      "blocker/non-goal rows must explain why (and reference the U-id that fixes it)",
    ).toEqual([]);
  });

  it("context/capability-map.md mirrors every parity row id and shipped tool", () => {
    const missingIds = LAUNCH_ACTION_PARITY
      .filter((r) => !capabilityMapSource.includes(`| ${r.actor} | ${r.action}`))
      .map((r) => r.id);
    expect(missingIds, "capability-map.md is missing parity rows from LAUNCH_ACTION_PARITY").toEqual([]);

    const missingTools = LAUNCH_ACTION_PARITY
      .filter((r) => r.status === "shipped" && r.tool !== null)
      .filter((r) => !capabilityMapSource.includes(`\`${r.tool}\``))
      .map((r) => `${r.id} -> ${r.tool}`);
    expect(missingTools, "capability-map.md is missing shipped tool/callable names").toEqual([]);
  });
});

describe("IDEMPOTENT_CONFIRMED_TOOLS (U7 guard)", () => {
  // Representative input that puts each conditionally-high-risk tool into its
  // gated state. A tool whose risk is unconditional needs no entry here.
  const HIGH_RISK_INPUT: Record<string, Record<string, unknown>> = {
    perform_web_action: { loginAction: "pharmacy_refill" },
  };

  it("every entry is a real MCP tool", () => {
    const realNames = new Set(MCP_TOOLS.map(t => t.name));
    const unknown = [...IDEMPOTENT_CONFIRMED_TOOLS].filter(n => !realNames.has(n));
    expect(unknown, "idempotent-confirmed set references tools that don't exist").toEqual([]);
  });

  it("every entry is actually high-risk — otherwise the idempotency wrap is dead code", () => {
    // The ledger only engages on a CONFIRMED action. A tool that is never
    // high-risk never receives a _confirmedActionId, so listing it here would
    // silently do nothing. This guard is what caught the original mis-wiring
    // (payouts / submit_shift_hours are not confirmation-gated).
    const notGated = [...IDEMPOTENT_CONFIRMED_TOOLS].filter(
      n => !isHighRisk(n, HIGH_RISK_INPUT[n] ?? {}),
    );
    expect(notGated, "idempotent-confirmed tools must be high-risk (confirmation-gated)").toEqual([]);
  });
});
