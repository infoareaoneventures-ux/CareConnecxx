// ── Edits at the end of the family intake (the recap) — 2026-10-21 ───────────
//
// Founder: "I want them to be able to change anything they would like except the
// account holder info that was entered such as the first and last name. Also, at
// the end, I want it to allow making corrections like selecting care selection
// etc by adding or removing one thing."
//
// One model read turns the reply into a structured edit (readRecapEdit); the
// code validates every value with the same rules the intake uses and applies it
// deterministically (applyRecapEdit):
//   - any field: frequency, start / end / ongoing, days / flexible / time of day,
//     home and care address, rate, provider count, pets, smoking, recovery email,
//     emergency contact (name / phone / relationship)
//   - care types: ADD one or more, REMOVE one or more, or REPLACE the list
//   - the people: rename one person, change one child's stage, change one
//     person's relationship, remove one person, or restate the whole roster
//   - NEVER the account holder's own first / last name (the site has no edit for it)
// When a people edit can't tell WHO (two or more on the post and no name or
// relationship in the reply), the caller asks "Whose name — you or Mahad C?" and
// resolves on the next reply.
import { AGE_RANGES, ageRangeFromWords, ageRangeLabel, serviceLabel } from "./caregiverServiceLabels";
import { coerceClientRate, isFieldFilled } from "./onboardingContract";
import { normalizeStartDateToISO, formatWizardPhone, mapTimeOfDayToWizardValues } from "./clientJobPostingContract";
import {
  type FamilyIntakeDeps, type RosterPerson, rosterFromData, dataFromRoster, normalizeRelationship, normalizeDayCodes,
  normalizeFrequency, isValidZip, personPhrase, readRoster, MAX_PROVIDERS, isChildPerson,
} from "./familyIntakeScript";

type Data = Record<string, unknown>;

/** The question for a field they named without giving its new value ("can you fix the day"). */
export const FIELD_QUESTIONS: Record<string, string> = {
  selectedDays: "Sure — which day(s) should it be?",
  daysFlexible: "Sure — which day(s) should it be, or are the days flexible?",
  timeOfDay: "Sure — morning, afternoon, evening, or overnight?",
  careFrequency: "Sure — occasional, part-time, or full-time?",
  startDate: "Sure — when should care start?",
  endDate: "Sure — through what date, or is it ongoing?",
  ongoing: "Sure — through what date, or is it ongoing?",
  rate: "Sure — what hourly rate?",
  caregiversNeeded: "Sure — how many care providers, 1 to 4?",
  careNeeds: "Sure — which care types should I add or remove?",
  petsInHome: "Sure — are there pets in the home?",
  smokingHousehold: "Sure — does anyone in the household smoke?",
  emergencyContactName: "Sure — who should we contact in an emergency? Their name and phone number.",
  emergencyContactPhone: "Sure — what's the emergency contact's phone number?",
  emergencyContactRelationship: "Sure — what's their relationship to you?",
  homeStreet: "Sure — what's the home address (street and ZIP)?",
  homeZipCode: "Sure — what's the home ZIP code?",
  street: "Sure — where is care needed? Same as home, or another street and ZIP?",
  zipCode: "Sure — what's the ZIP code where care is needed?",
  email: "Sure — what email should I use?",
  people: "Sure — who should the care be for, or what should I change about them?",
};
export function questionForField(field: unknown): string {
  const f = String(field ?? "").trim();
  return FIELD_QUESTIONS[f] ?? "Sure — what should it be?";
}

