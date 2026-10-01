// agents/caregiverSearch.ts — the website's Find Caregivers page
// (components/FindCaregivers.tsx) as ONE shared search, 2026-09-17.
//
// Every Evia path that shows a family caregivers goes through here: the
// find_nearby_caregivers tool, the FIND_CAREGIVER intent, the mid-search
// "show me cheaper ones" refilter, the post-onboarding first search, and the
// commitment sweep. Same pool, same filters, same sort, same card, same
// button states as the page:
//
//   pool     publicCaregiverProfiles where onboardingStatus == profile_complete,
//            kept only when isCaregiverBookable (verificationStatus approved)
//   filters  blocked users, Favorites tab, distance (default 25 mi, and the
//            caregiver's own serviceRadius), name/city/state/zip search, max
//            rate (default $75, 100 = no cap), rating (Any/3+/4+/4.5+),
//            experience (Any/1+/3+/5+/10+), Background checked only, Reliable
//            transportation, specialties (any), languages (any)
//   sort     Highest rated (default) · Price: Low to High · Price: High to Low
//   card     photo, name, stars + review count, verification badge, experience,
//            city/state/zip, $rate/hr, 2 skills + "+N", Message, and
//            Request Interview / Active Booking / Requested / Re-book
//
// The former matchingAgent.ts (Claude-scored top-3 with its own message) and
// the tool's own extras (never re-show, hide hired/declined, widen when
// empty, care-needs ranking) had no page equivalent and were removed.
import * as admin from "firebase-admin";
import { isCaregiverBookable, type CaregiverEligibilityFields } from "../utils/caregiverEligibility";
import { haversineDistanceMiles, hasValidTransportDocs } from "./caregiverMatchScoring";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();

export type CaregiverSortOption = "rating" | "price-low" | "price-high";

export interface CaregiverSearchFilters {
  /** Name / city / state / zip search box. */
  query?: string;
  /** Distance slider — page default 25 mi. Applied only when the family has a location and the caregiver has coordinates. */
  maxDistanceMiles?: number;
  /** Max rate slider — page default $75/hr; 100 or more means no cap. */
  maxHourlyRate?: number;
  /** Rating pills: 0 (Any), 3, 4, 4.5. */
  minRating?: number;
  /** Experience radios: 0, 1, 3, 5, 10. */
  minExperienceYears?: number;
  /** Trust & Safety checkboxes. */
  verifiedOnly?: boolean;
  transportationOnly?: boolean;
  /** Senior care specialties — a caregiver matches if they have ANY selected one. */
  specialties?: string[];
  /** Languages — ANY selected one. */
  languages?: string[];
  sortBy?: CaregiverSortOption;
  /** The Favorites tab. */
  favoritesOnly?: boolean;
}

export type CaregiverCardState = "request_interview" | "active_booking" | "interview_requested" | "rebook";

export interface CaregiverCard {
  id:            string;
  name:          string;
  firstName:     string;
  lastName:      string;
  photoURL:      string | null;
  rating:        number;
  reviewCount:   number;
  verified:      boolean;
  backgroundCheckStatus: string;
  experience:    number | string;
  city:          string;
  stateCode:     string | null;
  zipCode:       string | null;
  distance:      number;
  hourlyRate:    number;
  skills:        string[];
  languages:     string[];
  hasReliableTransportation: boolean;
  isFavorite:    boolean;
  /** Which primary button the card shows. */
  state:         CaregiverCardState;
  actions:       Array<"message" | "request_interview" | "rebook">;
  profileUrl:    string;
}

export interface CaregiverSearchResult {
  total:       number;
  caregivers:  CaregiverCard[];
  hasLocation: boolean;
  filters:     Required<Pick<CaregiverSearchFilters, "maxDistanceMiles" | "maxHourlyRate" | "minRating" | "minExperienceYears" | "sortBy">> & CaregiverSearchFilters;
}

