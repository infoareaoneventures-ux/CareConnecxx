import { describe, expect, it } from "vitest";
import {
  buildResumeJournalNote,
  classifyToolCallJournal,
  findCompletedJournalEntry,
} from "./toolCallJournal";

describe("toolCallJournal", () => {
  it("matches tool_done to the oldest open start for the same tool", () => {
    const journal = classifyToolCallJournal([
      { type: "tool_start", tool: "send_setup_link", input: { clientId: "c1" } },
      { type: "tool_start", tool: "send_setup_link", input: { clientId: "c2" } },
      { type: "tool_done", tool: "send_setup_link", result: "sent c1" },
      { type: "tool_done", tool: "send_setup_link", result: "sent c2" },
    ]);

    expect(journal.completed.map(entry => entry.result)).toEqual(["sent c1", "sent c2"]);
    expect(journal.interrupted).toEqual([]);
  });

  it("reports started calls without tool_done as interrupted", () => {
    const journal = classifyToolCallJournal([
      { type: "tool_start", tool: "create_support_ticket", input: { clientId: "c1" } },
    ]);

    expect(journal.completed).toEqual([]);
    expect(journal.interrupted).toHaveLength(1);
    expect(journal.interrupted[0]).toMatchObject({ tool: "create_support_ticket" });
  });

  it("clears discarded partial starts when a clear event arrives", () => {
    const journal = classifyToolCallJournal([
      { type: "tool_start", tool: "send_setup_link", input: { clientId: "c1" } },
      { type: "clear" },
    ]);

    expect(journal.completed).toEqual([]);
    expect(journal.interrupted).toEqual([]);
  });

  it("finds completed entries by tool and normalized input signature only once", () => {
    const journal = classifyToolCallJournal([
      { type: "tool_start", tool: "send_setup_link", input: { clientId: "c1", kind: "payment" } },
      { type: "tool_done", tool: "send_setup_link", result: "sent" },
    ]);
    const consumed = new Set<string>();

    const first = findCompletedJournalEntry(
      journal,
      "send_setup_link",
      { kind: "payment", clientId: "c1" },
      consumed,
    );
    const second = findCompletedJournalEntry(
      journal,
      "send_setup_link",
      { kind: "payment", clientId: "c1" },
      consumed,
    );

    expect(first?.result).toBe("sent");
    expect(second).toBeUndefined();
  });

  it("builds a resume note with completed and interrupted state", () => {
    const journal = classifyToolCallJournal([
      { type: "tool_start", tool: "send_setup_link", input: { clientId: "c1" } },
      { type: "tool_done", tool: "send_setup_link", result: "sent" },
      { type: "tool_start", tool: "submit_shift_hours", input: { appointmentId: "a1" } },
    ]);

    const note = buildResumeJournalNote(journal);

    expect(note).toContain("Already completed");
    expect(note).toContain("send_setup_link");
    expect(note).toContain("Interrupted or unknown outcome");
    expect(note).toContain("submit_shift_hours");
  });
});
