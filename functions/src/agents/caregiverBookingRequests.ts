// The caregiver Bookings page, REQUESTS tab, as Evia texts it — a twin of
// components/caregiver/CaregiverBookingsPage.tsx (RequestCard + handlers),
// 2026-09-27. Same collection, same query, same fields, same writes:
//   • query:   booking_requests where caregiverId == uid, createdAt desc,
//              status === 'pending' filtered client-side (the page does the same)
//   • card:    the collapsed card = one numbered entry; "View full details" =
//              the details text (care recipients, care plan, lifestyle,
//              emergency contact, notes)
//   • Accept:  {status:'accepted', updatedAt} — shifts come from onBookingAccepted
//   • Decline: {status:'declined', updatedAt} — after the page's confirm
//   • gate:    Accept is replaced by Activate Membership / Complete
//              Verification while blocked; Decline is never gated
//   • toasts:  "Booking request accepted!" / "Request declined"
// Nothing else: the family is told by onBookingRequestWrite / onBookingAccepted,
// exactly as when the button is clicked on the site.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";

const db = admin.firestore();

type Doc = Record<string, unknown>;
export interface ShiftBlock { start: string; end: string; label?: string }
export interface RecipientLifestyle {
  favoriteActivities?: string[]; favoriteActivitiesOther?: string;
  helpActivities?: string[]; helpActivitiesOther?: string;
  entertainment?: string[]; entertainmentOther?: string;
  enjoysConversation?: boolean | null; prefersQuiet?: boolean | null;
  familyInArea?: boolean | null; familyVisitFreq?: string;
  friendsVisitors?: boolean | null; friendsVisitFreq?: string;
  hasAppointments?: boolean | null; appointmentsDetails?: string;
}
export interface CareRecipient {
  name: string; relationship?: string; age?: number | string; photoURL?: string;
  careNeeds?: string[]; careNeedDetails?: Record<string, string[]>; lifestyle?: RecipientLifestyle | null;
  notes?: string;
}
export interface BookingRequest {
  id: string;
  clientId: string;
  clientName: string;
  clientRating?: number | null;
  careRecipients?: Array<CareRecipient | string>;
  schedule?: {
    days?: string[]; startDate?: string; endDate?: string; ongoing?: boolean;
    dayShiftTimes?: Record<string, ShiftBlock[]>;
  };
  address?: string;
  rate?: number | null;
  lifestylePreferences?: string[];
  emergencyContact?: { name?: string; phone?: string; relationship?: string };
  notes?: string;
  status: string;
  createdAt?: unknown;
}

