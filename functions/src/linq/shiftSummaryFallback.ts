/**
 * PHI-safe fallback summary for the family shift-end update (U3 — plan
 * 2026-06-23-001). Used only when the LLM summary call fails. Pure (no I/O) so
 * it is directly unit-testable.
 *
 * It deliberately uses everyday language and NEVER reproduces raw clinical
 * `observations` verbatim — SMS is not a HIPAA-compliant channel, so if
 * observations exist it flags them for follow-up rather than echoing their text.
 */
export function buildLayFallbackSummary(p: {
  seniorName: string;
  cgFirstName: string;
  mood?: string;
  appetite?: string;
  activities?: string[];
  observations?: string;
  unplannedActivities?: string[];
}): string {
  const moodLine = p.mood ? ` ${p.seniorName} was in a ${p.mood} mood.` : "";
  const ateLine = p.appetite ? ` Appetite was ${p.appetite}.` : "";
  const actLine = (p.activities?.length ?? 0) > 0
    ? ` Activities: ${p.activities!.slice(0, 2).join(" and ")}.`
    : "";
  const unplannedNote = (p.unplannedActivities?.length ?? 0) > 0
    ? ` ${p.seniorName} also asked for: ${p.unplannedActivities!.join(", ")}.`
    : "";
  // Flag observations for follow-up WITHOUT echoing their (possibly clinical) text.
  const obsLine = p.observations && p.observations.trim()
    ? ` ${p.cgFirstName} noted a couple of details from the visit — reply here and I'll walk you through them.`
    : " No concerns to flag.";
  return `${p.cgFirstName} just finished their visit with ${p.seniorName}.` +
    moodLine + ateLine + actLine + unplannedNote + obsLine;
}
