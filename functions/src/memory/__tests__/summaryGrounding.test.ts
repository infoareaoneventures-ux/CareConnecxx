import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * U11 memory-summary grounding (hallucination hardening, R6).
 *
 * Source-text assertions in the style of agents/__tests__/qaAgentPromptRules.test.ts:
 * every summary/rollup prompt that re-injects its output as trusted context must
 * instruct (a) transcript-only facts — never infer or invent — and (b) verbatim
 * preservation of named entities (people's names, dollar amounts, commitments).
 *
 * The rollup prompt in agents/contextManagement.ts is covered by
 * captured-prompt tests in agents/contextManagement.test.ts (its existing suite);
 * this file pins the remaining three files at the source level.
 */

const PRESERVE_ENTITIES =
  "Preserve verbatim: people's names, dollar amounts, and any commitments or promises made.";
const NEVER_INVENT = "never infer or invent";

const nightlySrc = readFileSync(resolve(__dirname, "../../scheduled/nightlyMemory.ts"), "utf8");
const memoryFilesSrc = readFileSync(resolve(__dirname, "../memoryFiles.ts"), "utf8");
const careMemorySrc = readFileSync(resolve(__dirname, "../../agents/careMemory.ts"), "utf8");

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("nightlyMemory conversation-compression prompt", () => {
  it("records only conversation facts and preserves named entities", () => {
    expect(nightlySrc).toContain(
      "Record ONLY facts present in the conversation — " + NEVER_INVENT
    );
    expect(nightlySrc).toContain(PRESERVE_ENTITIES);
  });
});

describe("memoryFiles summary prompts", () => {
  // Slice by function so one prompt can't satisfy an assertion on another's
  // behalf (same technique as qaAgentPromptRules.test.ts).
  const hmqStart = memoryFilesSrc.indexOf("export async function handleMemoryQuery");
  const reconcileStart = memoryFilesSrc.indexOf("export async function reconcileMemoryFile");
  const consolidateStart = memoryFilesSrc.indexOf("export async function consolidateMemoryForUser");

  it("function slices resolve (guards against renames silently emptying the assertions)", () => {
    expect(hmqStart).toBeGreaterThan(-1);
    expect(reconcileStart).toBeGreaterThan(hmqStart);
    expect(consolidateStart).toBeGreaterThan(reconcileStart);
  });

  const hmqSlice = memoryFilesSrc.slice(hmqStart, reconcileStart);
  const reconcileSlice = memoryFilesSrc.slice(reconcileStart, consolidateStart);
  // consolidateMemoryForUser contains BOTH the consolidation prompt and the
  // recent_episodes trim prompt.
  const consolidateSlice = memoryFilesSrc.slice(consolidateStart);

  it("handleMemoryQuery answers only from known facts — never infer or invent", () => {
    expect(hmqSlice).toContain("Use ONLY facts present in what you know below — " + NEVER_INVENT);
  });

  it("reconcileMemoryFile records only file facts and preserves named entities", () => {
    expect(reconcileSlice).toContain("Record ONLY facts present in the file — " + NEVER_INVENT);
    expect(reconcileSlice).toContain(PRESERVE_ENTITIES);
  });

  it("consolidation prompt records only conversation-event facts and preserves named entities", () => {
    expect(consolidateSlice).toContain(
      "Record ONLY facts present in the recent conversation events — " + NEVER_INVENT
    );
  });

  it("recent_episodes trim prompt records only log facts and preserves named entities", () => {
    expect(consolidateSlice).toContain(
      "Record ONLY facts present in the log — " + NEVER_INVENT
    );
  });

  it("both consolidation and trim prompts carry the preserve-entities instruction", () => {
    expect(countOccurrences(consolidateSlice, PRESERVE_ENTITIES)).toBe(2);
  });
});

describe("careMemory keepsake prompt", () => {
  it("uses only care-history facts and preserves people's names", () => {
    expect(careMemorySrc).toContain(
      "Use ONLY facts present in the care history and journal highlights — never infer or invent details."
    );
    expect(careMemorySrc).toContain("Preserve people's names verbatim");
  });
});
