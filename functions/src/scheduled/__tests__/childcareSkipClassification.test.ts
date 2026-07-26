// Childcare U10 (plan 2026-07-22-002, R54/AE16): shared static source-scan.
//
// Every scheduled source registered in the childcare consumer manifest must be
// either VERTICAL-AWARE in code (an explicit careVertical branch / memory-
// eligibility gate / childcare flags read) or carry a documented manifest
// classification explaining why no code change is needed (vertical-neutral
// transport, childcare-governance-only reader, etc.). Senior health/care-plan/
// memory jobs must skip child records EXPLICITLY — the eleven U10-named
// sources are hard-asserted below.
//
// Pattern: source-scan like scripts/audit-childcare-consumers.mjs (U0 audit) —
// this test reads the SOURCE, so a refactor that silently deletes a skip line
// fails the build.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CHILDCARE_CONSUMER_MANIFEST } from "../../data/childcareConsumerManifest";

const REPO_ROOT = join(__dirname, "../../../..");

/** Code-level vertical awareness / explicit skip markers. */
const CODE_MARKER = /careVertical|decideMemoryEligibility|getChildcareFlags|childcareLifecycle|childcare/i;

/** An explicit, code-enforced child-record skip or eligibility gate. */
const EXPLICIT_SKIP = /careVertical\s*===?\s*["']child["']|decideMemoryEligibility/;

/** Manifest-notes documentation that no code change is required. */
const NOTES_CLASSIFICATION = /childcare|vertical-neutral|vertical neutral/i;

// The R54/AE16 sources this unit (U10) owns — every one must carry a
// code-enforced skip/eligibility gate, not just a manifest note.
// (upcomingVisitReminder shipped its skip in U9; asserted here regardless.)
const U10_EXPLICIT_SKIP_SOURCES = [
  "functions/src/scheduled/nightlyMemory.ts",
  "functions/src/scheduled/proactiveReflection.ts",
  "functions/src/scheduled/proactiveDraftSender.ts",
  "functions/src/scheduled/healthTrends.ts",
  "functions/src/scheduled/weeklyDigest.ts",
  "functions/src/scheduled/firstVisitActivation.ts",
  "functions/src/scheduled/familySatisfactionCheckin.ts",
  "functions/src/scheduled/morningBriefing.ts",
  "functions/src/scheduled/upcomingVisitReminder.ts",
  "functions/src/scheduled/preShiftFamilyCheckin.ts",
  "functions/src/scheduled/inShiftUpdate.ts",
];

function read(sourceFile: string): string {
  return readFileSync(join(REPO_ROOT, sourceFile), "utf8");
}

describe("scheduled-source childcare classification (R54/AE16)", () => {
  const scheduledEntries = CHILDCARE_CONSUMER_MANIFEST.filter((e) =>
    e.sourceFile.startsWith("functions/src/scheduled/"),
  );

  it("the manifest registers a meaningful scheduled surface", () => {
    expect(scheduledEntries.length).toBeGreaterThanOrEqual(30);
  });

  it("every scheduled source is vertical-aware in code OR carries a documented manifest classification", () => {
    const unclassified: string[] = [];
    for (const entry of scheduledEntries) {
      let src = "";
      try {
        src = read(entry.sourceFile);
      } catch {
        unclassified.push(`${entry.sourceFile} (missing file)`);
        continue;
      }
      const codeAware = CODE_MARKER.test(src);
      const notesClassified = NOTES_CLASSIFICATION.test(entry.notes ?? "");
      if (!codeAware && !notesClassified) unclassified.push(entry.sourceFile);
    }
    expect(
      unclassified,
      `scheduled sources with neither vertical-awareness nor a documented classification:\n${unclassified.join("\n")}`,
    ).toEqual([]);
  });

  it("every U10 senior health/care-plan/memory job carries a CODE-ENFORCED child skip or eligibility gate", () => {
    const missing = U10_EXPLICIT_SKIP_SOURCES.filter((f) => !EXPLICIT_SKIP.test(read(f)));
    expect(
      missing,
      `U10 sources missing an explicit child skip / eligibility gate:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("every U10 source is registered in the manifest with a truthful disposition", () => {
    const byFile = new Map(scheduledEntries.map((e) => [e.sourceFile, e]));
    for (const f of U10_EXPLICIT_SKIP_SOURCES) {
      const entry = byFile.get(f);
      expect(entry, `${f} missing from the consumer manifest`).toBeDefined();
      expect(
        ["senior-only-explicit-skip", "shared-vertical-aware"],
        `${f} has unexpected disposition ${entry!.disposition}`,
      ).toContain(entry!.disposition);
    }
  });

  it("no childcare PROACTIVE source exists (pilot staging decision — templates deferred)", () => {
    // Every proactive/scheduled source is classified skip-child in this unit;
    // a scheduled file with disposition child-specific would mean new
    // childcare proactive content shipped against the binding staging note.
    // (The lifecycle worker is the one sanctioned child-specific scheduled
    // consumer — it is data-rights machinery (U3), not proactive messaging.)
    const childSpecific = scheduledEntries.filter((e) => e.disposition === "child-specific");
    expect(childSpecific.map((e) => e.sourceFile)).toEqual([
      "functions/src/scheduled/childcareLifecycleWorker.ts",
    ]);
  });
});
