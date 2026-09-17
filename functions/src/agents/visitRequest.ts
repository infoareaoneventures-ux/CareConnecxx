// Request Visit — backend port of the website's Calendar "+ Request Visit"
// modal (components/Schedule.tsx: the caregiver/booking pickers, the per-day
// time blocks with availability filtering, and handleAddShift's
// booking_amendments write). One implementation shared by the MCP tool
// (request_schedule_amendment) and the scripted visitRequestFlow.ts, so the
// tool path and the conversation path can never drift apart in what they
// check or write.
import * as admin from "firebase-admin";
import { businessTodayStr, formatHHMMForDisplay } from "../utils/scheduledTime";
import { bookingTimeToMinutes } from "./bookingResolution";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

export const DAY_ABBRS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type DayAbbr = typeof DAY_ABBRS[number];
export const ABBR_TO_FULL: Record<string, string> = {
  Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday",
};
// The site's own BLOCK_MINS for a caregiver whose weeklyAvailability is
// stored as named blocks rather than start/end pairs.
const BLOCK_MINS: Record<string, { s: number; e: number }> = {
  morning: { s: 360, e: 720 }, afternoon: { s: 720, e: 1080 }, evening: { s: 1080, e: 1380 }, overnight: { s: 1380, e: 360 },
};

export interface TimeBlock { start: string; end: string }
export interface MinuteRange { s: number; e: number }

// "tuesday" / "Tue" / "TUES" → "Tue"; anything else → null.
export function normDayAbbr(v: unknown): DayAbbr | null {
  const t = String(v ?? "").trim();
  if (!t) return null;
  const key = t.charAt(0).toUpperCase() + t.slice(1, 3).toLowerCase();
  return (DAY_ABBRS as readonly string[]).includes(key) ? (key as DayAbbr) : null;
}

export function blockToRange(b: TimeBlock): MinuteRange | null {
  const s = bookingTimeToMinutes(b.start);
  const e = bookingTimeToMinutes(b.end);
  if (s === null || e === null || e <= s) return null;
  return { s, e };
}

export function describeBlock(b: TimeBlock): string {
  return `${formatHHMMForDisplay(b.start)}–${formatHHMMForDisplay(b.end)}`;
}

// ── The modal's Caregiver / Booking pickers ───────────────────────────────────

export interface VisitRequestBooking {
  bookingId: string;
  jobTitle: string;
  address: string;
  // The booking's own weekly schedule (dayShiftTimes), abbr → blocks.
  schedule: Record<string, TimeBlock[]>;
}
export interface VisitRequestCaregiver {
  id: string;
  name: string;
  bookings: VisitRequestBooking[];
}

// Schedule.tsx: accepted booking_requests that still have at least one
// 'scheduled' shift — grouped by caregiver, in the order the site lists them.
export async function listVisitRequestCaregivers(clientId: string): Promise<VisitRequestCaregiver[]> {
  const [bookingsSnap, shiftsSnap] = await Promise.all([
    db.collection("booking_requests").where("clientId", "==", clientId).where("status", "==", "accepted").get(),
    db.collection("shifts").where("clientId", "==", clientId).where("status", "==", "scheduled").get(),
  ]);
  const activeBookingIds = new Set<string>();
  shiftsSnap.docs.forEach((d) => { const bid = d.data().bookingRequestId; if (bid) activeBookingIds.add(String(bid)); });

  const out: VisitRequestCaregiver[] = [];
  const byCg = new Map<string, VisitRequestCaregiver>();
  for (const doc of bookingsSnap.docs) {
    const d = doc.data();
    if (!activeBookingIds.has(doc.id) || !d.caregiverId) continue;
    const cgId = String(d.caregiverId);
    let cg = byCg.get(cgId);
    if (!cg) {
      cg = { id: cgId, name: String(d.caregiverName ?? "Caregiver"), bookings: [] };
      byCg.set(cgId, cg);
      out.push(cg);
    }
    const dst = (d.schedule?.dayShiftTimes ?? {}) as Record<string, Array<TimeBlock> | TimeBlock>;
    const schedule: Record<string, TimeBlock[]> = {};
    for (const [k, v] of Object.entries(dst)) {
      const abbr = normDayAbbr(k);
      if (!abbr) continue;
      const blocks = (Array.isArray(v) ? v : [v]).filter((b) => b?.start && b?.end).map((b) => ({ start: String(b.start), end: String(b.end) }));
      if (blocks.length) schedule[abbr] = blocks;
    }
    cg.bookings.push({
      bookingId: doc.id,
      jobTitle: String(d.jobTitle || d.caregiverName || "Booking"),
      address: String(d.address ?? ""),
      schedule,
    });
  }
  return out;
}