// ── The page's own helpers (CaregiverBookingsPage.tsx), verbatim in behavior ──
const ALL_DAYS_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** fmtDate: "Sat, Sep 27, 2026" (weekday short, month short, day, year). */
export function fmtDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return `${ALL_DAYS_ORDER[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}
function parseMinutes(t: string): number {
  const nextDay = t.startsWith("~");
  const raw = nextDay ? t.slice(1) : t;
  const [h, m] = raw.split(":").map(Number);
  return (nextDay ? 1440 : 0) + (h || 0) * 60 + (m || 0);
}
export function calcShiftMins(start: string, end: string): number {
  if (!start || !end) return 0;
  const diff = parseMinutes(end) - parseMinutes(start);
  return diff > 0 ? diff : 0;
}
export function fmtHours(mins: number): string {
  if (mins === 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
/** fmtTime: "9:00 AM", "1:30 PM", "12:00 AM (next day)" for a "~" prefix. */
export function fmtTime(t?: string): string {
  if (!t) return "";
  const nextDay = t.startsWith("~");
  const raw = nextDay ? t.slice(1) : t;
  const [hs, ms] = raw.split(":");
  const h = Number(hs), m = Number(ms ?? 0);
  if (!Number.isFinite(h)) return raw;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const out = `${h12}:${String(Number.isFinite(m) ? m : 0).padStart(2, "0")} ${suffix}`;
  return nextDay ? `${out} (next day)` : out;
}
function sortBlocks<T extends { start: string }>(blocks: T[]): T[] {
  return [...blocks].sort((a, b) => parseMinutes(a.start) % 1440 - parseMinutes(b.start) % 1440);
}

export function normalizeBookingRequest(id: string, d: Doc): BookingRequest {
  // The document id wins over any stored `id` field.
  return { ...(d as Omit<BookingRequest, "id">), id, status: String(d.status ?? "") };
}

// ── The collapsed card (the "Quick info row") ────────────────────────────────
export function requestCardLines(req: BookingRequest): string[] {
  const out: string[] = [];
  const rating = typeof req.clientRating === "number" ? ` · ${req.clientRating.toFixed(1)} client rating` : "";
  const status = req.status ? ` · ${req.status.charAt(0).toUpperCase()}${req.status.slice(1)}` : "";
  out.push(`${req.clientName || "A family"}${rating}${status}`);
  const sch = req.schedule ?? {};
  const dayShiftTimes = sch.dayShiftTimes;
  const orderedDays = dayShiftTimes ? ALL_DAYS_ORDER.filter((d) => dayShiftTimes[d]?.some((b) => b.start && b.end)) : [];
  const singleDay = !sch.ongoing && !!sch.startDate && sch.startDate === sch.endDate;
  if (sch.startDate) out.push(`${singleDay ? "One visit · " : "Starts "}${fmtDate(sch.startDate)}`);
  if (!singleDay && (sch.ongoing || sch.endDate)) out.push(sch.ongoing ? "Ongoing" : `Ends ${fmtDate(sch.endDate!)}`);
  if (orderedDays.length > 0) {
    let total = 0;
    for (const day of orderedDays) {
      for (const b of sortBlocks(dayShiftTimes![day].filter((x) => x.start && x.end))) {
        const mins = calcShiftMins(b.start, b.end);
        total += mins;
        out.push(`${day} ${fmtTime(b.start)} – ${fmtTime(b.end)}${mins > 0 ? ` (${fmtHours(mins)})` : ""}`);
      }
    }
    if (total > 0 && !singleDay) out.push(`${fmtHours(total)} / week`);
  } else if (sch.days?.length) {
    out.push(sch.days.join(", "));
  }
  if (req.address) {
    out.push(req.address);
    if (req.lifestylePreferences?.length) out.push(req.lifestylePreferences.join(" · "));
  }
  if (req.rate != null) out.push(`$${req.rate}/hr · Card (agreed rate)`);
  return out;
}

// ── "View full details" ──────────────────────────────────────────────────────
export function requestDetailsLines(req: BookingRequest): string[] {
  const out: string[] = [];
  const recipients = req.careRecipients ?? [];
  if (recipients.length > 0) {
    out.push(`Care Recipient${recipients.length > 1 ? "s" : ""}`);
    recipients.forEach((r, i) => {
      const obj = typeof r === "string" ? { name: r } as CareRecipient : r;
      const meta = [obj.relationship, obj.age ? `Age ${obj.age}` : ""].filter(Boolean).join(" · ");
      out.push(`${i > 0 ? "\n" : ""}${obj.name}${meta ? ` — ${meta}` : ""}`);
      // The family's note for this recipient (2026-09-27: the page shows it under the header now).
      if (typeof obj.notes === "string" && obj.notes.trim()) out.push(`Notes: ${obj.notes.trim()}`);
      const needs = obj.careNeeds ?? [];
      if (needs.length) {
        out.push("Care Plan");
        for (const n of needs) {
          const subs = obj.careNeedDetails?.[n] ?? [];
          out.push(`• ${n}${subs.length ? `: ${subs.join(", ")}` : ""}`);
        }
      }
      const ls = obj.lifestyle ?? null;
      if (ls) {
        const yesNo: Array<[string, boolean | null | undefined]> = [
          ["Enjoys conversation", ls.enjoysConversation], ["Prefers quiet", ls.prefersQuiet],
          ["Family in area", ls.familyInArea], ["Friends or visitors", ls.friendsVisitors], ["Has appointments", ls.hasAppointments],
        ];
        const bools = yesNo.filter(([, v]) => v !== null && v !== undefined);
        const has = (ls.favoriteActivities?.length ?? 0) > 0 || (ls.helpActivities?.length ?? 0) > 0
          || (ls.entertainment?.length ?? 0) > 0 || bools.some(([, v]) => v === true);
        if (has) {
          out.push("Lifestyle & Preferences");
          if (ls.favoriteActivities?.length) out.push(`Enjoys: ${ls.favoriteActivities.join(", ")}${ls.favoriteActivitiesOther ? ` · Other: ${ls.favoriteActivitiesOther}` : ""}`);
          if (ls.helpActivities?.length) out.push(`Needs help with: ${ls.helpActivities.join(", ")}${ls.helpActivitiesOther ? ` · Other: ${ls.helpActivitiesOther}` : ""}`);
          if (ls.entertainment?.length) out.push(`Entertainment: ${ls.entertainment.join(", ")}${ls.entertainmentOther ? ` · Other: ${ls.entertainmentOther}` : ""}`);
          for (const [label, v] of bools) {
            out.push(`${label}: ${v === true ? "Yes" : "No"}`);
            if (label === "Family in area" && v === true && ls.familyVisitFreq) out.push(`Family visit frequency: ${ls.familyVisitFreq}`);
            if (label === "Friends or visitors" && v === true && ls.friendsVisitFreq) out.push(`Friends visit frequency: ${ls.friendsVisitFreq}`);
          }
          if (ls.hasAppointments === true && ls.appointmentsDetails) out.push(`Appointments: ${ls.appointmentsDetails}`);
        }
      }
    });
  }
  if (req.emergencyContact?.name) {
    out.push("", "Emergency Contact",
      `${req.emergencyContact.name}${req.emergencyContact.relationship ? ` (${req.emergencyContact.relationship})` : ""}${req.emergencyContact.phone ? ` · ${req.emergencyContact.phone}` : ""}`);
  }
  if (req.notes) out.push("", "Notes", req.notes);
  return out;
}

// ── The tab's second card: a pending schedule change (booking_amendments) ────
export interface Amendment {
  id: string;
  bookingRequestId: string | null;
  clientId: string; clientName: string;
  caregiverId: string; caregiverName: string;
  status: string;
  newDays: Record<string, ShiftBlock[]>;
  notes: string;
  startDate?: string; endDate?: string | null; ongoing?: boolean;
  createdAt?: unknown;
}

/** The tab's query: booking_amendments where caregiverId ==, status == 'pending' (no order — the page has none). */
export async function loadPendingAmendments(caregiverId: string): Promise<Amendment[]> {
  const snap = await db.collection("booking_amendments").where("caregiverId", "==", caregiverId).where("status", "==", "pending").get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Amendment, "id">), id: d.id, status: String(d.data().status ?? "") }));
}

/** The amendment card: name · "Schedule change request", the days, Starts…, notes. */
export function amendmentCardLines(a: Amendment): string[] {
  const out: string[] = [`${a.clientName || "Client"} · Schedule change request`];
  for (const day of ALL_DAYS_ORDER.filter((d) => a.newDays?.[d]?.length)) {
    out.push(`${day} · ${a.newDays[day].map((b) => `${fmtTime(b.start)} – ${fmtTime(b.end)}`).join(", ")}`);
  }
  out.push(`${a.startDate ? `Starts ${fmtDate(a.startDate)}` : "Starts immediately"}${a.ongoing ? " · Ongoing" : a.endDate ? ` → ${fmtDate(a.endDate)}` : ""}`);
  if (a.notes) out.push(a.notes);
  return out;
}

export type RequestsTabItem = { kind: "request"; req: BookingRequest } | { kind: "amendment"; amendment: Amendment };

export const EMPTY_TEXT = "No pending requests. When a family sends you a booking request, it will appear here. Accepted bookings move to Active Bookings.";
export const PAGE_SIZE = 2;
// Founder (2026-09-27): no "details" step over text — every request is texted
// whole (the card AND what "View full details" expands to).
const LIST_FOOTER = `Reply "accept 1" or "decline 1".`;
export type GateLabel = "membership" | "background" | null;
const GATE_FOOTER = (gate: GateLabel, n: number) =>
  gate === "membership" ? `To accept you'll need to: Activate Membership. You can still reply "decline ${n}".`
  : `To accept you'll need to: Complete Verification. You can still reply "decline ${n}".`;

