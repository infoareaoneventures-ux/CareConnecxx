// agents/carePlanPage.ts — the website's Care Plan page (components/CarePlan.tsx)
// as one shared read/write module, 2026-09-17.
//
// The page is: recipient tabs (job_postings/{uid} roster: careRecipientFirstName
// + additionalRecipients − deletedRecipients, plus any orphaned plan key) and,
// per recipient, four sections read from carePlans/{uid}.recipientPlans[key]
// with the page's own wizard-data defaults — Care Needs & Tasks (careNeeds +
// careNeedDetails), Care Location (locations[0], picked from the shared
// locationPool), Notes, Lifestyle & Preferences — plus the Emergency Contacts
// card (care_plans/{uid}.emergencyContacts via dbService.updateCarePlan, and
// the signup "setup contact" on job_postings.emergency*) and the "Looks good"
// review banner (carePlans.carePlanReviewedAt).
//
// Every write here is the page's own write (same doc, same field, same shape):
// saveSection → update({ [`recipientPlans.${key}`]: wholePlan }) + the
// senior_profiles.needs mirror; saveNewRecipient; deleteRecipient; saveContacts
// (dbService.updateCarePlan); handleReview.
import * as admin from "firebase-admin";
import { recipientPlanKey } from "./careRecipients";
import { geocodeStreetAddress, lookupZipPlace } from "../utils/geocode";

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

// ── The page's vocabularies ─────────────────────────────────────────────────
export const CARE_TYPES = [
  "Mobility Assistance", "Dementia / Memory Care", "Medication Reminders",
  "Personal Care", "Companionship", "Transportation",
  "Meal Preparation", "Light Housekeeping",
] as const;

export const CARE_NEED_SUBS: Record<string, string[]> = {
  "Mobility Assistance": ["Ambulation", "Transfer Assist"],
  "Dementia / Memory Care": ["Supervision / Safety monitoring", "Memory support", "Redirection / cueing"],
  "Medication Reminders": ["Morning", "Afternoon", "Evening", "Bedtime"],
  "Personal Care": ["Bathing", "Dressing Assistance", "Toileting", "Feeding", "Comb Hair", "Oral Hygiene", "Skin Care", "Physical Activity"],
  "Companionship": [],
  "Transportation": ["Doctor appointments", "Grocery shopping", "Pharmacy visits", "Hairdresser / barber"],
  "Meal Preparation": ["Breakfast", "Lunch", "Snack", "Dinner"],
  "Light Housekeeping": ["Light housekeeping (dusting, vacuuming, mopping)", "Change bed linens", "Change bath towels", "Take out trash"],
};
export const FAV_ACTIVITIES = ["Walk", "Reading", "Cooking", "Gardening", "Watching TV", "Socializing", "Going outside", "Exercise", "Hobbies", "Other"];
export const ENTERTAINMENT = ["Music", "Movies", "TV Shows", "Theater", "Other"];
export const FREQ_OPTIONS = ["Daily", "Weekly", "Monthly", "Occasionally"];
export const PET_TYPES = ["Dog", "Cat", "Fish", "Other"];
export const RELATIONSHIPS = ["Myself", "Parent", "Grandparent", "Spouse", "Sibling", "Other"];
const LEGACY_NAMES: Record<string, string> = { "Personal Care (Bathing & Dressing)": "Personal Care" };

/** The page's fixed care-type pills, matched loosely (case, legacy label). */
export function toCareType(raw: string): string | null {
  const s = LEGACY_NAMES[raw] ?? raw;
  const hit = CARE_TYPES.find((t) => t.toLowerCase() === s.trim().toLowerCase());
  if (hit) return hit;
  const loose = s.trim().toLowerCase();
  if (/dementia|memory/.test(loose)) return "Dementia / Memory Care";
  if (/medication|meds/.test(loose)) return "Medication Reminders";
  if (/meal|cook/.test(loose)) return "Meal Preparation";
  if (/housekeep|clean|laundry/.test(loose)) return "Light Housekeeping";
  if (/mobil|walk|transfer/.test(loose)) return "Mobility Assistance";
  if (/personal|bath|dress|toilet|hygiene/.test(loose)) return "Personal Care";
  if (/companion|social/.test(loose)) return "Companionship";
  if (/transport|driv|errand/.test(loose)) return "Transportation";
  return null;
}

