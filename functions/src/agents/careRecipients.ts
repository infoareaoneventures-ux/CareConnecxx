/**
 * Multi-recipient helpers shared by SMS onboarding finalization and job
 * posting. The web CarePlan/PostsPage UIs render one tab per care recipient:
 * the recipient LIST comes from job_postings/{uid} (careRecipientFirstName +
 * additionalRecipients[]), and each tab's plan data is looked up in
 * carePlans/{uid}.recipientPlans under the key produced by CarePlan.tsx
 * getKey — recipientPlanKey below MUST stay byte-identical to that format or
 * Evia-written plans become invisible in the web tabs.
 */

import { stageOf } from "./caregiverServiceLabels";

export interface CareRecipient {
  name:          string;   // first name (conversational capture is first-name based)
  relationship?: string;   // account holder's relationship to them (mother, father, ...)
  /** Only for the relationship "Other" (child care, 2026-10-18): the family's two-way pick, adult or child. */
  careKind?: "senior" | "child";
  /** ONE stage per child (AGE_RANGES id) — set on the child, never on the post (2026-10-18 late). */
  ageRange?: string;
}

// Evia's internal "self" sentinel (checked throughout onboardingSteps.client.ts/
// qaAgent.ts for self-referential voice/logic — the texter IS the care
// recipient) is NOT the website wizard's relationship enum value. The wizard
// (ClientJobPostingWizard.tsx step 9) uses "myself" for exactly this case —
// translate at the boundary, every time onboardingData.relationship reaches a
// website-facing document (job_postings, carePlans.recipientPlans,
// clientIntakes). Every other value (parent/spouse/other) is already shared
// vocabulary and passes through unchanged.
export function toWebsiteRelationship(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  if (value === "self") return "myself";
  if (value.trim().toLowerCase() === "adult child") return "Adult child";
  return value;
}

// Mirrors components/CarePlan.tsx getKey (and PostJobFlow's key builder):
// `${first.toLowerCase()}_${(last || 'noname').toLowerCase()}` with whitespace
// collapsed to _ and Firestore-field-path-hostile chars stripped.
export function recipientPlanKey(firstName: string, lastName = ""): string {
  return `${(firstName || "").toLowerCase()}_${(lastName || "noname").toLowerCase()}`
    .replace(/\s+/g, "_")
    .replace(/[~*/[\].]/g, "");
}

// The key for a recipient known by ONE full-name string ("Margaret", "H M",
// "Mary Ann Smith"), split exactly the way the roster mirror splits it into
// job_postings.careRecipientFirstName/LastName (first token, rest = last) —
// so the key always equals the site's getKey(firstName, lastName) for the
// same person. Before this, the signup writer keyed by first name only
// ("h_noname"), the Care Plan page looked for "h_m", and a recipient with a
// last name got an empty auto-seeded plan on the site while Evia's plan (with
// the family's notes) sat hidden under the other key (found live 2026-09-26).
export function recipientPlanKeyForFullName(fullName: string): string {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  return recipientPlanKey(parts[0] ?? "", parts.slice(1).join(" "));
}

// Deterministic senior_profiles doc ID for a household member — webhook
// retries and re-finalizations must not mint duplicate senior docs.
export function householdSeniorDocId(clientUid: string, name: string): string {
  return `${clientUid}_${recipientPlanKey(name)}`;
}

// Shared resolution of a family-supplied first name to a recipientPlans key
// (extracted from save_care_task_detail — every recipient-scoped tool goes
// through this so name matching can never diverge between tools).
//   • Named: exact key match, else first-name prefix match against existing
//     keys, else a fresh key minted from the name (named lookups always
//     resolve — a new recipient is a valid outcome).
//   • Unnamed: the sole existing plan wins; 2+ plans is ambiguous; none on
//     file can't resolve.
export type RecipientKeyResolution =
  | { ok: true; key: string; named: boolean }
  | { ok: false; reason: "ambiguous" | "none_on_file" };

