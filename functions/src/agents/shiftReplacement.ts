// Shift-replacement candidate search — backend port of the website's own
// ReplacementPickerModal / fetchReplacementCandidates (components/client/
// ClientVisitsPage.tsx). Kept byte-close to that logic (same two tiers, same
// scoring/sort order, same MAX) so Evia's SMS "find me a replacement" ranks
// candidates identically to opening the site and clicking Find Replacement.
//
// 2026-09-14 (Hamse's call): built to replace get_callout_backups/
// select_callout_backup, which queried the legacy `appointments` collection —
// a data model no current booking (site or Evia) actually writes to anymore.
// This operates on `shifts`, the real collection a "Needs Replacement" card
// lives in.
import * as admin from "firebase-admin";
import { isCaregiverBookable, type CaregiverEligibilityFields } from "../utils/caregiverEligibility";
import { haversineDistanceMiles, skillsOverlap, availabilityOverlap } from "./caregiverMatchScoring";
import { isCaregiverMembershipActive, isCaregiverBackgroundApproved, caregiverTransportDocsValid } from "./caregiverAccessGate";
import { sendMessage } from "../linq/client";
import { getAppUrl } from "../config/appUrl";
import { addKnownNames } from "../utils/knownNames";
import { formatDateWithWeekday, formatHHMMForDisplay } from "../utils/scheduledTime";

const db = admin.firestore();

// ── Shared building blocks (2026-09-14) ──────────────────────────────────────
// One implementation of the website's Find Replacement modal, used by BOTH the
// MCP tools (get_callout_backups / select_callout_backup) and the scripted
// replacementFlow.ts — so the tool path and the conversation path can never
// drift apart in what they write.

import { billedHourly } from "./caregiverProfilePage";
export type ReplacementShiftLoad =
  | { ok: true; shift: FirebaseFirestore.DocumentData; ref: FirebaseFirestore.DocumentReference }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT"; message: string };

// The visit must exist, belong to this client, and be the one status the
// site's Find Replacement button appears on.
export async function loadReplacementShift(clientId: string, shiftId: string): Promise<ReplacementShiftLoad> {
  const ref = db.collection("shifts").doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: "NOT_FOUND", message: "shift not found" };
  const shift = snap.data()!;
  if (shift.clientId !== clientId) return { ok: false, code: "PERMISSION_DENIED", message: "This visit does not belong to this client" };
  if (shift.status !== "needs_replacement") {
    return { ok: false, code: "INVALID_INPUT", message: `This visit isn't awaiting a replacement (status: ${shift.status})` };
  }
  return { ok: true, shift, ref };
}

// "Tuesday, September 15, 2026, 11:00 AM–1:00 PM" — the modal's Date / Start /
// End fields as one line.
export function describeVisitWindow(v: { date?: unknown; startTime?: unknown; endTime?: unknown }): string {
  const start = formatHHMMForDisplay(String(v.startTime ?? ""));
  const end = v.endTime ? `–${formatHHMMForDisplay(String(v.endTime))}` : "";
  return `${formatDateWithWeekday(String(v.date ?? ""))}, ${start}${end}`;
}

// The site's Skip button on a Needs Replacement visit: the visit is simply
// cancelled in place (no replacement), the rest of the booking untouched.
// Same write as manage_booking action:"cancel_visit"; shifts.status →
// cancelled fires onShiftStatusChanged, which notifies the caregiver.
export async function skipReplacementShift(clientId: string, shiftId: string): Promise<
  | { ok: true; date: string; startTime: string; endTime: string }
  | { ok: false; code: "NOT_FOUND" | "PERMISSION_DENIED" | "INVALID_INPUT" }
