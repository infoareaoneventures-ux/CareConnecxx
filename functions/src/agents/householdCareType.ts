// agents/householdCareType.ts — the family's ONE care-type setting (child care,
// 2026-10-18 evening): the website's Account Settings › Care type row (Senior
// care / Child care / Both), stored on job_postings/{uid}.careKinds and picked
// once at signup. Everywhere else the RELATIONSHIP decides which list a
// recipient sees (recipientCareKind) — no per-step question anywhere.
//
// ROSTER RULE (the page's and this twin's, word for word): a pick that leaves a
// recipient on the roster uncovered is refused —
//   "H M is a Parent. Choose Both, or remove H M first."
import * as admin from "firebase-admin";
import {
  CareKind, CARE_KIND_LABEL, normalizeCareKinds, recipientCareKind, careTypeChangeBlockedBy, relationshipsForKinds,
} from "./caregiverServiceLabels";

const db = admin.firestore();

export interface RosterMember {
  firstName: string;
  lastName: string;
  name: string;
  relationship: string;
  /** Only stored for the relationship "Other" (the two-way pick); everyone else's kind follows the relationship. */
  careKind?: "senior" | "child";
  kind: CareKind;
  isPrimary: boolean;
}

/** The household roster the page's rule runs over: the primary + additionalRecipients on job_postings/{uid}. */
export function rosterFromJobPostings(jp: Record<string, unknown> | undefined | null): RosterMember[] {
  const out: RosterMember[] = [];
  if (!jp) return out;
  const pFirst = String(jp.careRecipientFirstName ?? "").trim();
  if (pFirst) {
    const pLast = String(jp.careRecipientLastName ?? "").trim();
    const rel = String(jp.relationship ?? "");
    const ck = jp.careRecipientCareKind === "child" || jp.careRecipientCareKind === "senior" ? jp.careRecipientCareKind : undefined;
    out.push({ firstName: pFirst, lastName: pLast, name: [pFirst, pLast].filter(Boolean).join(" "), relationship: rel, ...(ck ? { careKind: ck } : {}), kind: recipientCareKind(rel, ck), isPrimary: true });
  }
  for (const r of (Array.isArray(jp.additionalRecipients) ? jp.additionalRecipients : []) as Array<Record<string, unknown>>) {
    const f = String(r?.firstName ?? "").trim();
    if (!f) continue;
    const l = String(r?.lastName ?? "").trim();
    const rel = String(r?.relationship ?? "");
    const ck = r?.careKind === "child" || r?.careKind === "senior" ? r.careKind : undefined;
    out.push({ firstName: f, lastName: l, name: [f, l].filter(Boolean).join(" "), relationship: rel, ...(ck ? { careKind: ck } : {}), kind: recipientCareKind(rel, ck), isPrimary: false });
  }
  return out;
}

/** The sentence the page shows when a pick would leave someone uncovered. */
export function careTypeRefusalLine(blocked: { name: string; relationship: string }): string {
  const rel = blocked.relationship || "care recipient";
  return `${blocked.name} is a ${rel}. Choose Both, or remove ${blocked.name} first.`;
}

/** The one line Evia sends when a family asks for a kind of care their household setting doesn't include. */
export function careTypeSettingHint(kind: CareKind): string {
  return `${CARE_KIND_LABEL[kind]} isn't on this household yet — change the care type to Both in Account Settings, or tell me to and I'll do it.`;
}

export function careTypeLabel(kinds: unknown): string {
  const k = normalizeCareKinds(kinds);
  return k.length === 2 ? "Both" : CARE_KIND_LABEL[k[0]];
}

/** The household's setting + roster, from job_postings/{uid} (missing field = senior). */
export async function loadHouseholdCareType(clientId: string): Promise<{ kinds: CareKind[]; roster: RosterMember[]; relationships: string[] }> {
  const snap = await db.collection("job_postings").doc(clientId).get().catch(() => null);
  const jp = (snap?.exists ? snap.data() : {}) as Record<string, unknown>;
  const kinds = normalizeCareKinds(jp.careKinds);
  return { kinds, roster: rosterFromJobPostings(jp), relationships: relationshipsForKinds(kinds) };
}

export type SetCareTypeResult =
  | { ok: true; kinds: CareKind[]; label: string; unchanged: boolean }
  | { ok: false; message: string };

/** The Account Settings › Care type row's Save, with the roster rule. */
export async function setHouseholdCareType(clientId: string, proposed: unknown): Promise<SetCareTypeResult> {
  const kinds = normalizeCareKinds(proposed);
  const { kinds: current, roster } = await loadHouseholdCareType(clientId);
  const blocked = careTypeChangeBlockedBy(kinds, roster);
  if (blocked) return { ok: false, message: careTypeRefusalLine(blocked) };
  const unchanged = current.join("|") === kinds.join("|");
  if (!unchanged) await db.collection("job_postings").doc(clientId).set({ careKinds: kinds }, { merge: true });
  return { ok: true, kinds, label: careTypeLabel(kinds), unchanged };
}
