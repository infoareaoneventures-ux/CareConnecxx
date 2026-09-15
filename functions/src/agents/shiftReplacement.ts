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
import { haversineDistanceMiles, skillsOverlap } from "./caregiverMatchScoring";
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

// Text the family one profile card per candidate (same tappable photo-preview
// link every other gallery uses) and record the list on the session.
// pendingMatchesSource:"replacement" marks it so a pick is a booking request
// (select_callout_backup), never an interview.
export async function sendReplacementCandidateCards(
  phone: string, chatId: string, shiftId: string, candidates: ReplacementCandidate[], nowIso: string,
): Promise<void> {
  for (const c of candidates) {
    try {
      await sendMessage(chatId,
        `${c.name}${c.hourlyRate ? ` — $${c.hourlyRate}/hr` : ""}${c.source === "care_team" ? " (on your Care Team)" : ""}\n` +
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
    notes:         shift.notes ?? null,
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
  source: "care_team" | "match";
}

const MAX_CANDIDATES = 5;

// clientNeeds: this specific shift's care recipients' needs (not the client's
// needs in general) — same scoping the site uses, and the same signal that
// decides the hard transportation gate below.
export async function findReplacementCandidates(
  clientId: string,
  excludeCaregiverId: string,
  shift: { careRecipients?: Array<{ careNeeds?: string[] }> },
): Promise<ReplacementCandidate[]> {
  const candidates: ReplacementCandidate[] = [];
  const seenIds = new Set<string>([excludeCaregiverId]);

  const clientNeeds = [...new Set((shift.careRecipients || []).flatMap((r) => r.careNeeds || []))];
  const needsTransportation = clientNeeds.some((n) => /transport/i.test(n));

  // Tier 1: anyone the client has ever had a booking relationship with —
  // active Care Team AND past (completed/cancelled) bookings both count, one
  // candidate per caregiver, most recent booking wins.
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
  for (const [cgId, { data: d }] of byCaregiver) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (seenIds.has(cgId)) continue;
    // Care Team is an already-established relationship — the transportation
    // hard filter below only applies to tier 2 (strangers being suggested),
    // not to someone the family already knows and trusts.
    seenIds.add(cgId);
    candidates.push({
      caregiverId: cgId,
      name: (d.caregiverName as string) || "Caregiver",
      photoURL: (d.caregiverPhotoURL as string) || null,
      hourlyRate: (d.rate as number) ?? null,
      source: "care_team",
    });
  }

  if (candidates.length < MAX_CANDIDATES) {
    // The client's own location (for distance) — same geocoded pool
    // CarePlan.tsx's saveSection writes to on every save.
    const cpSnap = await db.collection("carePlans").doc(clientId).get().catch(() => null);
    const locationPool = (cpSnap?.data()?.locationPool as Array<{ lat?: number; lng?: number }> | undefined) || [];
    const clientLoc = locationPool.find((l) => l.lat != null && l.lng != null) || null;

    // caregivers is admin/owner-only for reads (firestore.rules) — clients
    // discover caregivers via publicCaregiverProfiles instead, same as
    // FindCaregivers.tsx / useNearbyCaregiversWithScores.
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
        return { ...c, _distanceMiles: distanceMiles, _skillsScore: skillsOverlap((c.skills || c.specializations || []) as string[], clientNeeds) };
      })
      .sort((a: any, b: any) => {
        const skillsDiff = b._skillsScore - a._skillsScore;
        if (Math.abs(skillsDiff) > 0.01) return skillsDiff;
        if (a._distanceMiles != null && b._distanceMiles != null && a._distanceMiles !== b._distanceMiles) {
          return a._distanceMiles - b._distanceMiles;
        }
        return ((b.rating as number) || 0) - ((a.rating as number) || 0);
      });
    for (const c of scored) {
      if (candidates.length >= MAX_CANDIDATES) break;
      candidates.push({
        caregiverId: c.id,
        name: (c.name as string) || "Caregiver",
        photoURL: (c.photoURL ?? c.photo ?? c.profilePhoto ?? c.imageUrl ?? null) as string | null,
        hourlyRate: (c.hourlyRate as number) ?? null,
        rating: c.rating as number | undefined,
        distanceMiles: c._distanceMiles as number | null,
        source: "match",
      });
    }
  }
  return candidates;
}