export interface LastRequestList { at: string; items: Array<{ number: number; kind?: "request" | "amendment"; bookingRequestId: string; clientName: string }>; offset?: number; total?: number }

/** The tab's query: caregiverId ==, createdAt desc, then status === 'pending' like the page. */
export async function loadPendingBookingRequests(caregiverId: string): Promise<BookingRequest[]> {
  const snap = await db.collection("booking_requests").where("caregiverId", "==", caregiverId).orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => normalizeBookingRequest(d.id, d.data() as Doc)).filter((r) => r.status === "pending");
}

/** The tab in page order: booking requests, then pending schedule changes. */
export function requestsTabItems(reqs: BookingRequest[], amendments: Amendment[]): RequestsTabItem[] {
  return [...reqs.map((req) => ({ kind: "request" as const, req })), ...amendments.map((amendment) => ({ kind: "amendment" as const, amendment }))];
}

export function requestListText(input: BookingRequest[] | RequestsTabItem[], opts: { from?: number; gate?: GateLabel } = {}): { text: string; shown: RequestsTabItem[]; remaining: number } {
  const items: RequestsTabItem[] = input.map((x) => ("kind" in x ? x : { kind: "request" as const, req: x as BookingRequest }));
  const from = opts.from ?? 0;
  if (items.length === 0) return { text: EMPTY_TEXT, shown: [], remaining: 0 };
  const shown = items.slice(from, from + PAGE_SIZE);
  const remaining = Math.max(0, items.length - (from + shown.length));
  if (shown.length === 0) return { text: "That's all your pending requests.", shown, remaining: 0 };
  const blocks = shown.map((it, i) => {
    if (it.kind === "amendment") {
      const [head, ...rest] = amendmentCardLines(it.amendment);
      return [`${from + i + 1}. ${head}`, ...rest].join("\n");
    }
    const [head, ...rest] = requestCardLines(it.req);
    const details = requestDetailsLines(it.req);
    return [`${from + i + 1}. ${head}`, ...rest, ...(details.length ? ["", ...details] : [])].join("\n").replace(/\n{3,}/g, "\n\n");
  });
  const footer = `${opts.gate ? GATE_FOOTER(opts.gate, from + 1) : LIST_FOOTER}${remaining > 0 ? " Reply MORE to see more." : ""}`;
  return { text: [from === 0 ? "Booking requests:" : "More requests:", "", blocks.join("\n\n"), "", footer].join("\n"), shown, remaining };
}

