// The website's caregiver profile page (components/ClientCaregiverProfile.tsx,
// /client/caregiver/{id}) as data — the same two records the page merges
// (users/{id} over publicCaregiverProfiles/{id}), the same field fallbacks
// (mapRawToProfile), the same sections in the same order, the same billed
// rates, and the same family-relative buttons (Active Booking / Re-book /
// Interview Requested / Request Interview, Message, Leave a Review).
// Built 2026-09-19 (profile page parity). Replaced the old get_caregiver_info
// body, which read the raw `caregivers` doc the site never shows a family.
import * as admin from "firebase-admin";
import { hasValidTransportDocs } from "./caregiverMatchScoring";
import { SHIFT_PLATFORM_FEE_RATE } from "../billing/config";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();

// ── Weekly availability blocks (services/availabilityService.ts weeklySlotsToBl) ──
export const BLOCK_ORDER = ["morning", "afternoon", "evening", "overnight"] as const;
export type AvailabilityBlock = (typeof BLOCK_ORDER)[number];
/** The page's table labels (components/caregiver/signup/constants.ts TIME_BLOCKS). */
export const BLOCK_LABELS: Record<AvailabilityBlock, string> = {
  morning: "Morning (6am - 12pm)",
  afternoon: "Afternoon (12pm - 6pm)",
  evening: "Evening (6pm - 12am)",
  overnight: "Overnight (12am - 6am)",
};
export const DAY_ORDER = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const BLOCK_MINS: Record<AvailabilityBlock, { s: number; e: number }> = {
  morning: { s: 360, e: 720 },
  afternoon: { s: 720, e: 1080 },
  evening: { s: 1080, e: 1380 },
  overnight: { s: 1380, e: 1440 },
};