// ── Client care locations — FindCaregivers.tsx steps 1–4 ────────────────────
export async function gatherClientLocations(clientId: string): Promise<Array<{ lat: number; lng: number }>> {
  const [postsSnap, jpDoc, cpDoc, spDoc] = await Promise.all([
    db.collection("job_posts").where("clientId", "==", clientId).where("status", "==", "open").get().catch(() => null),
    db.collection("job_postings").doc(clientId).get().catch(() => null),
    db.collection("carePlans").doc(clientId).get().catch(() => null),
    db.collection("senior_profiles").doc(clientId).get().catch(() => null),
  ]);
  const seen = new Set<string>();
  const locs: Array<{ lat: number; lng: number }> = [];
  const addLoc = (lat: unknown, lng: unknown) => {
    if (lat == null || lng == null) return;
    const la = Number(lat), ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    const key = `${la},${ln}`;
    if (!seen.has(key)) { seen.add(key); locs.push({ lat: la, lng: ln }); }
  };
  postsSnap?.docs.forEach((d) => { const p = d.data(); addLoc(p.lat, p.lng); });
  if (jpDoc?.exists) { const d = jpDoc.data()!; addLoc(d.lat, d.lng); }
  if (cpDoc?.exists) { const d = cpDoc.data()!; ((d.locationPool as Array<{ lat?: unknown; lng?: unknown }> | undefined) ?? []).forEach((l) => addLoc(l.lat, l.lng)); }
  if (spDoc?.exists) { const d = spDoc.data()!; addLoc(d.latitude, d.longitude); addLoc(d.lat, d.lng); }
  if (locs.length === 0) {
    const userDoc = await db.collection("users").doc(clientId).get().catch(() => null);
    if (userDoc?.exists) { const d = userDoc.data()!; addLoc(d.latitude, d.longitude); addLoc(d.lat, d.lng); }
  }
  return locs;
}