export async function sendBookingRequestList(phone: string, chatId: string, caregiverId: string, opts: { more?: boolean; gate?: GateLabel } = {}) {
  const [reqs, amendments] = await Promise.all([loadPendingBookingRequests(caregiverId), loadPendingAmendments(caregiverId)]);
  const all = requestsTabItems(reqs, amendments);
  let prev: LastRequestList | undefined;
  if (opts.more) {
    const sess = await db.collection("agent_sessions").doc(phone).get().catch(() => null);
    prev = (sess?.data()?.lastBookingRequestList as LastRequestList | undefined) ?? undefined;
  }
  const from = opts.more && prev ? (prev.offset ?? prev.items.length) : 0;
  const { text, shown, remaining } = requestListText(all, { from, gate: opts.gate ?? null });
  await sendMessage(chatId, text);
  const newItems = shown.map((it, i) => it.kind === "amendment"
    ? { number: from + i + 1, kind: "amendment" as const, bookingRequestId: it.amendment.id, clientName: it.amendment.clientName }
    : { number: from + i + 1, kind: "request" as const, bookingRequestId: it.req.id, clientName: it.req.clientName });
  const items = from > 0 && prev ? [...prev.items.filter((it) => it.number <= from), ...newItems] : newItems;
  await db.collection("agent_sessions").doc(phone).set(
    { lastBookingRequestList: { at: new Date().toISOString(), items, offset: from + shown.length, total: all.length } satisfies LastRequestList },
    { merge: true },
  ).catch(() => {});
  return { sent: true, count: shown.length, total: all.length, remaining, items };
}

