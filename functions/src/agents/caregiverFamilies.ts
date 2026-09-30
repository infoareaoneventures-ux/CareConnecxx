// agents/caregiverFamilies.ts — the caregiver's My Families page
// (components/caregiver/CaregiverFamiliesPage.tsx), texted. Same two reads, same
// Active / Past rule, same card, same two buttons.
//
//   reads   booking_requests where caregiverId == me (limit 100)
//           shifts where caregiverId == me and status in scheduled / in-progress
//   Active  a booking with status accepted that still has a scheduled or
//           in-progress visit — one card per family
//   Past    the most recent cancelled / completed booking, or an accepted one
//           with no visit left — only for a family NOT in Active
//   card    name · "Active booking" / "Past booking" · $rate/hr · the schedule's
//           days · "Caring for: <recipient names>"
//   buttons View Details = the booking's care details modal (per recipient:
//           name, relationship · age, the family's note, Care Plan needs,
//           Lifestyle; then Emergency Contact); Message = the Inbox room with
//           that family (send_client_message — the family's clientId from this list).
//
// Keywords announced in the texts: FAMILIES (Active) · PAST FAMILIES · FAMILY n.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import type { CareRecipient } from "./caregiverBookingRequests";

const db = admin.firestore();
type Doc = Record<string, unknown>;
export const PAGE_SIZE = 2;
export const EMPTY_ACTIVE = "No active families yet. Families will appear here once you accept a booking request.";
export const EMPTY_PAST = "Nothing here yet. This list will fill up as you work with more families.";

export interface FamilyEntry {
  clientId: string; bookingId: string; name: string; source: "active" | "past";
  scheduleDays: string[]; rate: number | null; bookingStatus: string;
  careRecipients: Array<CareRecipient | string>;
}

const tsSeconds = (v: unknown): number => { const t = v as { seconds?: number; _seconds?: number } | undefined; return typeof t?.seconds === "number" ? t.seconds : typeof t?._seconds === "number" ? t._seconds : 0; };

/** The page's effect: both reads, then Active / Past per family, never both. */
export async function loadFamilies(caregiverId: string): Promise<{ active: FamilyEntry[]; past: FamilyEntry[] }> {
  const [bookingsSnap, shiftsSnap] = await Promise.all([
    db.collection("booking_requests").where("caregiverId", "==", caregiverId).limit(100).get(),
    db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "in", ["scheduled", "in-progress"]).get(),
  ]);
  const activeBookingIds = new Set<string>();
  for (const d of shiftsSnap.docs) { const s = d.data(); if (s.caregiverId === caregiverId && (s.status === "scheduled" || s.status === "in-progress") && s.bookingRequestId) activeBookingIds.add(String(s.bookingRequestId)); }

  const activeByClient = new Map<string, { bookingId: string; data: Doc }>();
  const pastByClient = new Map<string, { bookingId: string; data: Doc }>();
  for (const doc of bookingsSnap.docs) {
    const d = doc.data() as Doc;
    if (d.caregiverId !== caregiverId || !d.clientId) continue;
    const clientId = String(d.clientId);
    if (d.status === "accepted" && activeBookingIds.has(doc.id)) {
      activeByClient.set(clientId, { bookingId: doc.id, data: d });
    } else if (d.status === "cancelled" || d.status === "completed" || (d.status === "accepted" && !activeBookingIds.has(doc.id))) {
      const existing = pastByClient.get(clientId);
      const newTs = tsSeconds(d.updatedAt) || tsSeconds(d.createdAt);
      const oldTs = existing ? (tsSeconds(existing.data.updatedAt) || tsSeconds(existing.data.createdAt)) : -1;
      if (newTs > oldTs) pastByClient.set(clientId, { bookingId: doc.id, data: d });
    }
  }
  const entry = (bookingId: string, data: Doc, source: "active" | "past"): FamilyEntry => {
    const sch = (data.schedule ?? {}) as { dayShiftTimes?: Record<string, unknown>; days?: string[] };
    const days = sch.dayShiftTimes && typeof sch.dayShiftTimes === "object" ? Object.keys(sch.dayShiftTimes) : (sch.days ?? []);
    return {
      clientId: String(data.clientId), bookingId, name: String(data.clientName || "Family"), source,
      scheduleDays: days, rate: typeof data.rate === "number" ? data.rate : null, bookingStatus: String(data.status ?? ""),
      careRecipients: (Array.isArray(data.careRecipients) ? data.careRecipients : []) as Array<CareRecipient | string>,
    };
  };
  const active = [...activeByClient.entries()].map(([, v]) => entry(v.bookingId, v.data, "active"));
  const past = [...pastByClient.entries()].filter(([clientId]) => !activeByClient.has(clientId)).map(([, v]) => entry(v.bookingId, v.data, "past"));
  return { active, past };
}

