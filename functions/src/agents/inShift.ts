// agents/inShift.ts — the caregiver Bookings page's per-visit buttons, over
// text (2026-09-28): Start Shift, the Tasks checklist, the visit-notes box and
// End, exactly as components/caregiver/CaregiverBookingsPage.tsx writes them.
//
//   Start Shift  — only a SCHEDULED visit, not overdue, from 15 minutes before
//                  its start: {status:'in-progress', startedAt, updatedAt}
//   Tasks        — only while IN PROGRESS; one task or a whole care-need row;
//                  writes the full `tasksCompleted` array like the page
//   Visit notes  — only while IN PROGRESS; appends {at, text, by:'caregiver'}
//                  to `notesLog` (the family sees it live)
//   End          — only while IN PROGRESS; {status:'completed', completedAt,
//                  updatedAt} + the optional closing note (`completionNotes`)
//
// One implementation behind the MCP tools (start_shift / update_shift_task /
// add_visit_note / complete_shift) AND the texted keywords START / DONE n /
// UNDO n / NOTE … / TASKS / FINISH, so both paths write and say the same thing.
// (FINISH, not END: END is a carrier opt-out word — live 2026-09-28 a caregiver
// texting END to close a visit was unsubscribed from Evia instead.) The family's
// texts on start / end come from onShiftStatusChanged, same as the site.
//
// 2026-10-11: the checks and the writes behind Start and End live in
// shifts/visitActions.ts — ONE server implementation the site reaches through
// the visit_action_requests queue and Evia calls here. The gate (membership +
// background), the 15-minute window, one visit at a time and the status
// transitions are enforced THERE; this file keeps the texts, the "which
// visit?" resolution and the keyword protocol.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { businessTodayStr, DEFAULT_TZ } from "../utils/scheduledTime";
import { isShiftOverdue } from "./shiftReschedule";
import { type CareRecipient } from "./caregiverBookingRequests";
import { getAppUrl } from "../config/appUrl";
import { answerMidFlow } from "./stepHandler";
import { textCaregiverGateBlock } from "./caregiverAccessGate";
import {
  startVisit as startVisitShared, endVisit as endVisitShared,
  START_WINDOW_MINUTES, startsInMinutes, visitLine, finishFirstText,
} from "../shifts/visitActions";

const db = admin.firestore();
export { START_WINDOW_MINUTES, startsInMinutes, visitLine, finishFirstText };

// One visit at a time (founder, 2026-10-07: "they shouldn't start two shifts at the same time") — the twin of
// utils/shiftStart.ts on the site's three Start Shift buttons. Same words (finishFirstText is the shared rule's).
export const FINISH_FIRST_LINE = "Finish your current visit first (text FINISH), then START this one.";

/** The real Bookings page opened at this visit (login required — the link carries no secret). */
export const visitPageLink = (shiftId: string) => `${getAppUrl()}/caregiver/bookings?tab=active&visit=${encodeURIComponent(shiftId)}`;

type Doc = Record<string, unknown>;
export interface TaskItem { number: number; key: string; label: string; done: boolean; recipientIndex: number; recipientName: string }

/** The page's task keys: `${recipientIndex}_${need}` or `${recipientIndex}_${need}_${subtask}`; a need with no subtasks is one task. Numbers run across recipients so DONE n is never ambiguous. */
export function taskItems(shift: Doc): TaskItem[] {
  const recipients = (Array.isArray(shift.careRecipients) ? shift.careRecipients : []) as Array<CareRecipient | string>;
  const done = new Set(Array.isArray(shift.tasksCompleted) ? (shift.tasksCompleted as string[]) : []);
  const out: TaskItem[] = [];
  recipients.forEach((r, ri) => {
    if (typeof r === "string") return;
    const needs = r.careNeeds ?? [];
    const det = r.careNeedDetails ?? {};
    for (const need of needs) {
      const subs = det[need] ?? [];
      if (subs.length === 0) {
        const key = `${ri}_${need}`;
        out.push({ number: out.length + 1, key, label: need, done: done.has(key), recipientIndex: ri, recipientName: String(r.name ?? "") });
      } else {
        for (const sub of subs) {
          const key = `${ri}_${need}_${sub}`;
          out.push({ number: out.length + 1, key, label: `${need} — ${sub}`, done: done.has(key), recipientIndex: ri, recipientName: String(r.name ?? "") });
        }
      }
    }
  });
  return out;
}