export type ResolvedRef = { kind: "request" | "amendment"; id: string };
export function resolveBookingRequestRef(session: Record<string, unknown>, ref: { bookingRequestId?: unknown; number?: unknown }): ResolvedRef | null {
  if (typeof ref.bookingRequestId === "string" && ref.bookingRequestId.trim()) return { kind: "request", id: ref.bookingRequestId.trim() };
  const n = typeof ref.number === "number" ? ref.number : (typeof ref.number === "string" ? parseInt(ref.number, 10) : NaN);
  const last = session.lastBookingRequestList as LastRequestList | undefined;
  const pick = (it?: LastRequestList["items"][number]) => (it ? { kind: it.kind ?? "request", id: it.bookingRequestId } : null);
  if (Number.isFinite(n)) return pick(last?.items?.find((it) => it.number === n));
  if (last?.items?.length === 1) return pick(last.items[0]);
  return null;
}

export async function loadBookingRequestFor(caregiverId: string, id: string): Promise<{ ok: true; req: BookingRequest } | { ok: false; reason: "not_found" | "not_yours" }> {
  const snap = await db.collection("booking_requests").doc(id).get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const req = normalizeBookingRequest(snap.id, snap.data() as Doc);
  if ((snap.data() as Doc).caregiverId !== caregiverId) return { ok: false, reason: "not_yours" };
  return { ok: true, req };
}

// ── The two buttons, the page's exact writes ─────────────────────────────────
export type RespondResult =
  | { ok: true; status: "accepted" | "declined"; toast: string; clientName: string }
  | { ok: false; reason: "not_found" | "not_yours" | "not_pending"; status?: string };

export async function respondToBookingRequest(caregiverId: string, id: string, decision: "accept" | "decline"): Promise<RespondResult> {
  const r = await loadBookingRequestFor(caregiverId, id);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.req.status !== "pending") return { ok: false, reason: "not_pending", status: r.req.status };
  const status = decision === "accept" ? "accepted" : "declined";
  await db.collection("booking_requests").doc(id).update({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, status, toast: decision === "accept" ? "Booking request accepted!" : "Request declined", clientName: r.req.clientName };
}

// ── The amendment card's buttons — CaregiverBookingsPage.handleAcceptAmendment / Decline, verbatim ──
function normDay(day: string): string { const d = day.trim(); return d.charAt(0).toUpperCase() + d.slice(1, 3).toLowerCase(); }
function nextOccurrence(startDate: string, dayName: string): string {
  const target = ALL_DAYS_ORDER.indexOf(normDay(dayName));
  if (target === -1) return startDate;
  const base = new Date(startDate + "T12:00:00");
  const diff = (target - base.getDay() + 7) % 7;
  base.setDate(base.getDate() + diff);
  return base.toISOString().split("T")[0];
}
function addDaysLocal(dateStr: string, days: number): string { const d = new Date(dateStr + "T12:00:00"); d.setDate(d.getDate() + days); return d.toISOString().split("T")[0]; }
function todayStr(): string { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; }

export type AmendmentResult =
  | { ok: true; status: "accepted"; shiftsCreated: number; toast: string }
  | { ok: true; status: "declined"; shiftsCreated: 0; toast: string }
  | { ok: false; reason: "not_found" | "not_yours" | "not_pending"; status?: string };

async function loadAmendmentFor(caregiverId: string, id: string): Promise<{ ok: true; a: Amendment; ref: FirebaseFirestore.DocumentReference } | { ok: false; reason: "not_found" | "not_yours" | "not_pending"; status?: string }> {
  const ref = db.collection("booking_amendments").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const a = { ...(snap.data() as Omit<Amendment, "id">), id: snap.id, status: String(snap.data()?.status ?? "") };
  if (a.caregiverId !== caregiverId) return { ok: false, reason: "not_yours" };
  if (a.status !== "pending") return { ok: false, reason: "not_pending", status: a.status };
  return { ok: true, a, ref };
}