const recipientName = (r: CareRecipient | string): string => (typeof r === "string" ? r : (r as { firstName?: string }).firstName || r.name || "Recipient");

/** One card, numbered across the tab. */
export function familyCardLines(n: number, f: FamilyEntry): string[] {
  const out = [`${n}. ${f.name} · ${f.source === "active" ? "Active booking" : "Past booking"}`];
  if (f.rate) out.push(`$${f.rate}/hr`);
  if (f.scheduleDays.length) out.push(f.scheduleDays.join(" · "));
  if (f.careRecipients.length) out.push(`Caring for: ${f.careRecipients.map(recipientName).join(", ")}`);
  return out;
}

export interface LastFamilyList { at: string; items: Array<{ number: number; clientId: string; bookingId: string; name: string; source: "active" | "past" }>; tab: "active" | "past"; offset?: number; total?: number }

export function familiesText(list: FamilyEntry[], opts: { tab: "active" | "past"; query?: string; from?: number }): { text: string; items: LastFamilyList["items"]; shown: number; remaining: number } {
  const q = (opts.query ?? "").trim().toLowerCase();
  const filtered = q ? list.filter((f) => f.name.toLowerCase().includes(q)) : list;
  const from = opts.from ?? 0;
  const items: LastFamilyList["items"] = filtered.map((f, i) => ({ number: i + 1, clientId: f.clientId, bookingId: f.bookingId, name: f.name, source: f.source }));
  if (filtered.length === 0) return { text: q ? `No ${opts.tab} families match "${opts.query!.trim()}".` : (opts.tab === "active" ? EMPTY_ACTIVE : EMPTY_PAST), items, shown: 0, remaining: 0 };
  const shown = filtered.slice(from, from + PAGE_SIZE);
  const remaining = Math.max(0, filtered.length - (from + shown.length));
  const blocks = shown.map((f, i) => familyCardLines(from + i + 1, f).join("\n"));
  const header = `${opts.tab === "active" ? `My Families · Active (${filtered.length})` : "My Families · Past"}${q ? ` · "${opts.query!.trim()}"` : ""}`;
  const footer = [
    `Reply FAMILY n for care details. To message a family, just tell me what to send.`,
    opts.tab === "active" ? "Reply PAST FAMILIES for past families." : "Reply FAMILIES for active families.",
    remaining > 0 ? "Reply MORE for more." : "",
  ].filter(Boolean).join(" ");
  return { text: [header, "", blocks.join("\n\n"), "", footer].join("\n"), items, shown: shown.length, remaining };
}

export async function sendCaregiverFamilies(phone: string, chatId: string, caregiverId: string, opts: { tab?: "active" | "past"; query?: string; more?: boolean } = {}) {
  const { active, past } = await loadFamilies(caregiverId);
  let tab = opts.tab ?? "active"; let from = 0; let query = opts.query;
  if (opts.more) {
    const prev = ((await db.collection("agent_sessions").doc(phone).get().catch(() => null))?.data()?.lastFamilyList ?? null) as LastFamilyList | null;
    if (prev) { tab = prev.tab; from = prev.offset ?? 0; query = query ?? (prev as { query?: string }).query; }
  }
  const r = familiesText(tab === "past" ? past : active, { tab, query, from });
  await sendMessage(chatId, r.text);
  await db.collection("agent_sessions").doc(phone).set({ lastFamilyList: { at: new Date().toISOString(), items: r.items, tab, offset: from + r.shown, total: r.items.length, ...(query ? { query } : {}) } }, { merge: true }).catch(() => {});
  return { sent: true as const, tab, count: r.shown, total: r.items.length, remaining: r.remaining, families: r.items };
}

export function resolveFamilyRef(session: Record<string, unknown>, ref: { number?: unknown; clientId?: unknown }): LastFamilyList["items"][number] | null {
  const list = session.lastFamilyList as LastFamilyList | undefined;
  if (typeof ref.clientId === "string" && ref.clientId) return list?.items.find((i) => i.clientId === ref.clientId) ?? { number: 0, clientId: ref.clientId, bookingId: "", name: "", source: "active" };
  const n = Number(ref.number);
  return list?.items.find((i) => i.number === n) ?? null;
}