// ── The modal's availability picture for one caregiver ────────────────────────

export interface CaregiverAvailability {
  // The caregiver's self-reported weekly availability, abbr → ranges (the
  // modal's getDaySlots). Empty object = none on file.
  weeklyAvail: Record<string, MinuteRange[]>;
  // Every shift this caregiver has with ANY client, abbr → ranges
  // (caregiver_booked_slots, maintained by onShiftWritten). The modal removes
  // these times from the picker entirely.
  bookedSlots: Record<string, MinuteRange[]>;
  // This client's own scheduled shifts with this caregiver, abbr → blocks
  // (the modal's cgShiftBlocks).
  ownShiftBlocks: Record<string, TimeBlock[]>;
}

export async function loadCaregiverAvailability(clientId: string, caregiverId: string): Promise<CaregiverAvailability> {
  const today = businessTodayStr();
  const [profSnap, bookedSnap, shiftsSnap] = await Promise.all([
    db.collection("publicCaregiverProfiles").doc(caregiverId).get().catch(() => null),
    db.collection("caregiver_booked_slots").doc(caregiverId).get().catch(() => null),
    db.collection("shifts").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).where("status", "==", "scheduled").get(),
  ]);

  const weeklyAvail: Record<string, MinuteRange[]> = {};
  const rawWeekly = (profSnap?.data()?.weeklyAvailability ?? {}) as Record<string, unknown[]>;
  for (const abbr of DAY_ABBRS) {
    const raw = (rawWeekly[ABBR_TO_FULL[abbr].toLowerCase()] ?? rawWeekly[abbr] ?? []) as unknown[];
    const ranges: MinuteRange[] = [];
    for (const sl of raw) {
      let s: number, e: number;
      if (typeof sl === "string") {
        const bm = BLOCK_MINS[sl.toLowerCase()]; if (!bm) continue; s = bm.s; e = bm.e;
      } else {
        const o = sl as { start?: string; end?: string };
        const ss = bookingTimeToMinutes(o?.start), ee = bookingTimeToMinutes(o?.end);
        if (ss === null) continue; s = ss; e = ee ?? 0;
      }
      if (e > 0 && e <= s) { ranges.push({ s, e: 1440 }); ranges.push({ s: 0, e }); }
      else ranges.push({ s, e: e > 0 ? e : 1440 });
    }
    if (ranges.length) weeklyAvail[abbr] = ranges;
  }

  const bookedSlots: Record<string, MinuteRange[]> = {};
  const rawSlots = (bookedSnap?.data()?.slots ?? {}) as Record<string, MinuteRange[]>;
  for (const [k, v] of Object.entries(rawSlots)) {
    const abbr = normDayAbbr(k);
    if (abbr && Array.isArray(v)) bookedSlots[abbr] = v.filter((r) => typeof r?.s === "number" && typeof r?.e === "number");
  }

  const ownShiftBlocks: Record<string, TimeBlock[]> = {};
  for (const d of shiftsSnap.docs) {
    const s = d.data();
    if (!s.date || String(s.date) < today || !s.startTime || !s.endTime) continue;
    const abbr = DAY_ABBRS[new Date(`${s.date}T12:00:00Z`).getUTCDay()];
    const list = (ownShiftBlocks[abbr] ??= []);
    if (!list.some((b) => b.start === s.startTime && b.end === s.endTime)) list.push({ start: String(s.startTime), end: String(s.endTime) });
  }
  return { weeklyAvail, bookedSlots, ownShiftBlocks };
}