// ── The page's filteredCaregivers memo + card button state ──────────────────
export async function searchCaregivers(clientId: string, input: CaregiverSearchFilters = {}): Promise<CaregiverSearchResult> {
  const filters = {
    ...input,
    maxDistanceMiles:   typeof input.maxDistanceMiles === "number" && input.maxDistanceMiles > 0 ? input.maxDistanceMiles : 25,
    maxHourlyRate:      typeof input.maxHourlyRate === "number" && input.maxHourlyRate > 0 ? input.maxHourlyRate : 75,
    minRating:          typeof input.minRating === "number" ? input.minRating : 0,
    minExperienceYears: typeof input.minExperienceYears === "number" ? input.minExperienceYears : 0,
    sortBy:             (input.sortBy ?? "rating") as CaregiverSortOption,
  };

  const [poolSnap, userDoc, bookingsSnap, shiftsSnap, interviewsSnap, locs] = await Promise.all([
    db.collection("publicCaregiverProfiles").where("onboardingStatus", "==", "profile_complete").limit(100).get(),
    db.collection("users").doc(clientId).get().catch(() => null),
    db.collection("booking_requests").where("clientId", "==", clientId).where("status", "==", "accepted").get().catch(() => null),
    db.collection("shifts").where("clientId", "==", clientId).where("status", "in", ["scheduled", "in-progress"]).get().catch(() => null),
    db.collection("video_interviews").where("clientId", "==", clientId).get().catch(() => null),
    gatherClientLocations(clientId),
  ]);
  const user = (userDoc?.exists ? userDoc.data() : {}) as Record<string, unknown>;
  const blocked = new Set<string>(Array.isArray(user.blockedUsers) ? (user.blockedUsers as string[]) : []);
  const favorites = new Set<string>(Array.isArray(user.savedCaregiverIds) ? (user.savedCaregiverIds as string[]) : []);

  // Active Booking / Requested / Re-book — the page's bookedCaregiverIds,
  // requestedCaregiverIds and rebookCaregiverIds.
  const activeShiftBookingIds = new Set<string>((shiftsSnap?.docs ?? []).map((d) => String(d.data().bookingRequestId ?? "")).filter(Boolean));
  const allAccepted = new Set<string>();
  const live = new Set<string>();
  for (const d of bookingsSnap?.docs ?? []) {
    const cg = String(d.data().caregiverId ?? "");
    if (!cg) continue;
    allAccepted.add(cg);
    if (activeShiftBookingIds.has(d.id)) live.add(cg);
  }
  const requested = new Set<string>();
  const completedInterview = new Set<string>();
  for (const d of interviewsSnap?.docs ?? []) {
    const iv = d.data();
    const cg = String(iv.caregiverId ?? "");
    if (!cg) continue;
    if (["requested", "pending", "scheduled"].includes(String(iv.status))) requested.add(cg);
    if (iv.status === "completed") completedInterview.add(cg);
  }
  const rebook = new Set<string>([...allAccepted].filter((id) => !live.has(id) && completedInterview.has(id)));

  const appUrl = getAppUrl();
  const cards: CaregiverCard[] = [];
  for (const doc of poolSnap.docs) {
    const data = doc.data();
    if (!isCaregiverBookable(data as CaregiverEligibilityFields)) continue;
    const nameStr = String(data.name ?? "");
    const firstName = String(data.firstName ?? nameStr.split(" ")[0] ?? "");
    const lastName = String(data.lastName ?? nameStr.split(" ").slice(1).join(" ") ?? "");
    if (!firstName && !lastName && !nameStr) continue;
    const cgLat = (data.lat ?? data.latitude ?? (data.location as { lat?: unknown } | undefined)?.lat ?? (data._geoloc as { lat?: unknown } | undefined)?.lat) as number | undefined;
    const cgLng = (data.lng ?? data.longitude ?? (data.location as { lng?: unknown } | undefined)?.lng ?? (data._geoloc as { lng?: unknown } | undefined)?.lng) as number | undefined;
    let distance = 0;
    if (cgLat != null && cgLng != null && locs.length > 0) {
      distance = Math.min(...locs.map((l) => haversineDistanceMiles(l.lat, l.lng, Number(cgLat), Number(cgLng))));
      distance = Math.round(distance * 10) / 10;
    }
    const serviceRadius = (data.serviceRadius ?? data.travelRadius) as number | undefined;
    const skills = (data.skills ?? data.specializations ?? data.specialties ?? []) as string[];
    const languages = (Array.isArray(data.languages) ? data.languages : ["English"]) as string[];
    const state: CaregiverCardState = live.has(doc.id) ? "active_booking"
      : rebook.has(doc.id) ? "rebook"
      : requested.has(doc.id) ? "interview_requested"
      : "request_interview";
    cards.push({
      id: doc.id,
      name: `${firstName} ${lastName}`.trim() || nameStr,
      firstName, lastName,
      photoURL: (data.photoURL ?? data.photo ?? data.imageUrl ?? data.profilePhoto ?? null) as string | null,
      rating: Number(data.rating) || 5.0,
      reviewCount: Number(data.reviewCount ?? 0),
      verified: Boolean(data.backgroundCheckComplete || data.verified),
      backgroundCheckStatus: String(data.backgroundCheckStatus ?? (data.backgroundCheckData as { status?: string } | undefined)?.status ?? ((data.backgroundCheckComplete || data.verified) ? "clear" : "none")),
      experience: (data.experience ?? data.yearsExperience ?? 0) as number | string,
      city: String(data.city ?? (data.location as { city?: string } | undefined)?.city ?? "Nearby"),
      stateCode: (data.state ?? (data.location as { state?: string } | undefined)?.state ?? null) as string | null,
      zipCode: (data.zipCode ?? data.zip ?? null) as string | null,
      distance,
      hourlyRate: Number(data.hourlyRate) || 25,
      skills, languages,
      hasReliableTransportation: hasValidTransportDocs(data),
      isFavorite: favorites.has(doc.id),
      state,
      actions: ["message", ...(state === "request_interview" ? ["request_interview" as const] : state === "rebook" ? ["rebook" as const] : [])],
      profileUrl: `${appUrl}/p/${doc.id}`,
      // kept for the filter below
      ...({ _lat: cgLat, _lng: cgLng, _serviceRadius: serviceRadius } as Record<string, unknown>),
    } as CaregiverCard);
  }

  const q = (filters.query ?? "").trim().toLowerCase();
  const wantedSpecialties = (filters.specialties ?? []).map((s) => s.toLowerCase());
  const wantedLanguages = (filters.languages ?? []).map((l) => l.toLowerCase());
  const list = cards.filter((cg) => {
    const raw = cg as unknown as Record<string, unknown>;
    if (blocked.has(cg.id)) return false;
    if (filters.favoritesOnly && !cg.isFavorite) return false;
    if (locs.length > 0 && raw._lat != null && raw._lng != null) {
      if (cg.distance > filters.maxDistanceMiles) return false;
      const sr = raw._serviceRadius as number | undefined;
      if (sr != null && sr > 0 && cg.distance > sr) return false;
    }
    if (q) {
      const hay = [cg.name, cg.city, cg.stateCode ?? "", cg.zipCode ?? ""].map((v) => v.toLowerCase());
      if (!hay.some((h) => h.includes(q))) return false;
    }
    if (filters.maxHourlyRate < 100 && cg.hourlyRate > filters.maxHourlyRate) return false;
    if (cg.rating < filters.minRating) return false;
    if ((Number(cg.experience) || 0) < filters.minExperienceYears) return false;
    if (filters.verifiedOnly && !cg.verified) return false;
    if (filters.transportationOnly && !cg.hasReliableTransportation) return false;
    if (wantedSpecialties.length > 0) {
      const have = new Set(cg.skills.map((s) => s.toLowerCase()));
      if (!wantedSpecialties.some((s) => have.has(s))) return false;
    }
    if (wantedLanguages.length > 0) {
      const have = new Set(cg.languages.map((l) => l.toLowerCase()));
      if (!wantedLanguages.some((l) => have.has(l))) return false;
    }
    return true;
  });
  switch (filters.sortBy) {
    case "price-low":  list.sort((a, b) => a.hourlyRate - b.hourlyRate); break;
    case "price-high": list.sort((a, b) => b.hourlyRate - a.hourlyRate); break;
    default:           list.sort((a, b) => b.rating - a.rating); break;
  }
  for (const cg of list) { const raw = cg as unknown as Record<string, unknown>; delete raw._lat; delete raw._lng; delete raw._serviceRadius; }
  return { total: list.length, caregivers: list, hasLocation: locs.length > 0, filters };
}