/**
 * The page's Tasks panel as text: one block per care recipient — their name
 * (relationship), their note when asked for, then their numbered tasks
 * (founder 2026-09-29: "the care recipient and the notes… if it's more than
 * one will it separate for each recipient").
 */
export function recipientBlocks(shift: Doc, items: TaskItem[], opts: { withNotes?: boolean; withDone?: boolean } = {}): string[] {
  const recipients = (Array.isArray(shift.careRecipients) ? shift.careRecipients : []) as Array<CareRecipient | string>;
  const out: string[] = [];
  recipients.forEach((r, ri) => {
    if (typeof r === "string") return;
    if (out.length) out.push("");
    out.push(`${r.name}${r.relationship ? ` (${r.relationship})` : ""}`);
    if (opts.withNotes && typeof r.notes === "string" && r.notes.trim()) out.push(`Note: ${r.notes.trim()}`);
    const mine = items.filter((t) => t.recipientIndex === ri);
    if (mine.length === 0) { out.push("Tasks: none"); return; }
    out.push("Tasks:", ...mine.map((t) => `${t.number}. ${t.label}${opts.withDone && t.done ? " — done" : ""}`));
  });
  return out;
}

/**
 * The visit-level notes at the top of the start text: the booking's own note
 * (booking_requests.notes) and the visit's own note when it differs (the
 * schedule-change note on a visit that request created). Each recipient's
 * note is in that recipient's block (recipientBlocks).
 */
export function noteLines(shift: Doc, bookingNote?: string | null): string[] {
  const out: string[] = [];
  const visitNote = typeof shift.notes === "string" && shift.notes.trim() ? shift.notes.trim() : "";
  const booking = typeof bookingNote === "string" && bookingNote.trim() ? bookingNote.trim() : "";
  if (booking) out.push(`Booking note: ${booking}`);
  if (visitNote && visitNote !== booking) out.push(`${booking ? "Visit note" : "Note"}: ${visitNote}`);
  return out;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit" });
}

export type VisitLoad = { ok: true; id: string; shift: Doc; ref: FirebaseFirestore.DocumentReference } | { ok: false; reason: "not_found" | "not_yours" | "none_today" | "ambiguous"; message: string; candidates?: Array<{ shiftId: string; line: string }> };

/**
 * Which visit they mean: the given shiftId, else today's visit — the one in
 * progress, or the scheduled one (for START, the one whose window is open,
 * else the next). Two candidates → ask.
 */
export async function resolveVisit(caregiverId: string, shiftId: unknown, want: "start" | "in_progress"): Promise<VisitLoad> {
  if (typeof shiftId === "string" && shiftId) {
    const snap = await db.collection("shifts").doc(shiftId).get();
    if (!snap.exists) return { ok: false, reason: "not_found", message: "I can't find that visit." };
    const shift = snap.data() as Doc;
    if (shift.caregiverId !== caregiverId) return { ok: false, reason: "not_yours", message: "That visit isn't yours." };
    // The id we were given IS the visit's id — the shared write (shifts/visitActions.ts) is keyed by it.
    return { ok: true, id: snap.id || shiftId, shift, ref: snap.ref };
  }
  const today = businessTodayStr();
  const snap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("date", "==", today).get();
  const docs = snap.docs.filter((d) => d.data().caregiverId === caregiverId);
  const inProgress = docs.filter((d) => d.data().status === "in-progress");
  if (want === "in_progress" || inProgress.length > 0) {
    if (inProgress.length === 1) return { ok: true, id: inProgress[0].id, shift: inProgress[0].data() as Doc, ref: inProgress[0].ref };
    if (inProgress.length > 1) return { ok: false, reason: "ambiguous", message: "You have more than one visit in progress — which one?", candidates: inProgress.map((d) => ({ shiftId: d.id, line: visitLine(d.data() as Doc) })) };
    if (want === "in_progress") return { ok: false, reason: "none_today", message: "You don't have a visit in progress right now." };
  }
  const scheduled = docs.filter((d) => d.data().status === "scheduled" && !isShiftOverdue(d.data() as Doc))
    .sort((a, b) => String(a.data().startTime ?? "").localeCompare(String(b.data().startTime ?? "")));
  if (scheduled.length === 0) return { ok: false, reason: "none_today", message: "I don't see a visit on your schedule today." };
  const open = scheduled.filter((d) => { const m = startsInMinutes(d.data() as Doc); return m !== null && m <= START_WINDOW_MINUTES; });
  // Two visits could be meant → ask, never take the earlier one (founder 2026-09-30: the record's id decides, not a guess).
  const pool = open.length > 0 ? open : scheduled;
  if (pool.length > 1) return { ok: false, reason: "ambiguous", message: "Which visit?", candidates: pool.map((d) => ({ shiftId: d.id, line: visitLine(d.data() as Doc) })) };
  const pick = pool[0];
  return { ok: true, id: pick.id, shift: pick.data() as Doc, ref: pick.ref };
}

