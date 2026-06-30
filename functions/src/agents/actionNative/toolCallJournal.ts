// Adapted from BuilderIO/agent-native packages/core/src/agent/tool-call-journal.ts.
// Original project: https://github.com/BuilderIO/agent-native
// License: MIT. CareConnex localizes event types and keeps the utility pure.

export interface ToolCallEvent {
  type: "tool_start" | "tool_done" | "clear";
  tool?: string;
  input?: Record<string, string>;
  result?: string;
}

export interface ToolCallJournalEntry {
  key: string;
  tool: string;
  input?: Record<string, string>;
  order: number;
  result?: string;
}

export interface ToolCallJournal {
  completed: ToolCallJournalEntry[];
  interrupted: ToolCallJournalEntry[];
}

const INPUT_SIGNATURE_MAX_CHARS = 120;
const RESULT_SUMMARY_MAX_CHARS = 400;

function inputSignature(input: Record<string, string> | undefined): string {
  if (!input) return "";
  let sig: string;
  try {
    const sorted = Object.keys(input)
      .sort()
      .reduce<Record<string, string>>((acc, key) => {
        acc[key] = input[key];
        return acc;
      }, {});
    sig = JSON.stringify(sorted);
  } catch {
    sig = String(input);
  }
  return sig.length > INPUT_SIGNATURE_MAX_CHARS ? sig.slice(0, INPUT_SIGNATURE_MAX_CHARS) : sig;
}

export function classifyToolCallJournal(events: readonly ToolCallEvent[]): ToolCallJournal {
  const openByTool = new Map<string, ToolCallJournalEntry[]>();
  const completed: ToolCallJournalEntry[] = [];
  let order = 0;

  for (const event of events) {
    if (event.type === "clear") {
      openByTool.clear();
      continue;
    }

    if (event.type === "tool_start") {
      const tool = event.tool ?? "unknown";
      const input = event.input ?? undefined;
      const entry: ToolCallJournalEntry = {
        key: `${tool}#${order}:${inputSignature(input)}`,
        tool,
        ...(input ? { input } : {}),
        order,
      };
      order += 1;
      const queue = openByTool.get(tool);
      if (queue) queue.push(entry);
      else openByTool.set(tool, [entry]);
      continue;
    }

    if (event.type === "tool_done") {
      const tool = event.tool ?? "unknown";
      const queue = openByTool.get(tool);
      const entry = queue?.shift();
      if (entry) {
        entry.result = event.result ?? "";
        completed.push(entry);
      }
      continue;
    }
  }

  const interrupted: ToolCallJournalEntry[] = [];
  for (const queue of openByTool.values()) {
    for (const entry of queue) interrupted.push(entry);
  }
  interrupted.sort((a, b) => a.order - b.order);

  return { completed, interrupted };
}

export function isJournalEmpty(journal: ToolCallJournal): boolean {
  return journal.completed.length === 0 && journal.interrupted.length === 0;
}

export function findCompletedJournalEntry(
  journal: ToolCallJournal,
  toolName: string,
  input: unknown,
  consumedKeys?: Set<string>,
): ToolCallJournalEntry | undefined {
  const wantSig = inputSignature(normalizeInputForSignature(input));
  for (const entry of journal.completed) {
    if (entry.tool !== toolName) continue;
    if (inputSignature(entry.input) !== wantSig) continue;
    if (consumedKeys?.has(entry.key)) continue;
    consumedKeys?.add(entry.key);
    return entry;
  }
  return undefined;
}

export function buildResumeJournalNote(journal: ToolCallJournal): string | null {
  if (isJournalEmpty(journal)) return null;

  const lines: string[] = [
    "Tool-call journal from the interrupted Cara turn:",
  ];

  if (journal.completed.length > 0) {
    lines.push("");
    lines.push("Already completed. Do not re-run these side effects; reuse the recorded result:");
    for (const entry of journal.completed) {
      lines.push(`- ${entry.tool}${describeInput(entry.input)} -> ${summarizeResult(entry.result)}`);
    }
  }

  if (journal.interrupted.length > 0) {
    lines.push("");
    lines.push("Interrupted or unknown outcome. Verify state before retrying if the action could duplicate a side effect:");
    for (const entry of journal.interrupted) {
      lines.push(`- ${entry.tool}${describeInput(entry.input)} -> (no result recorded)`);
    }
  }

  return lines.join("\n");
}

function normalizeInputForSignature(input: unknown): Record<string, string> | undefined {
  if (input == null || typeof input !== "object") return undefined;
  return input as Record<string, string>;
}

function summarizeResult(result: string | undefined): string {
  if (!result) return "(no result recorded)";
  const oneLine = result.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty result)";
  return oneLine.length > RESULT_SUMMARY_MAX_CHARS
    ? `${oneLine.slice(0, RESULT_SUMMARY_MAX_CHARS)}...`
    : oneLine;
}

function describeInput(input: Record<string, string> | undefined): string {
  if (!input) return "";
  const sig = inputSignature(input);
  return sig && sig !== "{}" ? ` input: ${sig}` : "";
}
