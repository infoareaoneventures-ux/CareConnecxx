// agents/caregiverMyProfile.ts — the caregiver's OWN profile page
// (components/CaregiverProfile.tsx, /caregiver/profile) over text.
//
// Same reads as the page: dbService.getUser (users + caregivers, caregiver doc
// wins) and the reviews subscription (reviews where caregiverId ==). Same
// sections in the same order — hero (photo, background check complete/pending, name, stars,
// city, rate, Transportation chip), About (bio + languages), Care Services,
// Rates (1 / 2 / 3+ people, experience, max clients), Weekly Availability
// (Looking for + the grid), Location & Travel, Reviews — and every Edit button
// is a keyword that starts the matching flow in caregiverProfileHandler.ts,
// ending in the page's own write (dbService.updateUser('caregivers', uid, …)
// = a merge on caregivers/{uid} with the same field names).
//
// Keywords = the page's buttons:
//   PROFILE / MY PROFILE          the page
//   PHOTO                         the avatar upload (tokened /upload/photo, writes `photo`)
//   BIO · LANGUAGES               About › Edit (bio / languages)
//   SERVICES                      Care Services › Edit
//   RATES                         Rates › Edit (all six fields, one save)
//   LOOKING FOR · AVAILABILITY    Weekly Availability › Edit (jobTypes / the grid = the Calendar modal flow)
//   TRAVEL                        Location & Travel › Edit (serviceRadius; the address is Account Settings)
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { serviceLabel, normalizeCareKinds, serviceListsForKinds, CARE_KIND_LABEL } from "./caregiverServiceLabels";
import { hasValidTransportDocs } from "./caregiverMatchScoring";
import { gridFromWeekly, gridText, DAY_KEYS, type Grid } from "./caregiverAvailabilityGrid";
import { formatExperience } from "./caregiverProfilePage";

const db = admin.firestore();

// ── The page's own option lists (parity-tested against the site files) ──────
/** CaregiverProfile.tsx LANGUAGES — the About section's language pills. */
export const LANGUAGE_OPTIONS: readonly string[] = ["English", "Spanish", "French", "Mandarin", "Vietnamese", "Tagalog"];
/** signup/constants.ts JOB_TYPES — the "Looking for" pills (single choice). */
export const JOB_TYPE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "occasional", label: "Occasional" },
  { id: "part-time", label: "Part-time" },
  { id: "full-time", label: "Full-time" },
];
/** signup/constants.ts MAX_CLIENTS_OPTIONS — Rates › "Max clients at once" (defined in the onboardingContract leaf; the record mirror reads it too). */
export { MAX_CLIENTS_OPTIONS } from "./onboardingContract";
/** The Location & Travel pills, in miles. */
export const TRAVEL_OPTIONS: readonly number[] = [5, 10, 15, 25, 50];

export function jobTypeLabel(id: string): string {
  return JOB_TYPE_OPTIONS.find((j) => j.id === id)?.label ?? id;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : 0; };

export interface MyProfileReview { clientName: string; rating: number; comment: string; date: string | null }

export interface MyProfilePage {
  name: string;
  verified: boolean;
  hasPhoto: boolean;
  ratingLabel: string;              // "4.8 (3 reviews)" or "No reviews yet"
  location: string;                 // "san jose, CA" — from Account Settings, never typed here
  hourlyRate: number;
  hasTransportation: boolean;       // the hero chip = hasValidTransportDocs
  bio: string;
  languages: string[];
  services: string[];               // stored values (labels applied at render)
  careKinds: string[];              // child care (2026-10-18): senior / child / both — missing = senior
  rates: Array<{ label: "1 Person" | "2 People" | "3+ People"; rate: number }>;
  experience: string;               // the bucket string as stored
  maxClients: string;
  jobTypes: string[];               // hyphenated ids
  grid: Grid;
  hasAvailability: boolean;
  serviceRadius: number;
  reviews: {
    count: number;
    overallAvg: number | null;
    recommendPct: number | null;
    categories: Array<{ label: string; avg: number }>;
    items: MyProfileReview[];
  };
}

const CATEGORY_LABELS: Record<string, string> = { punctuality: "Punctuality", professionalism: "Professionalism", communication: "Communication", careQuality: "Quality of Care" };

function reviewDate(v: unknown): string | null {
  if (typeof v === "string" && v) return v.slice(0, 10);
  const t = v as { toDate?: () => Date } | undefined;
  if (t && typeof t.toDate === "function") return t.toDate().toISOString().slice(0, 10);
  return null;
}