function timeToMinutes(time: string): number {
  const [h, m] = String(time).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Block IDs or {start,end} slots per day → the block IDs lit on the page's grid. Ported verbatim. */
export function weeklySlotsToBlocks(weekly: unknown): Record<string, AvailabilityBlock[]> {
  const result: Record<string, AvailabilityBlock[]> = {};
  if (!weekly || typeof weekly !== "object") return result;
  for (const [day, slots] of Object.entries(weekly as Record<string, unknown>)) {
    if (!Array.isArray(slots)) continue;
    const active = new Set<AvailabilityBlock>();
    for (const slot of slots) {
      if (typeof slot === "string") {
        if ((BLOCK_ORDER as readonly string[]).includes(slot)) active.add(slot as AvailabilityBlock);
      } else if (slot && typeof slot === "object") {
        const sl = slot as { start?: string; end?: string };
        if (!sl.start || !sl.end) continue;
        const s = timeToMinutes(sl.start);
        const eRaw = timeToMinutes(sl.end);
        const e = eRaw <= s ? eRaw + 1440 : eRaw; // crosses midnight
        for (const b of BLOCK_ORDER) {
          const r = BLOCK_MINS[b];
          if (s < r.e && e > r.s) active.add(b);
        }
      }
    }
    result[day] = BLOCK_ORDER.filter((b) => active.has(b));
  }
  return result;
}

// ── The page's record (mapRawToProfile) ─────────────────────────────────────
export interface CaregiverProfileRecord {
  id: string;
  firstName: string;
  lastName: string;
  photo: string | null;
  rating: number;
  reviewCount: number;
  hourlyRate: number;
  rateFor2Seniors: number | null;
  rateFor3Seniors: number | null;
  city: string;
  experience: string;
  bio: string;
  languages: string[];
  skills: string[];
  education: string | null;
  verified: boolean;
  backgroundCheckStatus: string | null;
  hasTransportation: boolean;
  serviceRadius: number;
  weeklyAvailability: Record<string, AvailabilityBlock[]>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : null);

/** Same fallback chain as the page, field for field. */
export function mapRawToProfileRecord(id: string, data: Record<string, unknown>): CaregiverProfileRecord {
  const nameParts = typeof data.name === "string" ? data.name.trim().split(" ") : [];
  const firstName = str(data.firstName) || nameParts[0] || "Caregiver";
  const lastName = str(data.lastName) || nameParts.slice(1).join(" ") || "";
  const rating = num(data.rating);
  return {
    id,
    firstName,
    lastName,
    photo: str(data.photoURL) || str(data.photo) || str(data.imageUrl) || str(data.profilePhoto),
    rating: rating ?? 5.0,
    reviewCount: num(data.reviewCount) ?? num(data.totalReviews) ?? 0,
    hourlyRate: num(data.hourlyRate) ?? 25,
    rateFor2Seniors: num(data.rateFor2Seniors) || num(data.rateForTwo),
    rateFor3Seniors: num(data.rateFor3PlusSeniors) || num(data.rateFor3Seniors) || num(data.rateForThree),
    city: str(data.city) || str(data.location) || "Nearby",
    experience: (data.yearsExperience ? String(data.yearsExperience) : "") || (data.experience ? String(data.experience) : ""),
    bio: str(data.bio) || str(data.about) || "",
    languages: strList(data.languages) ?? ["English"],
    skills: strList(data.skills) || strList(data.services) || strList(data.specializations) || [],
    education: str(data.education),
    verified: data.verified === true,
    backgroundCheckStatus: str(data.backgroundCheckStatus),
    hasTransportation: hasValidTransportDocs(data),
    serviceRadius: num(data.serviceRadius) ?? 25,
    weeklyAvailability: weeklySlotsToBlocks(data.weeklyAvailability || {}),
  };
}

// ── The page as the family sees it ──────────────────────────────────────────
export interface ProfileReview {
  reviewerName: string;
  rating: number;
  comment: string;
  dateIso: string;
  wouldRecommend: boolean | null;
}

/** What this family has done with this caregiver — decides the page's buttons. */
export interface CaregiverRelationship {
  isBooked: boolean;
  hasPastBooking: boolean;
  hasCompletedInterview: boolean;
  isRequested: boolean;
  hasCompletedShift: boolean;
  hasReviewed: boolean;
}
export const NO_RELATIONSHIP: CaregiverRelationship = {
  isBooked: false, hasPastBooking: false, hasCompletedInterview: false, isRequested: false, hasCompletedShift: false, hasReviewed: false,
};

export type ProfilePrimaryAction = "active_booking" | "rebook" | "interview_requested" | "request_interview";
export type ProfileReviewAction = "leave_review" | "reviewed" | null;

export interface CaregiverProfilePage {
  id: string;
  name: string;
  firstName: string;
  photo: string | null;
  /** /p/{id} — the shareable profile the site texts from search. */
  profileUrl: string;
  /** Header: "4.7 (12 reviews)" or "No reviews yet" — the page hides the number with zero reviews. */
  rating: number | null;
  reviewCount: number;
  ratingLabel: string;
  badges: { verified: boolean; backgroundCheckStatus: string | null; transportation: boolean };
  city: string;
  /** The header's rate line ("$25/hr · $27.25/hr billed"): caregiver rate + what the family is billed per hour (rate + 9%, no minimum per hour). */
  hourlyRate: number;
  billedHourlyRate: number;
  rateLine: string;
  about: { bio: string | null; languages: string[] };
  /** Care Services chips — Transportation only once the badge is earned, as on the page. */
  careServices: string[];
  rates: Array<{ label: "1 Person" | "2 People" | "3+ People"; rate: number; billed: number }>;
  ratesNote: string;
  experience: string | null;
  /** Weekly Availability grid, only days with a lit block; omitted section when empty (the page hides it). */
  weeklyAvailability: Array<{ day: string; blocks: AvailabilityBlock[] }>;
  background: string | null;
  location: { city: string; serviceRadiusMiles: number };
  reviews: ProfileReview[];
  hasMoreReviews: boolean;
  relationship: CaregiverRelationship;
  /** The page's buttons in this state: one primary (or a status pill), Message, and the review action. */
  actions: { primary: ProfilePrimaryAction; message: true; review: ProfileReviewAction };
  /** publicCaregiverProfiles/{id} exists — i.e. the caregiver is listed on the site. false = only a users record (never quote rate/skills as facts). */
  published: boolean;
  /** One paragraph in the page's order, for Evia to quote from. */
  summary: string;
}

export function billedHourly(rate: number): number {
  return Math.round((Number(rate) || 0) * (1 + SHIFT_PLATFORM_FEE_RATE) * 100) / 100;
}

export function deriveProfileActions(rel: CaregiverRelationship): CaregiverProfilePage["actions"] {
  const primary: ProfilePrimaryAction = rel.isBooked
    ? "active_booking"
    : rel.hasPastBooking && rel.hasCompletedInterview
      ? "rebook"
      : rel.isRequested
        ? "interview_requested"
        : "request_interview";
  const review: ProfileReviewAction = rel.hasCompletedShift && !rel.hasReviewed ? "leave_review" : rel.hasReviewed ? "reviewed" : null;
  return { primary, message: true, review };
}

const PRIMARY_LABEL: Record<ProfilePrimaryAction, string> = {
  active_booking: "Active Booking (you have a live shift with them)",
  rebook: "Re-book",
  interview_requested: "Interview Requested (waiting on them)",
  request_interview: "Request Interview",
};

const DAY_LABEL = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
const money = (n: number) => `$${n.toFixed(2)}`;
const pct = `${Math.round(SHIFT_PLATFORM_FEE_RATE * 100)}%`;

export function shapeCaregiverProfilePage(
  rec: CaregiverProfileRecord,
  reviews: ProfileReview[],
  rel: CaregiverRelationship,
  opts: { hasMoreReviews?: boolean; appUrl?: string; published?: boolean } = {},
): CaregiverProfilePage {
  const name = `${rec.firstName} ${rec.lastName}`.trim();
  const ratingLabel = rec.reviewCount > 0
    ? `${rec.rating.toFixed(1)} (${rec.reviewCount} review${rec.reviewCount !== 1 ? "s" : ""})`
    : "No reviews yet";
  const billed = billedHourly(rec.hourlyRate);
  const rates: CaregiverProfilePage["rates"] = ([
    { label: "1 Person" as const, rate: rec.hourlyRate },
    { label: "2 People" as const, rate: rec.rateFor2Seniors },
    { label: "3+ People" as const, rate: rec.rateFor3Seniors },
  ]).filter((r): r is { label: "1 Person" | "2 People" | "3+ People"; rate: number } => !!r.rate && Number(r.rate) > 0)
    .map((r) => ({ label: r.label, rate: r.rate, billed: billedHourly(r.rate) }));
  const careServices = rec.skills.filter((s) => s !== "Transportation" || rec.hasTransportation);
  const weeklyAvailability = DAY_ORDER
    .map((day) => ({ day, blocks: rec.weeklyAvailability[day] ?? [] }))
    .filter((d) => d.blocks.length > 0);
  const actions = deriveProfileActions(rel);
  const ratesNote = `Billed includes Evia's ${pct} service fee. The caregiver keeps 100% of their rate.`;

  const parts: string[] = [];
  parts.push(`${name} — ${ratingLabel}.`);
  const badgeBits = [rec.verified ? "verified" : null, rec.backgroundCheckStatus ? `background check ${rec.backgroundCheckStatus}` : null, rec.hasTransportation ? "Transportation badge" : null].filter(Boolean);
  if (badgeBits.length) parts.push(`Badges: ${badgeBits.join(", ")}.`);
  parts.push(`${rec.city}. ${rec.hourlyRate > 0 ? `$${rec.hourlyRate}/hr (${money(billed)}/hr billed).` : "No hourly rate on file."}`);
  parts.push(`About: ${rec.bio || "No bio yet."} Languages: ${rec.languages.join(", ")}.`);
  if (careServices.length) parts.push(`Care services: ${careServices.join(", ")}.`);
  if (rates.length) parts.push(`Rates: ${rates.map((r) => `${r.label} $${r.rate}/hr (${money(r.billed)} billed)`).join("; ")}. ${ratesNote}`);
  if (rec.experience) parts.push(`${rec.experience} experience.`);
  if (weeklyAvailability.length) parts.push(`Weekly availability: ${weeklyAvailability.map((d) => `${DAY_LABEL(d.day)} ${d.blocks.join("/")}`).join("; ")}.`);
  if (rec.education) parts.push(`Background: ${rec.education}.`);
  parts.push(`Lives in ${rec.city}; willing to travel within ${rec.serviceRadius} miles.`);
  parts.push(reviews.length
    ? `Reviews (${rec.reviewCount}): ${reviews.slice(0, 3).map((r) => `${r.reviewerName} ${r.rating}★${r.comment ? ` "${r.comment}"` : ""}`).join(" · ")}`
    : "Reviews: none yet.");
  parts.push(`Buttons on the page for this family: ${PRIMARY_LABEL[actions.primary]}; Message${actions.review === "leave_review" ? "; Leave a Review" : actions.review === "reviewed" ? "; Reviewed ✓" : ""}.`);

  return {
    id: rec.id,
    name,
    firstName: rec.firstName,
    photo: rec.photo,
    profileUrl: `${opts.appUrl ?? getAppUrl()}/p/${rec.id}`,
    rating: rec.reviewCount > 0 ? rec.rating : null,
    reviewCount: rec.reviewCount,
    ratingLabel,
    badges: { verified: rec.verified, backgroundCheckStatus: rec.backgroundCheckStatus, transportation: rec.hasTransportation },
    city: rec.city,
    hourlyRate: rec.hourlyRate,
    billedHourlyRate: billed,
    rateLine: rec.hourlyRate > 0 ? `$${rec.hourlyRate}/hr · ${money(billed)}/hr billed` : "",
    about: { bio: rec.bio || null, languages: rec.languages },
    careServices,
    rates,
    ratesNote,
    experience: rec.experience || null,
    weeklyAvailability,
    background: rec.education,
    location: { city: rec.city, serviceRadiusMiles: rec.serviceRadius },
    reviews,
    hasMoreReviews: opts.hasMoreReviews ?? false,
    published: opts.published ?? true,
    relationship: rel,
    actions,
    summary: parts.join(" "),
  };
}

// ── Reads (the page's own queries) ───────────────────────────────────────────
function mapReview(r: Record<string, unknown>): ProfileReview {
  const created = r.date ?? r.createdAt;
  const dateIso = typeof created === "string"
    ? created
    : created && typeof (created as { toDate?: () => Date }).toDate === "function"
      ? (created as { toDate: () => Date }).toDate().toISOString()
      : new Date().toISOString();
  return {
    reviewerName: str(r.clientName) || "A client",
    rating: num(r.rating) || 5,
    comment: str(r.comment) || str(r.feedback) || "",
    dateIso,
    wouldRecommend: typeof r.wouldRecommend === "boolean" ? r.wouldRecommend : null,
  };
}

/** The page's six relationship queries, run as the family (clientId). */
export async function readCaregiverRelationship(clientId: string, caregiverId: string): Promise<CaregiverRelationship> {
  const rel: CaregiverRelationship = { ...NO_RELATIONSHIP };
  const [bookings, interviews, completedShift, ownReview] = await Promise.all([
    db.collection("booking_requests").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).where("status", "==", "accepted").get().catch(() => null),
    db.collection("video_interviews").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).get().catch(() => null),
    db.collection("shifts").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).where("status", "==", "completed").limit(1).get().catch(() => null),
    db.collection("reviews").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).limit(1).get().catch(() => null),
  ]);
  if (bookings && !bookings.empty) {
    rel.hasPastBooking = true;
    const bookingIds = bookings.docs.map((d) => d.id);
    // booking_requests.status stays 'accepted' forever — only a live shift makes it "Active Booking".
    const live = await db.collection("shifts").where("clientId", "==", clientId).where("status", "in", ["scheduled", "in-progress"]).get().catch(() => null);
    rel.isBooked = !!live && live.docs.some((d) => bookingIds.includes(String(d.data().bookingRequestId ?? "")));
  }
  if (interviews) {
    const active = ["requested", "pending", "scheduled"];
    rel.isRequested = interviews.docs.some((d) => active.includes(String(d.data().status ?? "")));
    rel.hasCompletedInterview = interviews.docs.some((d) => d.data().status === "completed");
  }
  rel.hasCompletedShift = !!completedShift && !completedShift.empty;
  rel.hasReviewed = !!ownReview && !ownReview.empty;
  return rel;
}