export interface RecapEdit {
  /** They named WHAT to change but not the new value — the field key; nothing else is set. */
  ask?: unknown;
  careFrequency?: unknown; startDate?: unknown; ongoing?: unknown; endDate?: unknown;
  selectedDays?: unknown; daysFlexible?: unknown; timeOfDay?: unknown;
  homeStreet?: unknown; homeZipCode?: unknown; sameAsHomeAddress?: unknown; street?: unknown; zipCode?: unknown;
  rate?: unknown; caregiversNeeded?: unknown; petsInHome?: unknown; smokingHousehold?: unknown; email?: unknown;
  emergencyContactName?: unknown; emergencyContactPhone?: unknown; emergencyContactRelationship?: unknown;
  photo?: unknown;
  careNeeds?: { add?: unknown; remove?: unknown; replace?: unknown };
  people?: {
    rename?: { from?: unknown; to?: unknown };
    stage?: { who?: unknown; stage?: unknown };
    relationship?: { who?: unknown; to?: unknown };
    remove?: unknown;
    restate?: unknown;
  };
}

/** One model read of the reply → a structured edit (values still unvalidated). */
export async function readRecapEdit(deps: FamilyIntakeDeps, text: string, d: Data, hint?: string): Promise<RecapEdit | null> {
  const t = deps.today();
  const people = rosterFromData(d).map((p) => (p.relationship === "self" ? "the account holder (you)" : `${p.name || personPhrase(p)} (${p.relationship})`)).join("; ");
  const raw = await deps.parseWithClaude(
    `Today is ${t.weekday}, ${t.iso}. The family was shown a summary of their care request and is changing something. People on the request: ${people || "none yet"}. ` +
      (hint ? `Evia just asked them: "${hint}" — their message is the answer to that question. ` : "") +
      "Extract ONLY what they are changing, as raw JSON with any of: " +
      '{"careFrequency":"occasional|part_time|full_time","startDate":"YYYY-MM-DD or ASAP","ongoing":true,"endDate":"YYYY-MM-DD","selectedDays":["MON"],"daysFlexible":true,"timeOfDay":["morning"],' +
      '"homeStreet":"","homeZipCode":"","sameAsHomeAddress":true,"street":"","zipCode":"","rate":0,"caregiversNeeded":0,"petsInHome":true,"smokingHousehold":false,"email":"",' +
      '"emergencyContactName":"","emergencyContactPhone":"","emergencyContactRelationship":"","photo":true,' +
      '"careNeeds":{"add":["things to ADD, in their words"],"remove":["things to REMOVE, in their words"],"replace":["the whole new list when they restate it"]},' +
      '"people":{"rename":{"from":"old name or relationship if said","to":"new name"},"stage":{"who":"name or relationship if said","stage":"' + AGE_RANGES.map((a) => a.label).join("|") + '"},' +
      '"relationship":{"who":"name if said","to":"self|parent|spouse|adult child|child|other"},"remove":"name or relationship of the person to remove","restate":"the phrase naming WHO the care is for when they restate the whole list"}}. ' +
      'Rules: "add X" / "also X" → careNeeds.add; "remove X" / "not X" / "take off X" → careNeeds.remove. A name change is people.rename (never careNeeds). ' +
      'If they say WHAT to change but not the new value ("can you fix the day", "change the rate"), return ONLY {"ask":"<field key>"} — NEVER invent a value they did not give. ' +
      "The account holder's own first/last name is NEVER changed here — if they try, return {}. Omit everything not clearly changed. No markdown.",
    text,
  ).catch(() => "{}");
  try {
    const p = JSON.parse(raw) as RecapEdit;
    return p && typeof p === "object" ? p : null;
  } catch { return null; }
}

/** Find one person on the roster by a name or a relationship word; null when nobody / ambiguous. */
export function resolvePerson(roster: RosterPerson[], who: unknown): { index: number } | { ambiguous: true } | null {
  const w = String(who ?? "").trim().toLowerCase();
  if (!w) return roster.length === 1 ? { index: 0 } : roster.length ? { ambiguous: true } : null;
  if (["you", "me", "myself", "self", "the account holder", "the account holder (you)"].includes(w)) {
    const i = roster.findIndex((p) => p.relationship === "self");
    return i >= 0 ? { index: i } : null;
  }
  const byName = roster.map((p, i) => ({ p, i })).filter(({ p }) => p.name && (p.name.toLowerCase() === w || p.name.toLowerCase().startsWith(w) || w.startsWith(p.name.toLowerCase())));
  if (byName.length === 1) return { index: byName[0].i };
  if (byName.length > 1) return { ambiguous: true };
  const rel = normalizeRelationship(w);
  if (rel) {
    const byRel = roster.map((p, i) => ({ p, i })).filter(({ p }) => p.relationship === rel);
    if (byRel.length === 1) return { index: byRel[0].i };
    if (byRel.length > 1) return { ambiguous: true };
  }
  return null;
}