// ── The card, as one SMS ────────────────────────────────────────────────────
export function caregiverCardText(c: CaregiverCard): string {
  const ratingLabel = c.reviewCount > 0 ? `★ ${c.rating.toFixed(1)} (${c.reviewCount} review${c.reviewCount === 1 ? "" : "s"})` : "No reviews yet";
  const exp = typeof c.experience === "number" ? `${c.experience} yrs experience` : `${c.experience} experience`;
  const where = [c.city, c.stateCode].filter(Boolean).join(", ") + (c.zipCode ? ` ${c.zipCode}` : "");
  // Transportation only counts as a service once the badge is earned — same gate
  // as the profile page (ClientCaregiverProfile.tsx / caregiverProfilePage.ts)
  // and the site's Find Caregivers card (parity fix, 2026-09-22).
  const visibleSkills = c.skills.filter((s) => s !== "Transportation" || c.hasReliableTransportation);
  const skills = visibleSkills.length > 0 ? `${visibleSkills.slice(0, 2).join(", ")}${visibleSkills.length > 2 ? ` +${visibleSkills.length - 2}` : ""}` : "";
  const stateLabel = c.state === "active_booking" ? "Active booking with you"
    : c.state === "interview_requested" ? "Interview requested — waiting on their reply"
    : c.state === "rebook" ? "Worked with you before — can re-book"
    : "";
  const bits = [ratingLabel, exp, where, skills, c.verified ? "Background checked" : "", c.isFavorite ? "♥ Favorite" : "", stateLabel].filter(Boolean);
  return `${c.name} — $${c.hourlyRate}/hr\n${bits.join(" · ")}\nTap to view ${c.firstName || c.name.split(" ")[0]}'s profile: ${c.profileUrl}`;
}

export function describeActiveFilters(f: CaregiverSearchFilters): string[] {
  const out: string[] = [];
  if (f.query) out.push(`"${f.query}"`);
  if (f.maxDistanceMiles && f.maxDistanceMiles !== 25) out.push(`within ${f.maxDistanceMiles} mi`);
  if (f.maxHourlyRate && f.maxHourlyRate !== 75 && f.maxHourlyRate < 100) out.push(`up to $${f.maxHourlyRate}/hr`);
  if (f.minRating) out.push(`${f.minRating}+ stars`);
  if (f.minExperienceYears) out.push(`${f.minExperienceYears}+ years`);
  if (f.verifiedOnly) out.push("background checked");
  if (f.transportationOnly) out.push("reliable transportation");
  if (f.specialties?.length) out.push(f.specialties.join(", "));
  if (f.languages?.length) out.push(f.languages.join(", "));
  if (f.favoritesOnly) out.push("favorites");
  return out;
}