/**
 * The page for one caregiver. `clientId` = the family viewing it (drives the
 * buttons); without it the buttons are the "never met" defaults. Returns null
 * when neither record exists — the page shows "Caregiver not found" then too.
 */
export async function readCaregiverProfilePage(
  caregiverId: string,
  clientId?: string | null,
  reviewLimit = 20,
): Promise<CaregiverProfilePage | null> {
  const [userSnap, publicSnap] = await Promise.all([
    db.collection("users").doc(caregiverId).get().catch(() => null),
    db.collection("publicCaregiverProfiles").doc(caregiverId).get().catch(() => null),
  ]);
  if (!userSnap?.exists && !publicSnap?.exists) return null;
  const merged: Record<string, unknown> = { ...(publicSnap?.data() ?? {}), ...(userSnap?.data() ?? {}) };
  const rec = mapRawToProfileRecord(caregiverId, merged);

  const limit = Math.max(1, Math.min(Math.floor(reviewLimit) || 20, 20));
  const reviewsSnap = await db.collection("reviews")
    .where("caregiverId", "==", caregiverId)
    .orderBy("createdAt", "desc")
    .limit(limit + 1)
    .get()
    .catch(() => null);
  const reviewDocs = reviewsSnap?.docs ?? [];
  const reviews = reviewDocs.slice(0, limit).map((d) => mapReview(d.data() as Record<string, unknown>));
  const rel = clientId ? await readCaregiverRelationship(clientId, caregiverId) : { ...NO_RELATIONSHIP };
  return shapeCaregiverProfilePage(rec, reviews, rel, { hasMoreReviews: reviewDocs.length > limit, published: publicSnap?.exists === true });
}