// ── Start Shift ──────────────────────────────────────────────────────────────
export type StartResult =
  | { ok: true; shiftId: string; alreadyStarted: boolean; text: string; tasks: TaskItem[]; startedAt: string }
  | { ok: false; reason: string; message: string; candidates?: Array<{ shiftId: string; line: string }>; gate?: "membership" | "background"; caregiver?: Doc };

/**
 * START: resolve which visit, then the shared startVisit (shifts/visitActions.ts)
 * does every check and the write; this wraps its refusal in Evia's keyword hints.
 */
export async function startVisit(caregiverId: string, shiftId: unknown, nowMs = Date.now()): Promise<StartResult> {
  const v = await resolveVisit(caregiverId, shiftId, "start");
  if (!v.ok) return { ok: false, reason: v.reason, message: v.message + (v.candidates ? "\n" + v.candidates.map((c, i) => `${i + 1}. ${c.line}`).join("\n") : "") };
  const { shift } = v;
  const tasks = taskItems(shift);
  const r = await startVisitShared({ caregiverId, shiftId: v.id, nowMs });
  if (!r.ok) {
    if (r.reason === "another_in_progress" && r.other) {
      return { ok: false, reason: r.reason, message: `${r.message} (${visitLine(r.other.shift)}) — text FINISH when it's over, then START this one.` };
    }
    if (r.reason === "too_early") return { ok: false, reason: r.reason, message: `${r.message} Text START then.` };
    if (r.reason === "membership" || r.reason === "background") return { ok: false, reason: r.reason, message: r.message, gate: r.reason, caregiver: r.caregiver };
    return { ok: false, reason: r.reason, message: r.message };
  }
  if (r.alreadyStarted) {
    return { ok: true, shiftId: v.id, alreadyStarted: true, startedAt: String(shift.startedAt ?? ""), tasks, text: `This visit is already in progress — ${visitLine(shift)}.` };
  }
  const started = clock(nowMs);
  const bookingSnap = shift.bookingRequestId ? await db.collection("booking_requests").doc(String(shift.bookingRequestId)).get().catch(() => null) : null;
  const bookingNote = bookingSnap?.exists ? ((bookingSnap.data()?.notes as string | undefined) ?? null) : null;
  const lines = [`Started ${started} — ${visitLine(shift)}.`, ...noteLines(shift, bookingNote)];
  const blocks = recipientBlocks(shift, tasks, { withNotes: true });
  if (blocks.length) lines.push("", ...blocks);
  lines.push("", tasks.length > 0
    ? `Reply DONE 1 (or DONE 1, 3) as you finish, NOTE followed by anything the family should see, and FINISH when the visit is over.`
    : "Text NOTE followed by anything the family should see, and FINISH when the visit is over.");
  lines.push(`Prefer the page? Open this visit: ${visitPageLink(v.id)}`);
  return { ok: true, shiftId: v.id, alreadyStarted: false, startedAt: new Date(nowMs).toISOString(), tasks, text: lines.join("\n") };
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export type TasksResult =
  | { ok: true; shiftId: string; tasksCompleted: string[]; text: string; tasks: TaskItem[] }
  | { ok: false; reason: string; message: string; candidates?: Array<{ shiftId: string; line: string }> };

/**
 * The page's toggleTask / toggleCategory writes. Over text a repeated "DONE 3"
 * must never UN-check (live 2026-09-28: the agent re-sent a done task and the
 * family was told "unchecked … not done after all"), so `completed` omitted
 * means check off; UNDO n / completed:false un-checks.
 */
export async function checkTasks(caregiverId: string, shiftId: unknown, sel: { numbers?: number[]; keys?: string[]; completed?: boolean }): Promise<TasksResult> {
  const v = await resolveVisit(caregiverId, shiftId, "in_progress");
  if (!v.ok) return { ok: false, reason: v.reason, message: v.message, candidates: v.candidates };
  if (v.shift.status !== "in-progress") return { ok: false, reason: "not_in_progress", message: "Tasks can only be checked off while the visit is in progress — text START when you're there." };
  const items = taskItems(v.shift);
  const keys = new Set<string>();
  for (const n of sel.numbers ?? []) { const it = items.find((t) => t.number === n); if (!it) return { ok: false, reason: "bad_number", message: `There's no task ${n} — the list runs 1 to ${items.length}.` }; keys.add(it.key); }
  for (const k of sel.keys ?? []) keys.add(k);
  if (keys.size === 0) return { ok: false, reason: "no_selection", message: "Which task? Reply DONE with its number." };
  const prev: string[] = Array.isArray(v.shift.tasksCompleted) ? (v.shift.tasksCompleted as string[]) : [];
  const complete = sel.completed ?? true;
  const next = complete ? [...new Set([...prev, ...keys])] : prev.filter((k) => !keys.has(k));
  await v.ref.update({ tasksCompleted: next });
  const after = items.map((t) => ({ ...t, done: next.includes(t.key) }));
  const manyRecipients = new Set(after.map((t) => t.recipientIndex)).size > 1;
  const touched = after.filter((t) => keys.has(t.key)).map((t) => (manyRecipients && t.recipientName ? `${t.label} (${t.recipientName})` : t.label));
  const doneCount = after.filter((t) => t.done).length;
  return { ok: true, shiftId: v.id, tasksCompleted: next, tasks: after, text: `${complete ? "Checked off" : "Unchecked"}: ${touched.join(", ")} (${doneCount}/${after.length} done).` };
}

// ── Visit notes ──────────────────────────────────────────────────────────────
export type NoteResult = { ok: true; shiftId: string; text: string; note: { at: string; text: string; by: "caregiver" } } | { ok: false; reason: string; message: string; candidates?: Array<{ shiftId: string; line: string }> };
export async function addVisitNote(caregiverId: string, shiftId: unknown, noteText: unknown, nowMs = Date.now()): Promise<NoteResult> {
  const text = String(noteText ?? "").trim();
  if (!text) return { ok: false, reason: "empty", message: "What should the note say?" };
  const v = await resolveVisit(caregiverId, shiftId, "in_progress");
  if (!v.ok) return { ok: false, reason: v.reason, message: v.message, candidates: v.candidates };
  if (v.shift.status !== "in-progress") return { ok: false, reason: "not_in_progress", message: "Visit notes can only be added while the visit is in progress." };
  const note = { at: new Date(nowMs).toISOString(), text, by: "caregiver" as const };
  await v.ref.update({ notesLog: admin.firestore.FieldValue.arrayUnion(note), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, shiftId: v.id, note, text: "Noted — the family can see it on the visit." };
}

// ── End ──────────────────────────────────────────────────────────────────────
export type EndResult =
  | { ok: true; shiftId: string; alreadyCompleted: boolean; text: string; completedAt: string }
  | { ok: false; reason: string; message: string; candidates?: Array<{ shiftId: string; line: string }> };
/** FINISH: resolve which visit, then the shared endVisit (shifts/visitActions.ts) checks and writes. */
export async function endVisit(caregiverId: string, shiftId: unknown, closingNote: unknown, nowMs = Date.now()): Promise<EndResult> {
  const v = await resolveVisit(caregiverId, shiftId, "in_progress");
  if (!v.ok) return { ok: false, reason: v.reason, message: v.message, candidates: v.candidates };
  const { shift } = v;
  const notes = String(closingNote ?? "").trim();
  const r = await endVisitShared({ caregiverId, shiftId: v.id, closingNote: notes, nowMs });
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
  if (r.alreadyCompleted) return { ok: true, shiftId: v.id, alreadyCompleted: true, completedAt: String(shift.completedAt ?? ""), text: `That visit is already ended — ${visitLine(shift)}.` };
  const items = taskItems(shift);
  const doneCount = items.filter((t) => t.done).length;
  return { ok: true, shiftId: v.id, alreadyCompleted: false, completedAt: new Date(nowMs).toISOString(), text: `Ended ${clock(nowMs)} — ${visitLine(shift)}.${items.length ? ` Tasks ${doneCount}/${items.length}.` : ""}${notes ? " Your closing note is on the visit." : ""} Thank you. Reply SUBMIT to submit your hours.` };
}

// ── The texted keywords (routeCaregiver): START · DONE n · UNDO n · NOTE … · TASKS · FINISH · SKIP ──
export const END_PROMPT = "Ending the visit — any closing note for the family? Reply with the note, or SKIP to end without one.";

// The parked END question expires like every other parked step (30 minutes, the shared idiom) — before 2026-10-11 it
// never did, so a text sent hours later could end the visit as its closing note.
export const PENDING_END_TTL_MS = 30 * 60 * 1000;
export interface PendingShiftEnd { shiftId: string; at: string; expiresAt?: string }
/** Parks the END question for THIS visit (FINISH keyword, the "which visit?" pick, and visit mode's "I'm done" all use it). */
export async function parkShiftEnd(phone: string, shiftId: string, nowMs = Date.now()): Promise<void> {
  const expiresAt = new Date(nowMs + PENDING_END_TTL_MS).toISOString();
  await db.collection("agent_sessions").doc(phone).set(
    { pendingShiftEnd: { shiftId, at: new Date(nowMs).toISOString(), expiresAt } satisfies PendingShiftEnd, stateExpiresAt: expiresAt },
    { merge: true },
  ).catch(() => {});
}
export function pendingEndExpired(p: PendingShiftEnd, nowMs = Date.now()): boolean {
  // A park written before the expiry existed carries only `at` — it expires 30 minutes after that; one with neither expires now.
  const t = p.expiresAt ? Date.parse(p.expiresAt) : p.at ? Date.parse(p.at) + PENDING_END_TTL_MS : NaN;
  return !Number.isFinite(t) || t < nowMs;
}
/** What the END question is about, for a mid-step question: the visit, what SKIP / a note / CANCEL do. Nothing has ended yet. */
export async function endStepFacts(caregiverId: string, shiftId: string): Promise<string> {
  const snap = await db.collection("shifts").doc(shiftId).get().catch(() => null);
  const shift = snap?.exists ? (snap.data() as Doc) : null;
  const items = shift ? taskItems(shift) : [];
  const visit = shift && shift.caregiverId === caregiverId ? `The visit being ended: ${visitLine(shift)}${items.length ? ` — tasks ${items.filter((t) => t.done).length}/${items.length} done` : ""}.` : "The visit being ended is the caregiver's visit in progress.";
  return `${visit} The visit is still in progress — nothing has ended yet. Replying with a note ends the visit and saves that note on it as the closing note, which the family can see; ` +
    "SKIP ends the visit without a note; CANCEL keeps the visit in progress. Ending the visit is the Bookings page's End button: the visit is marked completed and the caregiver then replies SUBMIT to submit hours.";
}

/**
 * Deterministic keyword protocol the start text announced ("Reply DONE 1…,
 * NOTE …, END"). Returns "handled" | "passthrough". A pending END question
 * (`pendingShiftEnd`) takes the next text as the closing note, or SKIP.
 */
export async function handleInShiftKeyword(phone: string, chatId: string, caregiverId: string, text: string, session: Record<string, unknown>): Promise<"handled" | "passthrough"> {
  const raw = text.trim();
  const upper = raw.toUpperCase();
  const say = (m: string) => sendMessage(chatId, m);
  // "Which visit?" parked by an ambiguous keyword: a number (or a family name the list holds) picks, then the keyword runs against THAT shift id.
  const choice = session.pendingVisitChoice as { candidates: Array<{ shiftId: string; line: string }>; keyword: string } | undefined;
  if (choice?.candidates?.length) {
    const clearChoice = () => db.collection("agent_sessions").doc(phone).update({ pendingVisitChoice: admin.firestore.FieldValue.delete() }).catch(() => {});
    if (upper === "CANCEL" || upper === "NO") { await clearChoice(); await say("Okay — nothing changed."); return "handled"; }
    const n = /^\d+$/.test(raw) ? Number(raw) : null;
    const lower = raw.toLowerCase();
    const byName = choice.candidates.filter((c) => c.line.toLowerCase().includes(lower));
    const picked = n !== null ? choice.candidates[n - 1] : byName.length === 1 ? byName[0] : undefined;
    if (!picked) { await say(whichVisitPrompt(choice.candidates)); return "handled"; }
    await clearChoice();
    await runKeywordOnShift(phone, chatId, caregiverId, choice.keyword, picked.shiftId, say);
    return "handled";
  }
  const pendingEnd = session.pendingShiftEnd as PendingShiftEnd | undefined;
  if (pendingEnd?.shiftId && pendingEndExpired(pendingEnd)) {
    // An expired END question never consumes a later text as the closing note — it is dropped and the text goes on as usual.
    await db.collection("agent_sessions").doc(phone).update({ pendingShiftEnd: admin.firestore.FieldValue.delete() }).catch(() => {});
  } else if (pendingEnd?.shiftId) {
    if (upper === "CANCEL" || upper === "NO") {
      await db.collection("agent_sessions").doc(phone).update({ pendingShiftEnd: admin.firestore.FieldValue.delete() }).catch(() => {});
      await say("Okay — the visit stays in progress.");
      return "handled";
    }
    if (upper !== "SKIP") {
      // A question mid-step is answered FROM the step (the visit, what SKIP / a note / CANCEL do) and the END question is
      // re-asked — never saved as the closing note. (Before 2026-10-11 it went to the agent with the step silently still
      // open, so the caregiver's next unrelated text ended the visit as its closing note.)
      const kind = await quickComplete(
        "A caregiver was asked: \"Any closing note for the family? Reply with the note, or SKIP.\" Classify their reply: " +
        "NOTE if it is the note itself (an observation about the visit or the person they cared for), QUESTION if it is a question or a request for something else. Reply with ONE word.",
        raw, { maxTokens: 3 },
      ).catch(() => "NOTE");
      if (kind.trim().toUpperCase().startsWith("Q")) {
        await say(await answerMidFlow(raw, END_PROMPT, { audience: "caregiver", facts: await endStepFacts(caregiverId, pendingEnd.shiftId) }));
        return "handled";
      }
    }
    const r = await endVisit(caregiverId, pendingEnd.shiftId, upper === "SKIP" ? "" : raw);
    await db.collection("agent_sessions").doc(phone).update({ pendingShiftEnd: admin.firestore.FieldValue.delete() }).catch(() => {});
    await say(r.ok ? r.text : r.message);
    return "handled";
  }
  if (upper === "START" || upper === "ARRIVED") {
    const v = await resolveVisit(caregiverId, undefined, "start");
    if (!v.ok && v.reason === "ambiguous" && v.candidates) { await parkVisitChoice(phone, v.candidates, "START"); await say(whichVisitPrompt(v.candidates)); return "handled"; }
    await sayStartResult(phone, chatId, await startVisit(caregiverId, v.ok ? v.id : undefined), say);
    return "handled";
  }
  // FINISH (or "end shift" / "finish shift" / "end visit") — never the bare word END, which is the SMS opt-out keyword.
  if (upper === "FINISH" || upper === "FINISH SHIFT" || upper === "FINISH VISIT" || upper === "END SHIFT" || upper === "END VISIT" || upper === "END THE SHIFT" || upper === "END MY SHIFT") {
    const v = await resolveVisit(caregiverId, undefined, "in_progress");
    if (!v.ok && v.reason === "ambiguous" && v.candidates) { await parkVisitChoice(phone, v.candidates, "FINISH"); await say(whichVisitPrompt(v.candidates)); return "handled"; }
    if (!v.ok) { await say(v.message); return "handled"; }
    await parkShiftEnd(phone, v.id);
    await say(END_PROMPT);
    return "handled";
  }
  if (upper === "TASKS") {
    // The page's Tasks panel, re-listed mid-visit.
    const v = await resolveVisit(caregiverId, undefined, "in_progress");
    if (!v.ok && v.reason === "ambiguous" && v.candidates) { await parkVisitChoice(phone, v.candidates, "TASKS"); await say(whichVisitPrompt(v.candidates)); return "handled"; }
    if (!v.ok) { await say(v.message); return "handled"; }
    const items = taskItems(v.shift);
    if (items.length === 0) { await say("This visit has no care plan tasks."); return "handled"; }
    const doneCount = items.filter((t) => t.done).length;
    await say([`Tasks (${doneCount}/${items.length} done):`, "", ...recipientBlocks(v.shift, items, { withDone: true }), "", "Reply DONE with a number to check one off."].join("\n"));
    return "handled";
  }
  const undo = /^UNDO\b\s*(.*)$/i.exec(raw);
  if (undo) {
    const numbers = (undo[1].match(/\d+/g) ?? []).map(Number);
    if (numbers.length === 0) { await say("Which task should I un-check? Reply UNDO with its number (e.g. UNDO 2)."); return "handled"; }
    const r = await checkTasks(caregiverId, undefined, { numbers, completed: false });
    if (!r.ok && r.reason === "ambiguous" && r.candidates) { await parkVisitChoice(phone, r.candidates, raw); await say(whichVisitPrompt(r.candidates)); return "handled"; }
    await say(r.ok ? r.text : r.message);
    return "handled";
  }
  const done = /^DONE\b\s*(.*)$/i.exec(raw);
  if (done) {
    const numbers = (done[1].match(/\d+/g) ?? []).map(Number);
    if (numbers.length === 0) { await say("Done with a task? Reply DONE with its number (e.g. DONE 2). Done with the visit? Reply FINISH."); return "handled"; }
    const r = await checkTasks(caregiverId, undefined, { numbers });
    if (!r.ok && r.reason === "ambiguous" && r.candidates) { await parkVisitChoice(phone, r.candidates, raw); await say(whichVisitPrompt(r.candidates)); return "handled"; }
    await say(r.ok ? r.text : r.message);
    return "handled";
  }
  const note = /^NOTE\b[:\s-]*([\s\S]*)$/i.exec(raw);
  if (note) {
    const r = await addVisitNote(caregiverId, undefined, note[1]);
    if (!r.ok && r.reason === "ambiguous" && r.candidates) { await parkVisitChoice(phone, r.candidates, raw); await say(whichVisitPrompt(r.candidates)); return "handled"; }
    await say(r.ok ? r.text : r.message);
    return "handled";
  }
  return "passthrough";
}

export const whichVisitPrompt = (candidates: Array<{ line: string }>) => `Which visit? ${candidates.map((c, i) => `Reply ${i + 1} for ${c.line}`).join(", ")}.`;

/**
 * The start text, or the refusal. A gate refusal (membership / background —
 * the server's rule, since 2026-10-11 also behind the texted START) is the
 * site's modal over SMS: its copy + its CTA link (textCaregiverGateBlock), the
 * same as every other gated action by text.
 */
async function sayStartResult(phone: string, chatId: string, r: StartResult, say: (m: string) => Promise<unknown>): Promise<void> {
  if (!r.ok && r.gate) { await textCaregiverGateBlock(phone, chatId, r.gate, r.caregiver ?? {}); return; }
  await say(r.ok ? r.text : r.message);
}
async function parkVisitChoice(phone: string, candidates: Array<{ shiftId: string; line: string }>, keyword: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).set({ pendingVisitChoice: { candidates, keyword, at: new Date().toISOString() }, stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }, { merge: true }).catch(() => {});
}
/** The keyword the caregiver texted, run against the visit they then picked. */
async function runKeywordOnShift(phone: string, chatId: string, caregiverId: string, keyword: string, shiftId: string, say: (m: string) => Promise<unknown>): Promise<void> {
  const upper = keyword.trim().toUpperCase();
  if (upper === "START") { await sayStartResult(phone, chatId, await startVisit(caregiverId, shiftId), say); return; }
  if (upper === "FINISH") {
    await parkShiftEnd(phone, shiftId);
    await say(END_PROMPT); return;
  }
  if (upper === "TASKS") {
    const v = await resolveVisit(caregiverId, shiftId, "in_progress");
    if (!v.ok) { await say(v.message); return; }
    const items = taskItems(v.shift); const doneCount = items.filter((t) => t.done).length;
    await say(items.length ? [`Tasks (${doneCount}/${items.length} done):`, "", ...recipientBlocks(v.shift, items, { withDone: true }), "", "Reply DONE with a number to check one off."].join("\n") : "This visit has no care plan tasks.");
    return;
  }
  const undo = /^UNDO\b\s*(.*)$/i.exec(keyword);
  if (undo) { const r = await checkTasks(caregiverId, shiftId, { numbers: (undo[1].match(/\d+/g) ?? []).map(Number), completed: false }); await say(r.ok ? r.text : r.message); return; }
  const done = /^DONE\b\s*(.*)$/i.exec(keyword);
  if (done) { const r = await checkTasks(caregiverId, shiftId, { numbers: (done[1].match(/\d+/g) ?? []).map(Number) }); await say(r.ok ? r.text : r.message); return; }
  const note = /^NOTE\b[:\s-]*([\s\S]*)$/i.exec(keyword);
  if (note) { const r = await addVisitNote(caregiverId, shiftId, note[1]); await say(r.ok ? r.text : r.message); return; }
  await say("Okay.");
}