> {
  const loaded = await loadReplacementShift(clientId, shiftId);
  if (!loaded.ok) return { ok: false, code: loaded.code };
  await loaded.ref.update({ status: "cancelled", cancelledBy: "client", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return {
    ok: true,
    date: String(loaded.shift.date ?? ""),
    startTime: String(loaded.shift.startTime ?? ""),
    endTime: String(loaded.shift.endTime ?? loaded.shift.startTime ?? ""),
  };
}

// Same rate shape as the site's Find a replacement modal and every other
// caregiver row: the caregiver's rate first, what the family is billed second.
export function rateLabel(hourlyRate: number | null | undefined): string {
  if (!hourlyRate) return "";
  return ` — $${hourlyRate}/hr · $${billedHourly(hourlyRate).toFixed(2)}/hr billed`;
}

// Text the family one profile card per candidate (same tappable photo-preview
// link every other gallery uses) and record the list on the session.
// pendingMatchesSource:"replacement" marks it so a pick is a booking request
// (select_callout_backup), never an interview.
/** The card's honesty line when she is beyond her own travel radius (the site prints the same). */
export function stretchNote(c: Pick<ReplacementCandidate, "milesBeyondRadius">): string {
  const m = c.milesBeyondRadius ?? 0;
  if (m <= 0) return "";
  return ` · about ${m < 1 ? "a mile" : `${Math.round(m)} miles`} outside her usual range`;
}

export async function sendReplacementCandidateCards(
  phone: string, chatId: string, shiftId: string, candidates: ReplacementCandidate[], nowIso: string,
): Promise<void> {
  for (const [i, c] of candidates.entries()) {
    try {
      await sendMessage(chatId,
        `${i + 1}. ${c.name}${rateLabel(c.hourlyRate)}${c.source === "care_team" ? " (on your Care Team)" : ""}${stretchNote(c)}\n` +
        `Tap to view ${c.name.split(" ")[0]}'s profile: ${getAppUrl()}/p/${c.caregiverId}`,
      );
      await new Promise<void>((r) => setTimeout(r, 400));
    } catch (err) {
      console.warn("[shiftReplacement] candidate card send failed", { phone, id: c.caregiverId, err: (err as Error)?.message });
    }
  }
  await db.collection("agent_sessions").doc(phone).update({
    pendingMatches: candidates.map((c) => ({ id: c.caregiverId, name: c.name, rate: c.hourlyRate })),
    pendingMatchesSetAt: nowIso,
    pendingMatchesSource: "replacement",
    pendingReplacementShiftId: shiftId,
    shownCaregiverIds: admin.firestore.FieldValue.arrayUnion(...candidates.map((c) => c.caregiverId)),
  });
  await addKnownNames(phone, candidates.map((c) => c.name));
}

export type CreateReplacementResult =
  | { ok: true; bookingRequestId: string; caregiverName: string; date: string; startTime: string; endTime: string }
  | { ok: false; code: "NOT_FOUND"; message: string };

// Matches the site's own handleConfirmReplacement EXACTLY: a real NEW
// booking_requests doc (the candidate gets the normal accept/decline text)
// rather than reassigning the visit — the original shift stays
// 'needs_replacement' until the candidate accepts. Only the bookkeeping
// (replacementRequestId/replacementCaregiverName) is written onto it here.
// Omit date/startTime/endTime to keep the visit's own; pass them to change it
// (the modal's editable Date / Start / End fields).
export async function createReplacementRequest(args: {
  clientId: string;
  shiftId: string;
  shift: FirebaseFirestore.DocumentData;
  shiftRef: FirebaseFirestore.DocumentReference;
  backupCaregiverId: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  nowIso: string;
}): Promise<CreateReplacementResult> {
  const { clientId, shiftId, shift, shiftRef, backupCaregiverId, nowIso } = args;
  const cgSnap = await db.collection("caregivers").doc(backupCaregiverId).get();
  if (!cgSnap.exists) return { ok: false, code: "NOT_FOUND", message: "caregiver not found" };
  const cg = cgSnap.data() || {};
  const caregiverName = ((cg.name as string | undefined) ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "your caregiver";
  const effDate      = args.date ?? (shift.date as string);
  const effStartTime = args.startTime ?? (shift.startTime as string);
  const effEndTime   = args.endTime ?? (shift.endTime as string | undefined) ?? effStartTime;
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${effDate}T12:00:00`).getDay()];
  // The booking's own note + this visit's note when it differs — the same
  // composition as ClientVisitsPage.handleConfirmReplacement (2026-09-29).
  const origBookingSnap = shift.bookingRequestId ? await db.collection("booking_requests").doc(String(shift.bookingRequestId)).get().catch(() => null) : null;
  const bookingNote = (origBookingSnap?.exists ? (origBookingSnap.data()?.notes as string | undefined) : undefined) || null;
  const visitNote = (shift.notes as string | undefined) || null;
  // Labelled so the Requests card (one Notes field) reads the same as the START text (founder, 2026-09-29).
  const replacementNotes = [bookingNote ? `Booking note: ${bookingNote}` : null, visitNote && visitNote !== bookingNote ? `Visit note: ${visitNote}` : null].filter(Boolean).join("\n") || null;
  const bookingRef = db.collection("booking_requests").doc();
  await bookingRef.set({
    clientId,
    clientName:    shift.clientName ?? "",
    caregiverId:   backupCaregiverId,
    caregiverName,
    address:       shift.address ?? "",
    rate:          (cg.hourlyRate as number | undefined) ?? shift.rate ?? null,
    paymentMethod: shift.paymentMethod ?? "credit",
    careNeeds:     [...new Set(((shift.careRecipients ?? []) as Array<{ careNeeds?: string[] }>).flatMap((r) => r.careNeeds || []))],
    careRecipients: shift.careRecipients ?? [],
    notes:         replacementNotes,
    emergencyContact: shift.emergencyContact ?? null,
    schedule: {
      days: [dayName],
      startDate: effDate,
      endDate: effDate,
      ongoing: false,
      dayShiftTimes: { [dayName]: [{ start: effStartTime, end: effEndTime }] },
    },
    isShiftReplacement: true,
    replacementForShiftId: shiftId,
    status: "pending",
    isResend: false,
    createdAt: nowIso,
  });
  await shiftRef.update({
    replacementRequestId: bookingRef.id,
    replacementCaregiverName: caregiverName,
  });
  return { ok: true, bookingRequestId: bookingRef.id, caregiverName, date: effDate, startTime: effStartTime, endTime: effEndTime };
}

export interface ReplacementCandidate {
  caregiverId: string;
  name: string;
  photoURL: string | null;
  hourlyRate: number | null;
  rating?: number;
  distanceMiles?: number | null;
  /** Miles beyond her own travel radius (strangers only; founder 2026-10-04: radius is a
   *  preference up to RADIUS_STRETCH_MILES, then a wall). Absent / 0 = inside her range. */
  milesBeyondRadius?: number;
  source: "care_team" | "match";
}

const MAX_CANDIDATES = 5;
/** A stranger may be offered a shift this far beyond her own travel radius — flagged on the card; past it she is not offered. */
export const RADIUS_STRETCH_MILES = 20; // founder, 2026-10-04: some caregivers drive that far

// clientNeeds: this specific shift's care recipients' needs (not the client's
// needs in general) — same scoping the site uses, and the same signal that
// decides the hard transportation gate below.
// "HH:MM" → minutes; an end at or before the start is read as a one-hour visit.
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function visitsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = minutesOf(aStart), bs = minutesOf(bStart);
  if (as == null || bs == null) return false;
  let ae = minutesOf(aEnd) ?? as; if (ae <= as) ae = as + 60;
  let be = minutesOf(bEnd) ?? bs; if (be <= bs) be = bs + 60;
  return as < be && bs < ae;
}
// "YYYY-MM-DD" → the weekday name availabilityOverlap understands (local calendar day).
export function weekdayOf(ymd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][d.getDay()] ?? null;
}

export interface ReplacementShiftInput {
  careRecipients?: Array<{ careNeeds?: string[] }>;
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

/**
 * The candidates offered for a cancelled shift — ONE rule for the site's Find a
 * replacement (stored on the shift by onShiftStatusChanged) and Evia's flow.
 *
 * Everyone, known or stranger (founder, 2026-10-04):
 *   · not already in another visit that overlaps this one (shifts, same date)
 *   · not blocked by the family, and has not blocked the family
 *   · passes the membership + background gate every other booking path runs
 *   · Transportation live on the profile when the shift includes driving
 * Strangers also: within their own travel radius; ranked by services match →
 * profile availability for that weekday → distance → rating. Known caregivers
 * (anyone the family ever booked) come first, most recent booking first — a
 * profile availability mismatch never excludes anyone, the same as a regular
 * booking, where availability is a preference and she accepts or declines.
 */
export async function findReplacementCandidates(
  clientId: string,
  excludeCaregiverId: string,
  shift: ReplacementShiftInput,
): Promise<ReplacementCandidate[]> {
  const candidates: ReplacementCandidate[] = [];
  const seenIds = new Set<string>([excludeCaregiverId]);

  const clientNeeds = [...new Set((shift.careRecipients || []).flatMap((r) => r.careNeeds || []))];
  const needsTransportation = clientNeeds.some((n) => /transport/i.test(n));
  const shiftDate = String(shift.date ?? "");
  const shiftStart = String(shift.startTime ?? "");
  const shiftEnd = String(shift.endTime ?? shiftStart);
  const weekday = weekdayOf(shiftDate);

  // Already in another visit at that time (any family).
  const busy = new Set<string>();
  if (shiftDate) {
    const daySnap = await db.collection("shifts").where("date", "==", shiftDate).where("status", "in", ["scheduled", "in-progress"]).get().catch(() => null);
    daySnap?.docs.forEach((d) => {
      const s = d.data();
      if (!s.caregiverId) return;
      if (visitsOverlap(shiftStart, shiftEnd, String(s.startTime ?? ""), String(s.endTime ?? s.startTime ?? ""))) busy.add(String(s.caregiverId));
    });
  }
  // The family's block list.
  const clientUser = (await db.collection("users").doc(clientId).get().catch(() => null))?.data() ?? {};
  const blockedByFamily = new Set<string>(Array.isArray(clientUser.blockedUsers) ? (clientUser.blockedUsers as string[]) : []);

  // The rules everyone must pass, checked lazily on the finalists (three reads each).
  const passesHardRules = async (cgId: string): Promise<boolean> => {
    if (busy.has(cgId) || blockedByFamily.has(cgId)) return false;
    const [cgSnap, uSnap, pubSnap] = await Promise.all([
      db.collection("caregivers").doc(cgId).get().catch(() => null),
      db.collection("users").doc(cgId).get().catch(() => null),
      db.collection("publicCaregiverProfiles").doc(cgId).get().catch(() => null),
    ]);
    const cg = (cgSnap?.data() ?? {}) as Record<string, unknown>;
    if (!isCaregiverMembershipActive(cg) || !isCaregiverBackgroundApproved(cg)) return false;
    const herBlocks = uSnap?.data()?.blockedUsers;
    if (Array.isArray(herBlocks) && herBlocks.includes(clientId)) return false;
    if (needsTransportation) {
      const pub = (pubSnap?.data() ?? {}) as Record<string, unknown>;
      if (!(pub.hasValidTransportDocs === true || caregiverTransportDocsValid(cg))) return false;
    }
    return true;
  };

  // Tier 1: anyone the family has ever had a booking relationship with —
  // active Care Team AND past (completed/cancelled) bookings both count, one
  // candidate per caregiver, most recent booking first.
  const careTeamSnap = await db.collection("booking_requests")
    .where("clientId", "==", clientId)
    .where("status", "in", ["accepted", "completed", "cancelled"])
    .get();
  const byCaregiver = new Map<string, { data: FirebaseFirestore.DocumentData; ts: number }>();
  careTeamSnap.docs.forEach((doc) => {
    const d = doc.data();
    if (!d.caregiverId) return;
    const ts = (d.updatedAt?.seconds ?? d.createdAt?.seconds ?? 0) as number;
    const existing = byCaregiver.get(d.caregiverId as string);
    if (!existing || ts > existing.ts) byCaregiver.set(d.caregiverId as string, { data: d, ts });
  });
  const known = [...byCaregiver.entries()].sort((a, b) => b[1].ts - a[1].ts);
  for (const [cgId, { data: d }] of known) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (seenIds.has(cgId)) continue;
    seenIds.add(cgId);
    if (!(await passesHardRules(cgId))) continue;
    candidates.push({
      caregiverId: cgId,
      name: (d.caregiverName as string) || "Caregiver",
      photoURL: (d.caregiverPhotoURL as string) || null,
      hourlyRate: (d.rate as number) ?? null,
      source: "care_team",
    });
  }

  if (candidates.length < MAX_CANDIDATES) {
    // The family's own location (for distance and the caregiver's radius) — the
    // same geocoded pool CarePlan.tsx's saveSection writes to on every save.
    const cpSnap = await db.collection("carePlans").doc(clientId).get().catch(() => null);
    const locationPool = (cpSnap?.data()?.locationPool as Array<{ lat?: number; lng?: number }> | undefined) || [];
    const clientLoc = locationPool.find((l) => l.lat != null && l.lng != null) || null;

    // Strangers come from publicCaregiverProfiles, the pool every family-side
    // surface reads (FindCaregivers.tsx / useNearbyCaregiversWithScores).
    const pool = await db.collection("publicCaregiverProfiles")
      .where("onboardingStatus", "==", "profile_complete")
      .limit(50)
      .get();
    const scored: any[] = pool.docs
      .map((d): any => ({ id: d.id, ...d.data() }))
      .filter((c: any) => !seenIds.has(c.id) && isCaregiverBookable(c as CaregiverEligibilityFields) && (!needsTransportation || c.hasValidTransportDocs))
      .map((c: any): any => {
        const cgLat = (c.lat ?? c.latitude ?? null) as number | null;
        const cgLng = (c.lng ?? c.longitude ?? null) as number | null;
        const distanceMiles = (clientLoc && cgLat != null && cgLng != null)
          ? Math.round(haversineDistanceMiles(clientLoc.lat!, clientLoc.lng!, cgLat, cgLng) * 10) / 10
          : null;
        return {
          ...c,
          _distanceMiles: distanceMiles,
          _skillsScore: skillsOverlap((c.skills || c.specializations || []) as string[], clientNeeds),
          _availScore: weekday ? availabilityOverlap(c.weeklyAvailability ?? c.availability, [weekday]) : 0,
        };
      })
      // Her own travel radius (strangers only — a known caregiver has already come to
      // this address): inside it first; up to RADIUS_STRETCH_MILES beyond it allowed,
      // flagged, closest overshoot first; past that, not offered (founder 2026-10-04).
      .map((c: any): any => {
        const radius = Number(c.travelRadius ?? c.serviceRadius ?? 0);
        const beyond = radius > 0 && c._distanceMiles != null && c._distanceMiles > radius ? Math.round((c._distanceMiles - radius) * 10) / 10 : 0;
        return { ...c, _beyondRadius: beyond };
      })
      .filter((c: any) => c._beyondRadius <= RADIUS_STRETCH_MILES)
      .sort((a: any, b: any) => {
        // Inside her range before any stretch; among stretches, the smallest first.
        if ((a._beyondRadius > 0) !== (b._beyondRadius > 0)) return a._beyondRadius > 0 ? 1 : -1;
        if (a._beyondRadius > 0 && a._beyondRadius !== b._beyondRadius) return a._beyondRadius - b._beyondRadius;
        const skillsDiff = b._skillsScore - a._skillsScore;
        if (Math.abs(skillsDiff) > 0.01) return skillsDiff;
        const availDiff = b._availScore - a._availScore;
        if (Math.abs(availDiff) > 0.01) return availDiff;
        if (a._distanceMiles != null && b._distanceMiles != null && a._distanceMiles !== b._distanceMiles) {
          return a._distanceMiles - b._distanceMiles;
        }
        return ((b.rating as number) || 0) - ((a.rating as number) || 0);
      });
    for (const c of scored) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (!(await passesHardRules(c.id))) continue;
      candidates.push({
        caregiverId: c.id,
        name: (c.name as string) || "Caregiver",
        photoURL: (c.photoURL ?? c.photo ?? c.profilePhoto ?? c.imageUrl ?? null) as string | null,
        hourlyRate: (c.hourlyRate as number) ?? null,
        rating: c.rating as number | undefined,
        distanceMiles: c._distanceMiles as number | null,
        ...(c._beyondRadius > 0 ? { milesBeyondRadius: c._beyondRadius as number } : {}),
        source: "match",
      });
    }
  }
  return candidates;
}