export interface AppliedRecapEdit {
  /** Fields to merge (empty when nothing valid was changed). */
  fields: Data;
  /** Short lines of what changed / what was left off, for the ack. */
  notes: string[];
  /** A question to ask when a people edit couldn't tell who. */
  ask?: string;
  /** The field they want to change without having given the value — the next reply answers `ask`. */
  askField?: string;
  /** The pending people edit to resolve on the next reply (stored on the session). */
  pending?: { kind: "rename" | "stage" | "relationship" | "remove"; to?: string; stage?: string };
  /** True when the roster changed and the script should finish it (name / stage / a new care list). */
  rosterChanged: boolean;
}

export async function applyRecapEdit(deps: FamilyIntakeDeps, d: Data, edit: RecapEdit): Promise<AppliedRecapEdit> {
  const t = deps.today();
  const fields: Data = {};
  const notes: string[] = [];
  let rosterChanged = false;

  // They named the field but not the value (2026-10-24, live: "can you fix the day" became MON out of thin air).
  if (typeof edit.ask === "string" && edit.ask.trim()) return { fields, notes, rosterChanged, ask: questionForField(edit.ask), askField: edit.ask.trim() };

  const freq = normalizeFrequency(edit.careFrequency); if (freq) { fields.careFrequency = freq; notes.push(`${freq === "occasional" ? "occasional" : freq === "part_time" ? "part-time" : "full-time"} care`); }
  const start = normalizeStartDateToISO(edit.startDate, t.iso); if (start) { fields.startDate = start; notes.push(`starting ${start === t.iso ? "as soon as possible" : start}`); }
  if (edit.ongoing === true) { fields.ongoing = true; fields.endDate = null; notes.push("ongoing"); }
  const end = normalizeStartDateToISO(edit.endDate, t.iso); if (end) { fields.endDate = end; fields.ongoing = false; notes.push(`through ${end}`); }
  const days = normalizeDayCodes(edit.selectedDays); if (days.length) { fields.selectedDays = days; fields.daysFlexible = false; notes.push(days.join("/")); }
  if (edit.daysFlexible === true) { fields.daysFlexible = true; fields.selectedDays = []; notes.push("flexible days"); }
  const tod = mapTimeOfDayToWizardValues(edit.timeOfDay); if (tod.length) { fields.timeOfDay = tod; notes.push(tod.join("/")); }
  if (typeof edit.homeStreet === "string" && edit.homeStreet.trim()) { fields.homeStreet = edit.homeStreet.trim(); notes.push("home address"); }
  if (isValidZip(edit.homeZipCode)) { fields.homeZipCode = String(edit.homeZipCode).trim(); const pl = await deps.lookupZipPlace(fields.homeZipCode as string).catch(() => null); if (pl) { fields.homeCity = pl.city; fields.homeState = pl.state; } }
  if (edit.sameAsHomeAddress === true) { fields.sameAsHomeAddress = true; fields.street = (fields.homeStreet ?? d.homeStreet) as string; fields.zipCode = (fields.homeZipCode ?? d.homeZipCode) as string; fields.city = (fields.homeCity ?? d.homeCity ?? null) as string | null; fields.state = (fields.homeState ?? d.homeState ?? null) as string | null; notes.push("care at your home address"); }
  if (typeof edit.street === "string" && edit.street.trim()) { fields.street = edit.street.trim(); fields.sameAsHomeAddress = false; notes.push("care address"); }
  if (isValidZip(edit.zipCode)) { fields.zipCode = String(edit.zipCode).trim(); fields.sameAsHomeAddress = false; const pl = await deps.lookupZipPlace(fields.zipCode as string).catch(() => null); if (pl) { fields.city = pl.city; fields.state = pl.state; } }
  const rate = coerceClientRate(edit.rate); if (rate !== null) { fields.rate = rate; notes.push(`$${rate}/hr`); }
  const providers = Number(edit.caregiversNeeded); if (Number.isInteger(providers) && providers >= 1 && providers <= MAX_PROVIDERS) { fields.caregiversNeeded = providers; notes.push(`${providers} care provider${providers === 1 ? "" : "s"}`); }
  if (typeof edit.petsInHome === "boolean") { fields.petsInHome = edit.petsInHome; fields.householdAsked = true; notes.push(edit.petsInHome ? "pets in the home" : "no pets"); }
  if (typeof edit.smokingHousehold === "boolean") { fields.smokingHousehold = edit.smokingHousehold; fields.householdAsked = true; notes.push(edit.smokingHousehold ? "someone smokes" : "no smoking"); }
  if (typeof edit.email === "string" && /^\S+@\S+\.\S+$/.test(edit.email.trim())) { fields.email = edit.email.trim().toLowerCase(); notes.push("recovery email"); }
  if (typeof edit.emergencyContactName === "string" && edit.emergencyContactName.trim()) { fields.emergencyContactName = edit.emergencyContactName.trim(); notes.push("emergency contact"); }
  const ePhone = formatWizardPhone(edit.emergencyContactPhone); if (ePhone) { fields.emergencyContactPhone = ePhone; notes.push("emergency contact phone"); }
  if (edit.photo === true) notes.push("for the photo, just send the new picture here and I'll swap it in");
  // The care address follows a changed home address while care is at home (the site stores both).
  if ((fields.homeStreet !== undefined || fields.homeZipCode !== undefined) && edit.sameAsHomeAddress !== true && !edit.street && !edit.zipCode && d.sameAsHomeAddress === true) {
    Object.assign(fields, { street: fields.homeStreet ?? d.homeStreet ?? null, zipCode: fields.homeZipCode ?? d.homeZipCode ?? null, city: fields.homeCity ?? d.homeCity ?? null, state: fields.homeState ?? d.homeState ?? null });
  }
  if (typeof edit.emergencyContactRelationship === "string" && edit.emergencyContactRelationship.trim()) { fields.emergencyContactRelationship = edit.emergencyContactRelationship.trim(); notes.push("emergency contact relationship"); }

  // care types: add / remove one or more, or replace the list
  if (edit.careNeeds && typeof edit.careNeeds === "object") {
    const existing = Array.isArray(d.careNeeds) ? (d.careNeeds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const words = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((s) => s.trim()) : []);
    const addW = words(edit.careNeeds.add), removeW = words(edit.careNeeds.remove), replaceW = words(edit.careNeeds.replace);
    let next = [...existing];
    if (replaceW.length) {
      const c = await deps.canonicalizeCareNeeds(replaceW);
      if (c.careNeeds.length) { next = c.careNeeds; notes.push(`care types: ${c.careNeeds.map(serviceLabel).join(", ")}`); }
      const unmappedR = c.unmapped.filter((w) => !c.careNeeds.some((n) => n.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(n.toLowerCase())));
      if (unmappedR.length) notes.push(`${unmappedR.join(", ")} isn't one of the services on the list, so I left it off`);
    }
    if (addW.length) {
      const c = await deps.canonicalizeCareNeeds(addW);
      for (const n of c.careNeeds) if (!next.includes(n)) next.push(n);
      if (c.careNeeds.length) notes.push(`added ${c.careNeeds.map(serviceLabel).join(", ")}`);
      if (c.medical.length) notes.push(`${c.medical.join(", ")} is medical care, which care providers here don't do, so I left it off`);
      // "meal" next to "Meal Preparation" is the same thing said twice, not an unknown service (live 2026-10-24).
      const unmappedA = c.unmapped.filter((w) => !c.careNeeds.some((n) => n.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(n.toLowerCase())));
      if (unmappedA.length) notes.push(`${unmappedA.join(", ")} isn't one of the services on the list, so I left it off`);
    }
    if (removeW.length) {
      const c = await deps.canonicalizeCareNeeds(removeW);
      const gone = c.careNeeds.filter((n) => next.includes(n));
      next = next.filter((n) => !gone.includes(n));
      if (gone.length) notes.push(`removed ${gone.map(serviceLabel).join(", ")}`);
      const notThere = c.careNeeds.filter((n) => !gone.includes(n));
      if (notThere.length) notes.push(`${notThere.map(serviceLabel).join(", ")} wasn't on the list`);
    }
    if (!next.length) notes.push("at least one care type is needed — I kept the list as it was");
    else if (next.join("|") !== existing.join("|")) fields.careNeeds = next;
  }

  // the people
  if (edit.people && typeof edit.people === "object") {
    const roster = rosterFromData(d);
    const p = edit.people;
    if (typeof p.restate === "string" && p.restate.trim()) {
      const r = await readRoster(deps, p.restate, { first: String(d.firstName ?? ""), last: String(d.lastName ?? "") }).catch(() => null);
      if (r) { Object.assign(fields, dataFromRoster(r.roster), { rosterCountConfirmed: r.roster.length > 1 ? true : null }); rosterChanged = true; notes.push("who the care is for"); }
    } else {
      if (p.rename && typeof p.rename === "object" && typeof p.rename.to === "string" && p.rename.to.trim()) {
        const to = p.rename.to.trim();
        const hit = resolvePerson(roster, p.rename.from);
        if (hit && "index" in hit) {
          if (roster[hit.index].relationship === "self") notes.push("your own name is set at signup and can't be changed here");
          else { roster[hit.index] = { ...roster[hit.index], name: to }; Object.assign(fields, dataFromRoster(roster)); rosterChanged = true; notes.push(`${to}`); }
        } else if (hit && "ambiguous" in hit) {
          return { fields, notes, rosterChanged, ask: `Whose name — ${roster.map((x) => (x.relationship === "self" ? "you" : x.name || personPhrase(x))).join(" or ")}?`, pending: { kind: "rename", to } };
        }
      }
      if (p.stage && typeof p.stage === "object") {
        const stage = ageRangeFromWords(p.stage.stage);
        if (stage) {
          const children = roster.map((x, i) => ({ x, i })).filter(({ x }) => isChildPerson(x));
          const hit = p.stage.who ? resolvePerson(roster, p.stage.who) : children.length === 1 ? { index: children[0].i } : children.length ? { ambiguous: true as const } : null;
          if (hit && "index" in hit && isChildPerson(roster[hit.index])) { roster[hit.index] = { ...roster[hit.index], ageRange: stage }; Object.assign(fields, dataFromRoster(roster)); rosterChanged = true; notes.push(`${roster[hit.index].name || "the child"}: ${ageRangeLabel(stage)}`); }
          else if (hit && "ambiguous" in hit) return { fields, notes, rosterChanged, ask: `Which child — ${children.map(({ x }) => x.name || personPhrase(x)).join(" or ")}?`, pending: { kind: "stage", stage } };
        }
      }
      if (p.relationship && typeof p.relationship === "object") {
        const rel = normalizeRelationship(p.relationship.to);
        if (rel && rel !== "unknown") {
          const hit = resolvePerson(roster, p.relationship.who);
          if (hit && "index" in hit) {
            const cur = roster[hit.index];
            if (cur.relationship === "self") notes.push("your own entry stays as Myself");
            else { roster[hit.index] = { relationship: rel, name: cur.name, ...(rel === "child" && cur.ageRange ? { ageRange: cur.ageRange } : {}) }; Object.assign(fields, dataFromRoster(roster)); rosterChanged = true; notes.push(`${cur.name || personPhrase(cur)}: ${rel === "self" ? "you" : rel}`); }
          } else if (hit && "ambiguous" in hit) return { fields, notes, rosterChanged, ask: `Who do you mean — ${roster.map((x) => (x.relationship === "self" ? "you" : x.name || personPhrase(x))).join(" or ")}?`, pending: { kind: "relationship", to: rel } };
        }
      }
      if (typeof p.remove === "string" && p.remove.trim()) {
        const hit = resolvePerson(roster, p.remove);
        if (hit && "index" in hit) {
          if (roster.length === 1) notes.push("at least one person has to be on the request — I kept them");
          else { const gone = roster[hit.index]; roster.splice(hit.index, 1); Object.assign(fields, dataFromRoster(roster)); rosterChanged = true; notes.push(`removed ${gone.relationship === "self" ? "you" : gone.name || personPhrase(gone)}`); }
        } else if (hit && "ambiguous" in hit) return { fields, notes, rosterChanged, ask: `Who should I remove — ${roster.map((x) => (x.relationship === "self" ? "you" : x.name || personPhrase(x))).join(" or ")}?`, pending: { kind: "remove" } };
      }
    }
  }

  return { fields, notes, rosterChanged };
}

