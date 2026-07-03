/**
 * When a family front-loads several answers in one onboarding message, the
 * absorb+skip logic in onboardingConversation advances past those steps — but
 * each skipped step's acknowledgment ("Lovely to meet you, Sarah", "Got it,
 * Dorothy") is lost, so Evia lands on the next question as if she ignored
 * everything they just said.
 *
 * summarizeFrontload builds a short, human recap of the care facts just
 * captured so Evia can acknowledge them before asking the next question.
 * Returns null when there's nothing worth a standalone acknowledgment — i.e.
 * the user answered a single question normally (the landing handler already
 * acknowledges those), or fewer than two distinct question-groups were
 * front-loaded. Pure + deterministic so the gating logic is testable without
 * an LLM or the firebase import chain.
 */
export function summarizeFrontload(
  absorbed: Record<string, unknown>,
  data: Record<string, unknown>,
): string | null {
  const groups = {
    name:     "firstName" in absorbed,
    senior:   "seniorName" in absorbed || "relationship" in absorbed,
    needs:    "age" in absorbed || "careNeeds" in absorbed || "conditions" in absorbed,
    location: "city" in absorbed || "zipCode" in absorbed,
    schedule: "schedule" in absorbed,
  };
  const groupCount = Object.values(groups).filter(Boolean).length;
  // Only worth a standalone recap when they front-loaded across 2+ questions.
  if (groupCount < 2) return null;

  const bits: string[] = [];
  if (groups.senior && typeof data.seniorName === "string" && data.seniorName) {
    const rel = typeof data.relationship === "string" ? data.relationship.trim() : "";
    bits.push(rel ? `${rel} ${data.seniorName}` : `${data.seniorName}`);
  }
  if (groups.needs) {
    const age        = typeof data.age === "number" && data.age > 0 ? `${data.age}` : null;
    const conditions = Array.isArray(data.conditions) ? (data.conditions as string[]) : [];
    const careNeeds  = Array.isArray(data.careNeeds)  ? (data.careNeeds  as string[]) : [];
    const detail = [age, ...conditions, ...careNeeds].filter((x): x is string => !!x);
    if (detail.length) bits.push(detail.slice(0, 3).join(", "));
  }
  if (groups.location && typeof data.city === "string" && data.city) {
    bits.push(`in ${data.city}`);
  }
  if (groups.schedule && typeof data.schedule === "string" && data.schedule) {
    bits.push(`${data.schedule}`);
  }
  // Need at least one concrete care fact to recap (the family member's own
  // first name is used as a direct address by the caller, not recapped here).
  if (bits.length < 1) return null;
  return bits.join(", ");
}