export interface LocationEntry {
  street: string; city: string; state: string; zipCode: string;
  petsInHome?: boolean; petTypes?: string[]; petName?: string; smokingHousehold?: boolean;
  lat?: number; lng?: number;
}
export interface LifestyleData {
  favoriteActivities: string[]; favoriteActivitiesOther: string;
  helpActivities: string[]; helpActivitiesOther: string;
  entertainment: string[]; entertainmentOther: string;
  enjoysConversation: boolean | null; prefersQuiet: boolean | null;
  familyInArea: boolean | null; familyVisitFreq: string;
  friendsVisitors: boolean | null; friendsVisitFreq: string;
  hasAppointments: boolean | null; appointmentsDetails: string;
}
export interface TasksData {
  adls: string[]; medicationReminders: string[]; mealPrep: string[];
  personalCare: string[]; householdTasks: string[]; transportation: string[];
}
export interface RecipientPlanData {
  careNeeds: string[];
  careNeedDetails: Record<string, string[]>;
  locations: LocationEntry[];
  notes: string;
  lifestyle: LifestyleData;
  tasks: TasksData;
}
export interface EmergencyContact { id: string; name: string; relation: string; phone: string; isPrimary: boolean }

export const emptyLifestyle = (): LifestyleData => ({
  favoriteActivities: [], favoriteActivitiesOther: "",
  helpActivities: [], helpActivitiesOther: "",
  entertainment: [], entertainmentOther: "",
  enjoysConversation: null, prefersQuiet: null,
  familyInArea: null, familyVisitFreq: "",
  friendsVisitors: null, friendsVisitFreq: "",
  hasAppointments: null, appointmentsDetails: "",
});
export const emptyTasks = (): TasksData => ({ adls: [], medicationReminders: [], mealPrep: [], personalCare: [], householdTasks: [], transportation: [] });
export const locLabel = (l: Partial<LocationEntry> | undefined): string =>
  l ? [l.street, l.city, [l.state, l.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
export const hasLifestyle = (ls: LifestyleData): boolean =>
  ls.favoriteActivities.length > 0 || ls.helpActivities.length > 0 || ls.entertainment.length > 0 ||
  ls.enjoysConversation !== null || ls.prefersQuiet !== null || ls.familyInArea !== null ||
  ls.friendsVisitors !== null || ls.hasAppointments !== null;
const sameLoc = (a: Partial<LocationEntry>, b: Partial<LocationEntry>) =>
  (a.street ?? "").toLowerCase() === (b.street ?? "").toLowerCase() && (a.zipCode ?? "") === (b.zipCode ?? "");

export interface CarePlanRecipient {
  key: string; firstName: string; lastName: string; name: string;
  relationship: string; age: string; photoURL: string | null; isPrimary: boolean;
  plan: RecipientPlanData;
  locationLabel: string;
  lifestyleSpecified: boolean;
}
export interface CarePlanPage {
  recipients: CarePlanRecipient[];
  locationPool: LocationEntry[];
  emergencyContacts: EmergencyContact[];
  /** The signup-time emergency contact card (job_postings.emergency*), shown alongside the list. */
  setupContact: { firstName: string; lastName: string; phone: string; relationship: string } | null;
  reviewed: boolean;
  options: { careTypes: string[]; subtasks: Record<string, string[]>; favoriteActivities: string[]; entertainment: string[]; frequencies: string[]; petTypes: string[]; relationships: string[] };
}

interface LoadedPage extends CarePlanPage {
  wizard: Record<string, unknown>;
  rawPlans: Record<string, Partial<RecipientPlanData>>;
  wizardLocations: LocationEntry[];
}

// ── Read (the page's loaders + memos) ───────────────────────────────────────
async function load(clientId: string): Promise<LoadedPage> {
  const [jpSnap, cpSnap, legacySnap] = await Promise.all([
    db.collection("job_postings").doc(clientId).get().catch(() => null),
    db.collection("carePlans").doc(clientId).get().catch(() => null),
    db.collection("care_plans").doc(clientId).get().catch(() => null),
  ]);
  const wizard = (jpSnap?.exists ? jpSnap.data() : {}) as Record<string, unknown>;
  const cp = (cpSnap?.exists ? cpSnap.data() : {}) as Record<string, unknown>;

  // recipientPlans, including literal dotted-key writes (the page reads both).
  const rawPlans: Record<string, Partial<RecipientPlanData>> = { ...((cp.recipientPlans as Record<string, Partial<RecipientPlanData>>) ?? {}) };
  for (const k of Object.keys(cp)) {
    if (k.startsWith("recipientPlans.")) { const key = k.slice("recipientPlans.".length); if (!rawPlans[key]) rawPlans[key] = cp[k] as Partial<RecipientPlanData>; }
  }

  // wizardLocations
  const wizardLocations: LocationEntry[] = [];
  if (wizard.street || wizard.city) wizardLocations.push({ street: String(wizard.street ?? ""), city: String(wizard.city ?? ""), state: String(wizard.state ?? ""), zipCode: String(wizard.zipCode ?? "") });
  for (const loc of (wizard.savedLocations as Array<Partial<LocationEntry>> | undefined) ?? []) {
    if (!(loc.street || loc.city)) continue;
    if (wizardLocations.some((l) => sameLoc(l, loc))) continue;
    wizardLocations.push({ street: String(loc.street ?? ""), city: String(loc.city ?? ""), state: String(loc.state ?? ""), zipCode: String(loc.zipCode ?? "") });
  }
  const locationPool = ((cp.locationPool as LocationEntry[] | undefined) ?? []);
  const effectivePool = locationPool.length > 0 ? locationPool : wizardLocations;

  // roster
  const list: Array<Omit<CarePlanRecipient, "plan" | "locationLabel" | "lifestyleSpecified">> = [];
  const seen = new Set<string>();
  const pFirst = String(wizard.careRecipientFirstName ?? "");
  const pLast = String(wizard.careRecipientLastName ?? "");
  if (pFirst) {
    const key = recipientPlanKey(pFirst, pLast);
    seen.add(key);
    list.push({ key, firstName: pFirst, lastName: pLast, name: [pFirst, pLast].filter(Boolean).join(" ") || "Primary Recipient", relationship: String(wizard.relationship ?? ""), age: String(wizard.careRecipientAge ?? ""), photoURL: (wizard.careRecipientPhotoURL as string | undefined) ?? null, isPrimary: true });
    for (const r of (wizard.additionalRecipients as Array<Record<string, unknown>> | undefined) ?? []) {
      const rFirst = String(r.firstName ?? "").trim(); const rLast = String(r.lastName ?? "").trim();
      if (!rFirst) continue;
      const rKey = recipientPlanKey(rFirst, rLast);
      if (seen.has(rKey)) continue;
      seen.add(rKey);
      list.push({ key: rKey, firstName: rFirst, lastName: rLast, name: [rFirst, rLast].filter(Boolean).join(" "), relationship: String(r.relationship ?? ""), age: String(r.age ?? ""), photoURL: (r.photoURL as string | undefined) ?? null, isPrimary: false });
    }
    // Orphaned plans (a plan with no roster row that wasn't deliberately deleted) still show.
    const deletedKeys = new Set(((wizard.deletedRecipients as Array<Record<string, unknown>> | undefined) ?? []).map((d) => recipientPlanKey(String(d.firstName ?? "").trim(), String(d.lastName ?? "").trim())));
    for (const [key, p] of Object.entries(rawPlans)) {
      if (seen.has(key) || deletedKeys.has(key)) continue;
      const storedName = typeof (p as Record<string, unknown>).name === "string" ? String((p as Record<string, unknown>).name).trim() : "";
      const [kFirst, ...kRest] = key.split("_");
      const firstName = storedName ? storedName.split(" ")[0] : kFirst.charAt(0).toUpperCase() + kFirst.slice(1);
      const lastFromKey = kRest.join(" ");
      const lastName = storedName ? storedName.split(" ").slice(1).join(" ") : (lastFromKey === "noname" ? "" : lastFromKey.replace(/\b\w/g, (c) => c.toUpperCase()));
      if (!firstName) continue;
      seen.add(key);
      list.push({ key, firstName, lastName, name: [firstName, lastName].filter(Boolean).join(" "), relationship: typeof (p as Record<string, unknown>).relationship === "string" ? String((p as Record<string, unknown>).relationship) : "", age: typeof (p as Record<string, unknown>).age === "string" ? String((p as Record<string, unknown>).age) : "", photoURL: null, isPrimary: false });
    }
  }

  const getPlan = (key: string): RecipientPlanData => {
    const stored = rawPlans[key];
    const wizardNeeds = (wizard.careNeeds as string[] | undefined) ?? [];
    const wizardNotes = String(wizard.jobDescription ?? "");
    if (stored) {
      return {
        careNeeds: stored.careNeeds ?? wizardNeeds,
        careNeedDetails: stored.careNeedDetails ?? {},
        locations: stored.locations ?? wizardLocations.slice(0, 1),
        notes: stored.notes ?? wizardNotes,
        lifestyle: { ...emptyLifestyle(), ...(stored.lifestyle ?? {}) },
        tasks: { ...emptyTasks(), ...(stored.tasks ?? {}) },
      };
    }
    return { careNeeds: wizardNeeds, careNeedDetails: {}, locations: wizardLocations.slice(0, 1), notes: wizardNotes, lifestyle: emptyLifestyle(), tasks: emptyTasks() };
  };

  const recipients: CarePlanRecipient[] = list.map((r) => {
    const plan = getPlan(r.key);
    return { ...r, plan, locationLabel: locLabel(plan.locations[0]), lifestyleSpecified: hasLifestyle(plan.lifestyle) };
  });

  const legacy = (legacySnap?.exists ? legacySnap.data() : {}) as Record<string, unknown>;
  const emergencyContacts = (Array.isArray(legacy.emergencyContacts) ? legacy.emergencyContacts : []) as EmergencyContact[];
  const setupContact = wizard.emergencyFirstName
    ? { firstName: String(wizard.emergencyFirstName ?? ""), lastName: String(wizard.emergencyLastName ?? ""), phone: String(wizard.emergencyPhone ?? ""), relationship: String(wizard.emergencyRelationship ?? "") }
    : null;

  return {
    recipients, locationPool: effectivePool, emergencyContacts, setupContact,
    reviewed: !!cp.carePlanReviewedAt,
    options: { careTypes: [...CARE_TYPES], subtasks: CARE_NEED_SUBS, favoriteActivities: FAV_ACTIVITIES, entertainment: ENTERTAINMENT, frequencies: FREQ_OPTIONS, petTypes: PET_TYPES, relationships: RELATIONSHIPS },
    wizard, rawPlans, wizardLocations,
  };
}

export async function readCarePlanPage(clientId: string): Promise<CarePlanPage> {
  const { wizard: _w, rawPlans: _r, wizardLocations: _l, ...page } = await load(clientId);
  return page;
}

export type RecipientResolution = { ok: true; recipient: CarePlanRecipient; page: LoadedPage } | { ok: false; reason: "ambiguous" | "none_on_file" | "not_found" };

export async function resolveRecipient(clientId: string, firstName?: string): Promise<RecipientResolution> {
  const page = await load(clientId);
  if (page.recipients.length === 0) return { ok: false, reason: "none_on_file" };
  if (firstName?.trim()) {
    const wanted = firstName.trim().toLowerCase().split(/\s+/)[0];
    const hits = page.recipients.filter((r) => r.firstName.toLowerCase() === wanted);
    if (hits.length === 1) return { ok: true, recipient: hits[0], page };
    if (hits.length > 1) return { ok: false, reason: "ambiguous" };
    return { ok: false, reason: "not_found" };
  }
  if (page.recipients.length === 1) return { ok: true, recipient: page.recipients[0], page };
  return { ok: false, reason: "ambiguous" };
}

// ── saveSection: the whole recipient plan, + senior_profiles.needs mirror ────
export async function savePlanSection(
  clientId: string, recipient: CarePlanRecipient, patch: Partial<RecipientPlanData>, opts?: { locationPool?: LocationEntry[] },
): Promise<RecipientPlanData> {
  const updated: RecipientPlanData = JSON.parse(JSON.stringify({ ...recipient.plan, ...patch }));
  const docRef = db.collection("carePlans").doc(clientId);
  const payload: Record<string, unknown> = { [`recipientPlans.${recipient.key}`]: updated };
  if (opts?.locationPool) payload.locationPool = opts.locationPool;
  try {
    await docRef.update(payload);
  } catch (e) {
    if ((e as { code?: number | string })?.code === 5 || (e as { code?: string })?.code === "not-found") {
      await docRef.set({ recipientPlans: { [recipient.key]: updated }, ...(opts?.locationPool ? { locationPool: opts.locationPool } : {}) });
    } else throw e;
  }
  // senior_profiles.needs is what caregiver matching reads — the page mirrors it on every section save.
  const seniorProfileId = recipient.isPrimary ? clientId : `${clientId}_${recipient.key}`;
  await db.collection("senior_profiles").doc(seniorProfileId)
    .set({ needs: updated.careNeeds ?? [], userId: clientId, clientId }, { merge: true })
    .catch((err) => console.error("senior_profiles needs sync failed (non-fatal):", err));
  return updated;
}

/** Geocode like the page (Nominatim on the full address) and fall back to any coords already on the entry.
 *  The page's address form auto-fills city/state from the zip (lookupZip) — same here when they're missing. */
export async function geocodeLocation(l: LocationEntry): Promise<LocationEntry> {
  const entry: LocationEntry = { street: l.street, city: l.city, state: l.state, zipCode: l.zipCode };
  if ((!entry.city || !entry.state) && entry.zipCode) {
    const place = await lookupZipPlace(entry.zipCode).catch(() => null);
    if (place) { entry.city = entry.city || place.city; entry.state = entry.state || place.state; }
  }
  if (l.petsInHome !== undefined) entry.petsInHome = l.petsInHome;
  if (l.smokingHousehold !== undefined) entry.smokingHousehold = l.smokingHousehold;
  if (l.petTypes?.length) entry.petTypes = l.petTypes;
  if (l.petName) entry.petName = l.petName;
  const coords = await geocodeStreetAddress(l.street, l.city, l.state, l.zipCode).catch(() => null);
  if (coords) { entry.lat = coords.lat; entry.lng = coords.lng; }
  else if (l.lat != null && l.lng != null) { entry.lat = l.lat; entry.lng = l.lng; }
  return entry;
}

/** Care Location section: pick an address from the pool (by label/street) or add a new one to the pool, then set it on the recipient. */
export async function setRecipientLocation(
  clientId: string, recipient: CarePlanRecipient, page: LoadedPage, loc: Partial<LocationEntry>,
): Promise<{ location: LocationEntry; addedToPool: boolean }> {
  if (!loc.street?.trim()) throw new Error("A street address is required for the care location");
  const pool = [...page.locationPool];
  const existing = pool.find((p) => sameLoc(p, loc));
  let entry: LocationEntry;
  let addedToPool = false;
  if (existing) {
    entry = existing;
  } else {
    entry = await geocodeLocation({ street: loc.street.trim(), city: (loc.city ?? "").trim(), state: (loc.state ?? "").trim(), zipCode: (loc.zipCode ?? "").trim(), petsInHome: loc.petsInHome, petTypes: loc.petTypes, petName: loc.petName, smokingHousehold: loc.smokingHousehold });
    pool.push(entry);
    addedToPool = true;
  }
  await savePlanSection(clientId, recipient, { locations: [entry] }, { locationPool: pool });
  return { location: entry, addedToPool };
}

// ── saveNewRecipient ────────────────────────────────────────────────────────
export interface NewRecipientInput {
  firstName: string; lastName?: string; relationship: string; age?: string | number;
  careNeeds?: string[]; careNeedDetails?: Record<string, string[]>; notes?: string;
  location: Partial<LocationEntry>;
}
export type AddRecipientResult =
  | { ok: true; key: string; name: string }
  | { ok: false; message: string };

export async function addRecipient(clientId: string, input: NewRecipientInput): Promise<AddRecipientResult> {
  const firstName = (input.firstName ?? "").trim();
  const lastName = (input.lastName ?? "").trim();
  if (!firstName) return { ok: false, message: "First name is required" };
  if (/[~*/[\]]/.test(firstName) || /[~*/[\]]/.test(lastName)) return { ok: false, message: "Names cannot contain special characters like / * [ ]" };
  const relationship = (input.relationship ?? "").trim();
  if (!relationship) return { ok: false, message: "Please select a relationship" };
  const page = await load(clientId);
  if (relationship.toLowerCase() === "myself" && page.recipients.some((r) => r.relationship.toLowerCase() === "myself")) {
    return { ok: false, message: "You can only add yourself once" };
  }
  if (!input.location?.street?.trim()) return { ok: false, message: "Please select or enter a care location with a street address" };

  const entry = { firstName, lastName, relationship, age: String(input.age ?? "").trim() };
  const jpRef = db.collection("job_postings").doc(clientId);
  const isFirstRecipient = !page.wizard.careRecipientFirstName;
  if (isFirstRecipient) {
    await jpRef.set({ careRecipientFirstName: entry.firstName, careRecipientLastName: entry.lastName, relationship: entry.relationship, careRecipientAge: entry.age }, { merge: true });
  } else {
    await jpRef.set({ additionalRecipients: FV.arrayUnion(entry) }, { merge: true });
  }

  const key = recipientPlanKey(entry.firstName, entry.lastName);
  const careNeeds = (input.careNeeds ?? []).map(toCareType).filter((v): v is string => !!v);
  const careNeedDetails: Record<string, string[]> = {};
  for (const [need, subs] of Object.entries(input.careNeedDetails ?? {})) {
    const n = toCareType(need); if (!n || !careNeeds.includes(n)) continue;
    careNeedDetails[n] = (subs ?? []).filter((s) => (CARE_NEED_SUBS[n] ?? []).includes(s));
  }
  // Merge the address into the shared locationPool (geocoded), like the page.
  const currentPool = [...page.locationPool];
  let location = currentPool.find((l) => sameLoc(l, input.location));
  let updatedPool = currentPool;
  if (!location) {
    location = await geocodeLocation({ street: input.location.street!.trim(), city: (input.location.city ?? "").trim(), state: (input.location.state ?? "").trim(), zipCode: (input.location.zipCode ?? "").trim() });
    updatedPool = [...currentPool, location];
  }
  const blankPlan: RecipientPlanData = { careNeeds, careNeedDetails, locations: [location], notes: (input.notes ?? "").trim(), lifestyle: emptyLifestyle(), tasks: emptyTasks() };
  const cpRef = db.collection("carePlans").doc(clientId);
  const cpPayload: Record<string, unknown> = { [`recipientPlans.${key}`]: blankPlan };
  if (updatedPool !== currentPool) cpPayload.locationPool = updatedPool;
  try {
    await cpRef.update(cpPayload);
  } catch (e) {
    if ((e as { code?: number | string })?.code === 5 || (e as { code?: string })?.code === "not-found") {
      await cpRef.set({ recipientPlans: { [key]: blankPlan }, ...(updatedPool !== currentPool ? { locationPool: updatedPool } : {}) });
    } else throw e;
  }
  if (careNeeds.length > 0) {
    const seniorProfileId = isFirstRecipient ? clientId : `${clientId}_${key}`;
    await db.collection("senior_profiles").doc(seniorProfileId).set({ needs: careNeeds, userId: clientId, clientId }, { merge: true }).catch(() => {});
  }
  return { ok: true, key, name: [firstName, lastName].filter(Boolean).join(" ") };
}

// ── deleteRecipient ─────────────────────────────────────────────────────────
export type RemoveRecipientResult = { ok: true; removed: string } | { ok: false; code: "NOT_FOUND" | "INVALID_INPUT"; message: string };

export async function removeRecipient(clientId: string, firstName: string): Promise<RemoveRecipientResult> {
  const page = await load(clientId);
  if (!page.wizard.careRecipientFirstName) return { ok: false, code: "NOT_FOUND", message: "No care recipients on file for this household." };
  const wanted = firstName.trim().toLowerCase();
  const matches = page.recipients.filter((r) => r.firstName.toLowerCase() === wanted);
  if (matches.length === 0) return { ok: false, code: "NOT_FOUND", message: `No care recipient named "${firstName}" on file.` };
  if (matches.length > 1) return { ok: false, code: "INVALID_INPUT", message: `More than one care recipient named "${firstName}" — this needs to be done on the website.` };
  if (page.recipients.length === 1) return { ok: false, code: "INVALID_INPUT", message: "Can't remove the only care recipient on the household." };
  const r = matches[0];
  const archived = { firstName: r.firstName, lastName: r.lastName, relationship: r.relationship, age: r.age || "", deletedAt: new Date().toISOString() };

  // Preserve the deleted recipient's locations in the shared pool (the page does).
  const recipientLocs = (page.rawPlans[r.key]?.locations ?? []).filter((l) => l.street || l.city);
  if (recipientLocs.length > 0) {
    const currentPool = [...page.locationPool];
    const toAdd = recipientLocs.filter((l) => !currentPool.some((p) => sameLoc(p, l)));
    if (toAdd.length > 0) await db.collection("carePlans").doc(clientId).set({ locationPool: [...currentPool, ...toAdd] }, { merge: true });
  }

  const jpRef = db.collection("job_postings").doc(clientId);
  const additionals = ((page.wizard.additionalRecipients as Array<Record<string, unknown>> | undefined) ?? []);
  if (r.isPrimary) {
    const [next, ...remaining] = additionals;
    if (next) {
      await jpRef.update({
        careRecipientFirstName: next.firstName, careRecipientLastName: next.lastName ?? "", relationship: next.relationship ?? "", careRecipientAge: next.age ?? "",
        additionalRecipients: remaining, deletedRecipients: FV.arrayUnion(archived),
      });
    } else {
      await jpRef.update({
        careRecipientFirstName: FV.delete(), careRecipientLastName: FV.delete(), relationship: FV.delete(), careRecipientAge: FV.delete(),
        deletedRecipients: FV.arrayUnion(archived),
      });
    }
  } else {
    const updatedAdditional = additionals.filter((ar) => !(String(ar.firstName ?? "") === r.firstName && String(ar.lastName ?? "") === r.lastName));
    await jpRef.update({ additionalRecipients: updatedAdditional, deletedRecipients: FV.arrayUnion(archived) });
  }
  return { ok: true, removed: r.name };
}

// ── Emergency Contacts (dbService.updateCarePlan) + "Looks good" ────────────
export async function saveEmergencyContacts(clientId: string, contacts: EmergencyContact[]): Promise<void> {
  await db.collection("care_plans").doc(clientId).set({ emergencyContacts: contacts, lastUpdatedBy: "web", updatedAt: new Date().toISOString() }, { merge: true });
}

export async function confirmCarePlanReviewed(clientId: string): Promise<{ migratedWizardContact: boolean }> {
  const cpRef = db.collection("carePlans").doc(clientId);
  const [cpSnap, jpSnap] = await Promise.all([cpRef.get(), db.collection("job_postings").doc(clientId).get().catch(() => null)]);
  const wizard = (jpSnap?.exists ? jpSnap.data() : {}) as Record<string, unknown>;
  const update: Record<string, unknown> = { carePlanReviewedAt: FV.serverTimestamp() };
  const existing = (cpSnap.data()?.emergencyContacts as unknown[] | undefined) ?? [];
  let migrated = false;
  if (existing.length === 0 && wizard.emergencyFirstName) {
    update.emergencyContacts = [{
      id: "wizard",
      name: [wizard.emergencyFirstName, wizard.emergencyLastName].filter(Boolean).join(" "),
      relation: String(wizard.emergencyRelationship ?? ""), phone: String(wizard.emergencyPhone ?? ""), isPrimary: true,
    }];
    migrated = true;
  }
  await cpRef.set(update, { merge: true });
  return { migratedWizardContact: migrated };
}