/** The View Details modal: per recipient — name, relationship · age, the family's note, Care Plan needs, Lifestyle — then Emergency Contact. */
export function familyDetailsText(name: string, booking: Doc | null): string {
  if (!booking) return `${name} — No details available.`;
  const lines = [`${name} — Care details`];
  const recipients = (Array.isArray(booking.careRecipients) ? booking.careRecipients : []) as Array<CareRecipient | string>;
  recipients.forEach((raw) => {
    const r = (typeof raw === "string" ? { name: raw } : raw) as CareRecipient & { firstName?: string };
    const meta = [r.relationship, r.age ? `Age ${r.age}` : ""].filter(Boolean).join(" · ");
    lines.push("", `${r.firstName || r.name}${meta ? ` — ${meta}` : ""}`);
    if (typeof r.notes === "string" && r.notes.trim()) lines.push(`"${r.notes.trim()}"`);
    if (r.careNeeds?.length) lines.push("Care Plan", ...r.careNeeds.map((n) => `• ${n}`));
    const ls = r.lifestyle ?? null;
    if (ls) {
      const bools: Array<[string, boolean | null | undefined]> = [["Enjoys conversation", ls.enjoysConversation], ["Prefers quiet", ls.prefersQuiet], ["Family in area", ls.familyInArea], ["Friends or visitors", ls.friendsVisitors], ["Has appointments", ls.hasAppointments]];
      const set = bools.filter(([, v]) => v !== null && v !== undefined);
      if ((ls.favoriteActivities?.length ?? 0) || (ls.helpActivities?.length ?? 0) || (ls.entertainment?.length ?? 0) || set.length) {
        lines.push("Lifestyle");
        if (ls.favoriteActivities?.length) lines.push(`Enjoys: ${ls.favoriteActivities.join(", ")}${ls.favoriteActivitiesOther ? ` · Other: ${ls.favoriteActivitiesOther}` : ""}`);
        if (ls.helpActivities?.length) lines.push(`Needs help with: ${ls.helpActivities.join(", ")}${ls.helpActivitiesOther ? ` · Other: ${ls.helpActivitiesOther}` : ""}`);
        if (ls.entertainment?.length) lines.push(`Entertainment: ${ls.entertainment.join(", ")}${ls.entertainmentOther ? ` · Other: ${ls.entertainmentOther}` : ""}`);
        for (const [label, v] of set) {
          lines.push(`${label}: ${v === true ? "Yes" : "No"}`);
          if (label === "Family in area" && v === true && ls.familyVisitFreq) lines.push(`Family visit frequency: ${ls.familyVisitFreq}`);
          if (label === "Friends or visitors" && v === true && ls.friendsVisitFreq) lines.push(`Friends visit frequency: ${ls.friendsVisitFreq}`);
        }
        if (ls.hasAppointments === true && ls.appointmentsDetails) lines.push(`Appointments: ${ls.appointmentsDetails}`);
      }
    }
  });
  const ec = booking.emergencyContact as { name?: string; relationship?: string; phone?: string } | undefined;
  if (ec?.name) lines.push("", "Emergency Contact", `${ec.name}${ec.relationship ? ` · ${ec.relationship}` : ""}${ec.phone ? ` · ${ec.phone}` : ""}`);
  if (lines.length === 1) lines.push("No details available.");
  return lines.join("\n");
}

export async function sendFamilyDetails(chatId: string, caregiverId: string, item: { bookingId: string; name: string; clientId: string }): Promise<boolean> {
  let booking: Doc | null = null;
  if (item.bookingId) {
    const snap = await db.collection("booking_requests").doc(item.bookingId).get();
    if (snap.exists && snap.data()?.caregiverId === caregiverId) booking = snap.data() as Doc;
  }
  if (!booking) {
    // No id from a list — the family's most recent booking with this caregiver.
    const { active, past } = await loadFamilies(caregiverId);
    const f = [...active, ...past].find((x) => x.clientId === item.clientId);
    if (f) { const snap = await db.collection("booking_requests").doc(f.bookingId).get(); booking = snap.exists ? (snap.data() as Doc) : null; item = { ...item, name: item.name || f.name }; }
  }
  if (!booking) { await sendMessage(chatId, "That family isn't on your My Families page."); return false; }
  await sendMessage(chatId, familyDetailsText(item.name || String(booking.clientName || "Family"), booking));
  return true;
}

// ── Keywords (routeCaregiver): FAMILIES · PAST FAMILIES · FAMILY n ──────────
export async function handleFamiliesKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim(); const upper = raw.toUpperCase().replace(/\s+/g, " ");
  if (upper === "FAMILIES" || upper === "MY FAMILIES" || upper === "ACTIVE FAMILIES") { await sendCaregiverFamilies(phone, chatId, caregiverId, { tab: "active" }); return "handled"; }
  if (upper === "PAST FAMILIES") { await sendCaregiverFamilies(phone, chatId, caregiverId, { tab: "past" }); return "handled"; }
  const m = /^FAMILY\s+(\d+)$/i.exec(raw);
  if (m) {
    const ref = resolveFamilyRef(session, { number: Number(m[1]) });
    if (!ref) { await sendMessage(chatId, `I don't have a family ${m[1]} on the last list — reply FAMILIES to see them.`); return "handled"; }
    await sendFamilyDetails(chatId, caregiverId, ref); return "handled";
  }
  return "passthrough";
}