/** Finish a pending people edit with the reply that names the person. */
export function applyPendingPersonEdit(d: Data, pending: { kind: "rename" | "stage" | "relationship" | "remove"; to?: string; stage?: string }, whoText: string): AppliedRecapEdit {
  const roster = rosterFromData(d);
  const hit = resolvePerson(roster, whoText);
  if (!hit || !("index" in hit)) return { fields: {}, notes: [], rosterChanged: false, ask: `I didn't catch who — ${roster.map((x) => (x.relationship === "self" ? "you" : x.name || personPhrase(x))).join(" or ")}?`, pending };
  const cur = roster[hit.index];
  const notes: string[] = [];
  switch (pending.kind) {
    case "rename":
      if (cur.relationship === "self") { notes.push("your own name is set at signup and can't be changed here"); return { fields: {}, notes, rosterChanged: false }; }
      roster[hit.index] = { ...cur, name: pending.to ?? cur.name }; notes.push(pending.to ?? ""); break;
    case "stage":
      if (!isChildPerson(cur) || !pending.stage) { notes.push(`${cur.name || personPhrase(cur)} isn't a child, so there's no stage to set`); return { fields: {}, notes, rosterChanged: false }; }
      roster[hit.index] = { ...cur, ageRange: pending.stage }; notes.push(`${cur.name}: ${ageRangeLabel(pending.stage)}`); break;
    case "relationship": {
      const rel = normalizeRelationship(pending.to);
      if (!rel || rel === "unknown" || cur.relationship === "self") { notes.push("your own entry stays as Myself"); return { fields: {}, notes, rosterChanged: false }; }
      roster[hit.index] = { relationship: rel, name: cur.name, ...(rel === "child" && cur.ageRange ? { ageRange: cur.ageRange } : {}) }; notes.push(`${cur.name || personPhrase(cur)}: ${rel}`); break;
    }
    case "remove":
      if (roster.length === 1) { notes.push("at least one person has to be on the request — I kept them"); return { fields: {}, notes, rosterChanged: false }; }
      roster.splice(hit.index, 1); notes.push(`removed ${cur.relationship === "self" ? "you" : cur.name || personPhrase(cur)}`); break;
  }
  return { fields: dataFromRoster(roster), notes, rosterChanged: true };
}

export const RECAP_EDIT_FALLBACK = "No problem — tell me what to change: the days, time of day, start date, address, rate, a care type (add or remove one), the emergency contact, a person's name or stage, or who the care is for. If it looks right, just say yes and I'll show you who can help.";

/** For tests: a value is "set" the way the intake means it. */
export const _isFieldFilled = isFieldFilled;
