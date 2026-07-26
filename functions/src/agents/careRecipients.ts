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

// ── Typed care-recipient union (childcare plan 2026-07-22-002, U2) ───────────
//
// The amendment extends THIS seam — resolveRecipientKey/describeWhoIsWho stay
// the senior resolution path — rather than creating a parallel recipient-
// resolution module. Senior behavior is unchanged: senior recipients keep the
// recipientPlanKey scheme below; child recipients are referenced by childId +
// householdId and are authorized EXCLUSIVELY through
// childcare/guardianAuthority.checkAuthority (never by name matching, never by
// household membership alone). A child ref carries no child PII beyond an
// optional display label (first name / nickname only — R10/R57).

export interface SeniorRecipientRef {
  vertical: "senior";
  /** recipientPlanKey-format key (see recipientPlanKey below). */
  recipientKey: string;
}

export interface ChildRecipientRef {
  vertical: "child";
  childId: string;
  householdId: string;
  /** Display label only (first name / nickname) — never full identity data. */
  displayLabel?: string;
}

export type TypedCareRecipientRef = SeniorRecipientRef | ChildRecipientRef;

export function seniorRecipientRef(firstName: string, lastName = ""): SeniorRecipientRef {
  return { vertical: "senior", recipientKey: recipientPlanKey(firstName, lastName) };
}

export function childRecipientRef(
  childId: string,
  householdId: string,
  displayLabel?: string,
): ChildRecipientRef {
  if (!childId || !householdId) throw new Error("childRecipientRef: childId and householdId are required");
  return { vertical: "child", childId, householdId, ...(displayLabel ? { displayLabel } : {}) };
}

export function isChildRecipientRef(ref: unknown): ref is ChildRecipientRef {
  return (
    !!ref &&
    typeof ref === "object" &&
    (ref as Record<string, unknown>).vertical === "child" &&
    typeof (ref as Record<string, unknown>).childId === "string" &&
    typeof (ref as Record<string, unknown>).householdId === "string"
  );
}

export function isSeniorRecipientRef(ref: unknown): ref is SeniorRecipientRef {
  return (
    !!ref &&
    typeof ref === "object" &&
    (ref as Record<string, unknown>).vertical === "senior" &&
    typeof (ref as Record<string, unknown>).recipientKey === "string"
  );
}

/**
 * Guard for senior-only consumers (manifest disposition
 * senior-only-explicit-skip): throws on a child recipient instead of silently
 * processing it — a malformed child record entering a senior path is the
 * critical risk (plan R2).
 */
export function assertSeniorRecipientRef(ref: TypedCareRecipientRef): SeniorRecipientRef {
  if (ref.vertical !== "senior") {
    throw new Error("assertSeniorRecipientRef: child recipient reached a senior-only consumer — fail closed");
  }
  return ref;
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
    const age = Number((r as Record<string, unknown>).age);
    out.push({
      name,
      ...(relationship ? { relationship: String(relationship) } : {}),
      ...(Number.isFinite(age) && age > 0 ? { age } : {}),
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
      `The care recipient${recipients.length > 1 ? "s are" : " is"} ${list}: all visits, caregivers, and care are for ` +
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