/** The Decline button: {status:'declined', respondedAt} — no confirm, no toast on the page. */
export async function declineAmendment(caregiverId: string, id: string): Promise<AmendmentResult> {
  const r = await loadAmendmentFor(caregiverId, id);
  if (!r.ok) return r;
  await r.ref.update({ status: "declined", respondedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, status: "declined", shiftsCreated: 0, toast: "Declined." };
}

/** The Accept button: merge an ongoing change into the booking's schedule, create the visits for the next 4 weeks, mark accepted. */
export async function acceptAmendment(caregiverId: string, id: string): Promise<AmendmentResult> {
  const r = await loadAmendmentFor(caregiverId, id);
  if (!r.ok) return r;
  const amendment = r.a;
  const today = todayStr();
  const generateFrom = amendment.startDate && amendment.startDate >= today ? amendment.startDate : today;
  const generateTo = addDaysLocal(generateFrom, 27);
  let count = 0;
  if (amendment.bookingRequestId) {
    const bookingRef = db.collection("booking_requests").doc(amendment.bookingRequestId);
    const bookingSnap = await bookingRef.get();
    if (bookingSnap.exists) {
      const booking = bookingSnap.data() as Record<string, any>;
      const currentDST: Record<string, ShiftBlock[]> = booking.schedule?.dayShiftTimes || {};
      // Only an ongoing change joins the permanent schedule (a dated one would be re-created by the shift generator forever).
      const mergedDST: Record<string, ShiftBlock[]> = amendment.ongoing
        ? (() => { const dst = { ...currentDST }; for (const [day, blocks] of Object.entries(amendment.newDays)) { dst[day] = [...(dst[day] ?? []), ...blocks]; } return dst; })()
        : currentDST;
      if (amendment.ongoing) {
        await bookingRef.update({ "schedule.dayShiftTimes": mergedDST, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      const endDate: string | null = amendment.ongoing ? null : (amendment.endDate || (booking.schedule?.ongoing ? null : booking.schedule?.endDate || null));
      let cgPhotoURL: string | null = booking.caregiverPhotoURL || null;
      if (!cgPhotoURL && amendment.caregiverId) {
        const cgSnap = await db.collection("caregivers").doc(amendment.caregiverId).get().catch(() => null);
        const cgData = (cgSnap?.data() ?? {}) as Record<string, any>;
        cgPhotoURL = cgData.photo || cgData.profilePhoto || cgData.photoURL || cgData.imageUrl || null;
      }
      const shiftBase = {
        clientId: booking.clientId || amendment.clientId,
        clientName: booking.clientName || amendment.clientName,
        clientPhotoURL: booking.clientPhotoURL || null,
        caregiverId: amendment.caregiverId,
        caregiverName: booking.caregiverName || amendment.caregiverName,
        caregiverPhotoURL: cgPhotoURL,
        status: "scheduled",
        address: booking.address || "",
        careNeeds: booking.careNeeds || [],
        lifestylePreferences: booking.lifestylePreferences || [],
        rate: booking.rate ?? null,
        paymentMethod: booking.paymentMethod || null,
        notes: amendment.notes || booking.notes || "",
        careRecipients: booking.careRecipients || [],
        emergencyContact: booking.emergencyContact || null,
        schedule: { ...(booking.schedule || {}), dayShiftTimes: mergedDST },
        bookingRequestId: amendment.bookingRequestId,
        recurringWeekly: true,
        tasksCompleted: [] as string[],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const batch = db.batch();
      for (const [day, blocks] of Object.entries(amendment.newDays)) {
        for (const block of blocks) {
          let dateStr = nextOccurrence(generateFrom, day);
          while (dateStr <= generateTo && count < 490) {
            if (endDate && dateStr > endDate) break;
            batch.set(db.collection("shifts").doc(), { ...shiftBase, date: dateStr, startTime: block.start, endTime: block.end });
            count++;
            dateStr = addDaysLocal(dateStr, 7);
          }
        }
      }
      if (count > 0) await batch.commit();
    }
  }
  await r.ref.update({ status: "accepted", respondedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, status: "accepted", shiftsCreated: count, toast: "Schedule updated — new visits added." };
}
