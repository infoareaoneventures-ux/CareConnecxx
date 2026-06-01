/**
 * Known-names registry for the persona-shift detector.
 *
 * The persona-shift detector ([personaShiftDetector.ts]) guards the shared-phone
 * case (one family member texting about a different care recipient). Its blind
 * spot is NAME COLLISIONS: any name that isn't the single senior on file looks
 * like a "different care recipient" — so asking about a caregiver named "Imran",
 * a second care recipient ("Dad" when the plan started with "Mom"), or a family
 * member who shares a name all tripped a false alarm.
 *
 * To fix that without a Firestore read on every inbound, we keep a per-session
 * `knownNames` list (lowercased first names of everyone Cara already expects on
 * this account — the client, their care recipients, family members, and their
 * connected/discussed caregivers). It's appended at care events (a match shown,
 * a booking confirmed, onboarding completed) and read for free off the session
 * when the detector runs.
 */

import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * Reduce a full name to its lowercased first-name token — that's all the
 * detector needs to recognize "Imran Mohamed" when the user types "Imran".
 * Returns [] for empty / placeholder names.
 */
export function firstNameToken(name?: string | null): string {
  const raw = (name ?? "").trim().toLowerCase();
  if (!raw) return "";
  // Drop obvious placeholders we use when a real name isn't known yet.
  if (raw === "there" || raw === "your loved one" || raw === "the person on file" ||
      raw === "unknown" || raw === "caregiver" || raw === "__parse_error__") return "";
  const first = raw.split(/\s+/)[0];
  // Strip punctuation a name token wouldn't carry.
  return first.replace(/[^a-z'-]/g, "");
}

function tokensOf(names: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const t = firstNameToken(n);
    if (t) out.add(t);
  }
  return [...out];
}

/**
 * Append names to the session's knownNames registry (idempotent — arrayUnion of
 * normalized first-name tokens). Best-effort: never throws, never blocks.
 */
export async function addKnownNames(
  phone: string,
  names: Array<string | undefined | null>
): Promise<void> {
  const tokens = tokensOf(names);
  if (tokens.length === 0) return;
  await db.collection("agent_sessions").doc(phone).update({
    knownNames: admin.firestore.FieldValue.arrayUnion(...tokens),
  }).catch(() => {/* non-critical — detector also folds in live session fields */});
}

/**
 * Assemble the full set of known first-name tokens for the detector, combining
 * the persisted registry with names live on the session (client, senior, and
 * recently-discussed caregivers from pendingMatches) so coverage holds even
 * before the registry has been populated for an older session.
 */
export function collectKnownNames(session: Record<string, unknown>): string[] {
  const out = new Set<string>();

  const registry = (session.knownNames as string[] | undefined) ?? [];
  for (const t of registry) {
    const tok = firstNameToken(t);
    if (tok) out.add(tok);
  }

  const od = (session.onboardingData as Record<string, unknown> | undefined) ?? {};
  for (const t of tokensOf([
    od.firstName as string | undefined,
    od.seniorName as string | undefined,
    (session as any).seniorName as string | undefined,
  ])) out.add(t);

  // Every recipient on a multi-recipient care plan, if present on the session.
  const recipients = (od.recipients as Array<{ name?: string }> | undefined) ?? [];
  for (const r of recipients) {
    const t = firstNameToken(r?.name);
    if (t) out.add(t);
  }

  // Caregivers currently being discussed (the screenshot case).
  const pending = (session.pendingMatches as Array<{ name?: string }> | undefined) ?? [];
  for (const m of pending) {
    const t = firstNameToken(m?.name);
    if (t) out.add(t);
  }

  return [...out];
}