/** The page's reads: dbService.getUser (caregiver doc wins) + reviews where caregiverId ==. */
export async function loadMyProfilePage(caregiverId: string): Promise<MyProfilePage> {
  const [cgSnap, userSnap, reviewsSnap] = await Promise.all([
    db.collection("caregivers").doc(caregiverId).get(),
    db.collection("users").doc(caregiverId).get(),
    db.collection("reviews").where("caregiverId", "==", caregiverId).get().catch(() => null),
  ]);
  const p = { ...((userSnap.data() ?? {}) as Record<string, unknown>), ...((cgSnap.data() ?? {}) as Record<string, unknown>) };
  const reviewsRaw = (reviewsSnap?.docs ?? []).map((d) => d.data() as Record<string, unknown>);
  const items: MyProfileReview[] = reviewsRaw
    .map((r) => ({ clientName: str(r.clientName) || "Family", rating: num(r.rating), comment: str(r.comment) || str(r.feedback), date: reviewDate(r.date ?? r.createdAt) }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const count = items.length;
  const overallAvg = count ? items.reduce((s, r) => s + r.rating, 0) / count : null;
  const withAnswer = reviewsRaw.filter((r) => typeof r.wouldRecommend === "boolean");
  const recommendPct = withAnswer.length ? Math.round((withAnswer.filter((r) => r.wouldRecommend === true).length / withAnswer.length) * 100) : null;
  const categories = Object.entries(CATEGORY_LABELS).map(([key, label]) => {
    const vals = reviewsRaw.map((r) => num((r.categories as Record<string, unknown> | undefined)?.[key])).filter((v) => v > 0);
    return vals.length ? { label, avg: vals.reduce((a, b) => a + b, 0) / vals.length } : null;
  }).filter((c): c is { label: string; avg: number } => c !== null);

  const services = (Array.isArray(p.services) && (p.services as unknown[]).length ? p.services : Array.isArray(p.skills) ? p.skills : []) as string[]; // services when non-empty, else skills (one rule with the site)
  const city = str(p.city); const state = str(p.state);
  const location = city && state ? `${city}, ${state}` : city || str(p.location);
  const hourlyRate = num(p.hourlyRate);
  const rate2 = num(p.rateFor2Seniors) || num(p.rateForTwo);
  const rate3 = num(p.rateFor3PlusSeniors) || num(p.rateForThree);
  const rates = ([
    { label: "1 Person" as const, rate: hourlyRate },
    { label: "2 People" as const, rate: rate2 },
    { label: "3+ People" as const, rate: rate3 },
  ]).filter((r) => r.rate > 0);
  const grid = gridFromWeekly(p.weeklyAvailability);
  const hasAvailability = DAY_KEYS.some((d) => (grid[d] ?? []).length > 0);
  return {
    name: str(p.name) || [str(p.firstName), str(p.lastName)].filter(Boolean).join(" "),
    verified: p.verified === true,
    hasPhoto: !!(str(p.photo) || str(p.imageUrl) || str(p.profilePhoto) || str(p.photoURL)),
    ratingLabel: count ? `${(overallAvg as number).toFixed(1)} (${count} ${count === 1 ? "review" : "reviews"})` : "No reviews yet",
    location,
    hourlyRate,
    hasTransportation: hasValidTransportDocs(p),
    bio: str(p.bio),
    languages: Array.isArray(p.languages) && p.languages.length ? (p.languages as string[]) : ["English"],
    services,
    careKinds: normalizeCareKinds(p.careKinds),
    rates,
    experience: str(p.yearsExperience) || str(p.experience),
    maxClients: str(p.maxClients) || "1",
    jobTypes: Array.isArray(p.jobTypes) ? (p.jobTypes as string[]) : [],
    grid,
    hasAvailability,
    serviceRadius: num(p.serviceRadius) || 10,
    reviews: { count, overallAvg, recommendPct, categories, items },
  };
}

/** The page as text, section by section, each Edit as its keyword. */
export function myProfileText(page: MyProfilePage): string {
  const first = page.name.split(" ")[0] || "you";
  const lines: string[] = ["My Profile", ""];
  lines.push(`${page.name || "—"} · ${page.verified ? "Background check complete" : "Background check pending"}`);
  lines.push(page.ratingLabel);
  // No Transportation chip in the hero line (2026-10-06): it is a service, listed under Care Services once live.
  lines.push([page.location, page.hourlyRate > 0 ? `$${page.hourlyRate}/hr` : ""].filter(Boolean).join(" · ") || "—");
  lines.push(page.hasPhoto ? "Photo: on file (reply PHOTO to change it)" : "Photo: none yet (reply PHOTO to add one)");

  lines.push("", `About ${first}`);
  lines.push(page.bio || "Add a bio to introduce yourself to families.");
  lines.push(`Languages: ${page.languages.join(", ")}`);
  lines.push("Reply BIO to edit your bio, or LANGUAGES to change your languages.");

  lines.push("", "Care Services");
  if (page.careKinds.length === 2) {
    // Both lists, each under its own name — the editor shows them the same way.
    for (const l of serviceListsForKinds(page.careKinds)) {
      const mine = (l.services as readonly string[]).filter((s) => page.services.includes(s)); // the editor's order; Transportation under both
      lines.push(`${CARE_KIND_LABEL[l.kind]}: ${mine.length ? mine.map(serviceLabel).join(", ") : "none yet"}`);
    }
  } else {
    lines.push(page.services.length ? page.services.map(serviceLabel).join(", ") : "No services added yet.");
  }
  lines.push("Reply SERVICES to add or remove one.");

  lines.push("", "Rates");
  if (page.rates.length) for (const r of page.rates) lines.push(`${r.label}: $${r.rate}/hr`);
  else lines.push("No rate set yet.");
  const exp = formatExperience(page.experience);
  const max = page.maxClients;
  lines.push([exp, max ? `Up to ${max} client${max !== "1" ? "s" : ""} at once` : ""].filter(Boolean).join(" · ") || "—");
  lines.push("Reply RATES to edit your rates, experience or max clients.");

  lines.push("", "Weekly Availability");
  lines.push(`Looking for: ${page.jobTypes.length ? page.jobTypes.map(jobTypeLabel).join(", ") : "No job types selected."}`);
  lines.push(page.hasAvailability ? gridText(page.grid) : "No availability set yet.");
  lines.push("Reply LOOKING FOR to change the job type, or AVAILABILITY to edit the schedule.");

  lines.push("", "Location & Travel");
  lines.push(page.location ? `Lives in ${page.location}` : "Add your address in Account Settings (reply SETTINGS).");
  lines.push(`Willing to travel within ${page.serviceRadius} miles`);
  lines.push("Reply TRAVEL to change the distance.");

  lines.push("", "Reviews");
  const rv = page.reviews;
  if (rv.count === 0) {
    lines.push("No reviews yet", "Reviews from families will appear here after completed jobs.");
  } else {
    lines.push(`${(rv.overallAvg as number).toFixed(1)} overall (${rv.count} ${rv.count === 1 ? "review" : "reviews"})`);
    if (rv.recommendPct !== null) lines.push(`${rv.recommendPct}% of clients would recommend`);
    for (const c of rv.categories) lines.push(`${c.label}: ${c.avg.toFixed(1)}`);
    for (const r of rv.items.slice(0, 3)) lines.push(`${r.clientName} · ${r.rating}★${r.comment ? ` · "${r.comment}"` : ""}${r.date ? ` · ${r.date}` : ""}`);
    if (rv.items.length > 3) lines.push(`+${rv.items.length - 3} more on the page`);
  }
  return lines.join("\n");
}

export async function sendMyProfile(chatId: string, caregiverId: string): Promise<{ sent: true; verified: boolean; reviewCount: number }> {
  const page = await loadMyProfilePage(caregiverId);
  await sendMessage(chatId, myProfileText(page));
  return { sent: true, verified: page.verified, reviewCount: page.reviews.count };
}

export type MyProfileEdit = "photo" | "bio" | "languages" | "services" | "rates" | "jobtype" | "availability" | "travel";

/** The page's Edit buttons as keywords → the matching flow (caregiverProfileHandler.ts / availabilityHandler.ts). */
export async function startMyProfileEdit(edit: MyProfileEdit, phone: string, chatId: string, caregiverId: string, session: Record<string, unknown>): Promise<void> {
  if (edit === "availability") {
    const { handleAvailabilityUpdate } = await import("./availabilityHandler");
    await handleAvailabilityUpdate(caregiverId, phone, "", { ...session, availabilityStep: "start" }, (msg: string) => sendMessage(chatId, msg));
    return;
  }
  const { startProfileFlow } = await import("./caregiverProfileHandler");
  await startProfileFlow(edit === "services" ? "skills" : edit, caregiverId, phone, chatId, session);
}

const KEYWORD_EDITS: Record<string, MyProfileEdit> = {
  "PHOTO": "photo", "CHANGE PHOTO": "photo", "MY PHOTO": "photo", "UPLOAD PHOTO": "photo",
  "BIO": "bio", "EDIT BIO": "bio", "MY BIO": "bio", "ABOUT": "bio",
  "LANGUAGES": "languages", "MY LANGUAGES": "languages", "LANGUAGE": "languages",
  "SERVICES": "services", "MY SERVICES": "services", "EDIT SERVICES": "services", "CARE SERVICES": "services",
  "RATES": "rates", "MY RATES": "rates", "EDIT RATES": "rates", "RATE": "rates", "MY RATE": "rates",
  "LOOKING FOR": "jobtype", "JOB TYPE": "jobtype",
  // (SCHEDULE / MY SCHEDULE show the Calendar — the page's schedule view — in routeCaregiver, not this editor; sweep C20 2026-10-11.)
  "AVAILABILITY": "availability", "MY AVAILABILITY": "availability", "EDIT AVAILABILITY": "availability",
  "TRAVEL": "travel", "TRAVEL DISTANCE": "travel", "MY TRAVEL": "travel",
};

export async function handleMyProfileKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const upper = text.trim().toUpperCase().replace(/\s+/g, " ");
  if (["PROFILE", "MY PROFILE", "VIEW PROFILE", "SHOW PROFILE", "SHOW MY PROFILE"].includes(upper)) { await sendMyProfile(chatId, caregiverId); return "handled"; }
  const edit = KEYWORD_EDITS[upper];
  if (edit) { await startMyProfileEdit(edit, phone, chatId, caregiverId, session); return "handled"; }
  return "passthrough";
}