export interface PresentCaregiverSearchArgs {
  phone:     string;
  chatId:    string;
  clientId?: string;
  filters?:  CaregiverSearchFilters;
  offset?:   number;
  /** Cards to text this turn — default 4 (the dashboard's Nearby Caregivers widget), max 10. */
  limit?:    number;
  source?:   string;
}

export type PresentCaregiverSearchResult =
  | { status: "shown"; total: number; shown: CaregiverCard[]; offset: number; hasMore: boolean }
  | { status: "empty"; total: 0; hasFilters: boolean }
  | { status: "no_client" };

/**
 * Text the family the page: a "N caregivers found" line, then one card per
 * caregiver (the page's card fields + a tappable profile link), and record
 * pendingMatches / shownCaregiverIds so a follow-up "meet Imran" resolves.
 * Empty results send the page's own empty-state copy.
 */
export async function presentCaregiverSearch(args: PresentCaregiverSearchArgs): Promise<PresentCaregiverSearchResult> {
  const { sendMessage } = await import("../linq/client");
  const sessionRef = db.collection("agent_sessions").doc(args.phone);
  let clientId = args.clientId;
  if (!clientId) {
    const s = await sessionRef.get().catch(() => null);
    clientId = (s?.data()?.userId as string | undefined) ?? undefined;
  }
  if (!clientId) return { status: "no_client" };

  const filters = args.filters ?? {};
  const result = await searchCaregivers(clientId, filters);
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 4), 1), 10);
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const shown = result.caregivers.slice(offset, offset + limit);
  const active = describeActiveFilters(filters);

  if (result.total === 0) {
    // FindCaregivers.tsx EmptyState — same two messages.
    await sendMessage(args.chatId, active.length > 0
      ? `No caregivers match your filters (${active.join(", ")}). Try widening your distance, raising your rate, or removing some specialties — just tell me what to change.`
      : "No caregivers available yet — we're growing our caregiver network in your area. Want me to post a care request so matching caregivers can apply directly?");
    return { status: "empty", total: 0, hasFilters: active.length > 0 };
  }
  if (shown.length === 0) {
    await sendMessage(args.chatId, `That's everyone — ${result.total} caregiver${result.total === 1 ? "" : "s"} match${result.total === 1 ? "es" : ""}${active.length ? ` (${active.join(", ")})` : ""}. Want me to widen the search?`);
    return { status: "shown", total: result.total, shown: [], offset, hasMore: false };
  }

  const header = `${result.total} caregiver${result.total === 1 ? "" : "s"} found${active.length ? ` (${active.join(", ")})` : ""}` +
    (result.total > shown.length ? ` — here ${offset > 0 ? "are the next" : "are the first"} ${shown.length}:` : ":");
  // (The page's "rates are the caregiver's; a 9% service fee is added" footnote was removed 2026-09-30 — founder — so it is gone here too.)
  await sendMessage(args.chatId, header);
  for (const c of shown) {
    try {
      await sendMessage(args.chatId, caregiverCardText(c));
      await new Promise<void>((r) => setTimeout(r, 400));
    } catch (err) {
      console.warn("[caregiverSearch] card send failed", { phone: args.phone, id: c.id, err: (err as Error)?.message });
    }
  }
  await sessionRef.set({
    pendingMatches: shown.map((c) => ({ id: c.id, name: c.name, rate: c.hourlyRate })),
    pendingMatchesSetAt: new Date().toISOString(),
    pendingMatchesSource: "browse",
    pendingReplacementShiftId: admin.firestore.FieldValue.delete(),
    shownCaregiverIds: admin.firestore.FieldValue.arrayUnion(...shown.map((c) => c.id)),
  }, { merge: true }).catch(() => {});
  await import("../utils/knownNames").then((m) => m.addKnownNames(args.phone, shown.map((c) => c.name))).catch(() => {});
  return { status: "shown", total: result.total, shown, offset, hasMore: offset + shown.length < result.total };
}