export function resolveRecipientKey(
  planKeys: string[],
  recipientFirstName?: string,
): RecipientKeyResolution {
  const name = String(recipientFirstName ?? "").trim();
  if (name) {
    const wanted = recipientPlanKey(name.split(" ")[0]);
    const key = planKeys.find((k) => k === wanted || k.startsWith(`${wanted.split("_")[0]}_`)) ?? wanted;
    return { ok: true, key, named: true };
  }
  if (planKeys.length === 1) return { ok: true, key: planKeys[0], named: false };
  return { ok: false, reason: planKeys.length ? "ambiguous" : "none_on_file" };
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
    const careKind = (r as Record<string, unknown>).careKind;
    const ageRange = stageOf(r as { ageRange?: unknown; ageRanges?: unknown });
    out.push({
      name,
      ...(relationship ? { relationship: String(relationship) } : {}),
      ...(careKind === "child" || careKind === "senior" ? { careKind } : {}),
      ...(ageRange ? { ageRange } : {}),
    });
  }
  return out;
}

// Prompt-grounding line for family-facing LLM message generation: who is
// texting vs who the care is for. Failure mode this exists to prevent
// (founder report 2026-07-17): a nudge context that named only the account
// holder ("Anahi's setup and payment are COMPLETE…") made the model write
// "book Anahi's first visits" when the visits are for her mom Rosie. Any
// generated family-facing copy whose context interpolates a client name must
// include this line so the model never attributes care to the account holder.
export function describeWhoIsWho(d: Record<string, unknown>): string {
  const accountHolder = String(d.firstName ?? d.name ?? "").trim().split(/\s+/)[0] ?? "";
  const relationship  = String(d.relationship ?? "").trim().toLowerCase();
  const who = accountHolder || "the account holder";

  if (relationship === "self") {
    return `WHO'S WHO: ${who} is arranging care for THEMSELVES — the person texting IS the care recipient. ` +
      "Speak to them directly (\"you\"); never refer to them in the third person and never say \"your loved one\".";
  }

  const recipients = allCareRecipients(d).filter(
    (r) => recipientPlanKey(r.name) !== recipientPlanKey(accountHolder),
  );
  if (recipients.length > 0) {
    const list = recipients
      .map((r) => r.relationship ? `${r.name} (their ${r.relationship})` : r.name)
      .join(" and ");
    return `WHO'S WHO: the person texting is ${who}, the family member coordinating care — NOT the one receiving it. ` +
      `The care recipient${recipients.length > 1 ? "s are" : " is"} ${list}: all visits, care providers, and care are for ` +
      `${recipients.length > 1 ? "them" : list.split(" (")[0]}, never for ${who}. ` +
      `Never write phrases like "${who}'s visits" or "${who}'s care".`;
  }

  if (!accountHolder) return "";
  return `WHO'S WHO: the person texting is ${who}, arranging care for a loved one (recipient's name not on file yet). ` +
    `Never assume the care is for ${who} themselves.`;
}

// Every care recipient in the signup: primary (seniorName/relationship/age)
// first, then additional ones — primary excluded from dupes by key.
export function allCareRecipients(d: Record<string, unknown>): CareRecipient[] {
  const primaryName = String(d.seniorName ?? "").trim();
  const websiteRelationship = toWebsiteRelationship(d.relationship ? String(d.relationship) : undefined);
  const primaryStage = stageOf(d as { ageRange?: unknown; ageRanges?: unknown });
  const primaryKind = d.careKind === "child" || d.careKind === "senior" ? d.careKind : undefined;
  const primary: CareRecipient[] = primaryName
    ? [{
        name: primaryName,
        ...(websiteRelationship ? { relationship: websiteRelationship } : {}),
        ...(primaryKind ? { careKind: primaryKind } : {}),
        ...(primaryStage ? { ageRange: primaryStage } : {}),
      }]
    : [];
  const primaryKey = primaryName ? recipientPlanKey(primaryName) : "";
  const additional = normalizeAdditionalRecipients(d.additionalRecipients)
    .filter((r) => recipientPlanKey(r.name) !== primaryKey);
  return [...primary, ...additional];
}