// ── The modal's two blocking rules + its one warning ──────────────────────────

export interface BlockCheck {
  // Hard (the site's overlappingDays): overlaps a block already on this
  // booking's schedule or one of this client's scheduled shifts with the
  // caregiver.
  overlap: TimeBlock | null;
  // Hard (the site's picker removes these times): the caregiver is booked
  // with someone at that time.
  busy: MinuteRange | null;
  // Soft (the site's orange "outside preferred" hint): the caregiver has a
  // weekly availability on file and this block falls outside it.
  outsidePreferred: boolean;
}

export function checkVisitBlock(
  day: DayAbbr, block: TimeBlock, booking: VisitRequestBooking | undefined, avail: CaregiverAvailability,
): BlockCheck {
  const r = blockToRange(block);
  if (!r) return { overlap: null, busy: null, outsidePreferred: false };
  const existing: TimeBlock[] = [...(booking?.schedule[day] ?? []), ...(avail.ownShiftBlocks[day] ?? [])];
  const overlap = existing.find((b) => { const br = blockToRange(b); return br ? r.s < br.e && r.e > br.s : false; }) ?? null;
  const busy = (avail.bookedSlots[day] ?? []).find((b) => r.s < b.e && r.e > b.s) ?? null;
  let outsidePreferred = false;
  const hasWeekly = Object.keys(avail.weeklyAvail).length > 0;
  if (hasWeekly) {
    const slots = avail.weeklyAvail[day] ?? [];
    const inSlot = (m: number) => slots.some((sl) => m >= sl.s && m <= sl.e);
    outsidePreferred = slots.length === 0 || !inSlot(r.s) || !inSlot(r.e);
  }
  return { overlap, busy, outsidePreferred };
}

export function describeRange(r: MinuteRange): string {
  const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${formatHHMMForDisplay(hhmm(r.s))}–${formatHHMMForDisplay(hhmm(r.e))}`;
}

// ── The write (the site's handleAddShift) ─────────────────────────────────────

export async function createScheduleAmendment(args: {
  clientId: string;
  bookingRequestId: string | null;
  caregiverId: string;
  caregiverName: string;
  newDays: Record<string, TimeBlock[]>;
  notes: string;
  startDate: string;
  endDate: string | null;
  ongoing: boolean;
  source: string;
}): Promise<{ amendmentId: string }> {
  const clientSnap = await db.collection("users").doc(args.clientId).get().catch(() => null);
  const u = clientSnap?.data() ?? {};
  const clientName = [u.firstName, u.lastName].filter(Boolean).join(" ") || String(u.name ?? u.displayName ?? "");
  const amRef = db.collection("booking_amendments").doc();
  await amRef.set({
    bookingRequestId: args.bookingRequestId,
    clientId:         args.clientId,
    clientName,
    caregiverId:      args.caregiverId,
    caregiverName:    args.caregiverName,
    status:           "pending",
    type:             "add_recurring_days",
    newDays:          args.newDays,
    notes:            args.notes,
    startDate:        args.startDate,
    endDate:          args.ongoing ? null : args.endDate,
    ongoing:          args.ongoing,
    createdAt:        admin.firestore.FieldValue.serverTimestamp(),
  });
  // onBookingAmendmentWrite (notificationTriggers.ts) texts + notifies the
  // caregiver on this write — same as the site; no manual send.
  logAudit({ eventType: "amendment_requested", userId: args.clientId, data: { source: args.source, amendmentId: amRef.id } }).catch(() => {});
  return { amendmentId: amRef.id };
}
