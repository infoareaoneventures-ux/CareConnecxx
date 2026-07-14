/**
 * Multi-recipient helpers shared by SMS onboarding finalization and job
 * posting. The web CarePlan/PostsPage UIs render one tab per care recipient:
 * the recipient LIST comes from job_postings/{uid} (careRecipientFirstName +
 * additionalRecipients[]), and each tab's plan data is looked up in
 * carePlans/{uid}.recipientPlans under the key produced by CarePlan.tsx
 * getKey — recipientPlanKey below MUST stay byte-identical to that format or
 * Evia-written plans become invisible in the web tabs.
 */

export interface CareRecipient {
  name:          string;   // first name (conversational capture is first-name based)
  relationship?: string;   // account holder's relationship to them (mother, father, ...)
  age?:          number;
}

// Mirrors components/CarePlan.tsx getKey (and PostJobFlow's key builder):
// `${first.toLowerCase()}_${(last || 'noname').toLowerCase()}` with whitespace
// collapsed to _ and Firestore-field-path-hostile chars stripped.
export function recipientPlanKey(firstName: string, lastName = ""): string {
  return `${(firstName || "").toLowerCase()}_${(lastName || "noname").toLowerCase()}`
    .replace(/\s+/g, "_")
    .replace(/[~*/[\].]/g, "");
}

// Deterministic senior_profiles doc ID for a household member — webhook
// retries and re-finalizations must not mint duplicate senior docs.
export function householdSeniorDocId(clientUid: string, name: string): string {
  return `${clientUid}_${recipientPlanKey(name)}`;
}

// Validate/normalize the LLM-extracted additionalRecipients array from
// onboardingData (shape guard only — extraction itself is LLM-driven).
export function normalizeAdditionalRecipients(raw: unknown): CareRecipient[] {
  if (!Array.isArray(raw)) return [];
  const out: CareRecipient[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const name = String((r as Record<string, unknown>).name ?? "").trim();
    if (!name) continue;
    const key = recipientPlanKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const relationship = (r as Record<string, unknown>).relationship;
    const age = Number((r as Record<string, unknown>).age);
    out.push({
      name,
      ...(relationship ? { relationship: String(relationship) } : {}),
      ...(Number.isFinite(age) && age > 0 ? { age } : {}),
    });
  }
  return out;
}

// Every care recipient in the signup: primary (seniorName/relationship/age)
// first, then additional ones — primary excluded from dupes by key.
export function allCareRecipients(d: Record<string, unknown>): CareRecipient[] {
  const primaryName = String(d.seniorName ?? "").trim();
  const primary: CareRecipient[] = primaryName
    ? [{
        name: primaryName,
        ...(d.relationship ? { relationship: String(d.relationship) } : {}),
        ...(typeof d.age === "number" && d.age > 0 ? { age: d.age } : {}),
      }]
    : [];
  const primaryKey = primaryName ? recipientPlanKey(primaryName) : "";
  const additional = normalizeAdditionalRecipients(d.additionalRecipients)
    .filter((r) => recipientPlanKey(r.name) !== primaryKey);
  return [...primary, ...additional];
}
