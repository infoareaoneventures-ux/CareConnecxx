// agents/visitMode.ts — the visit, start to finish, in the caregiver's own
// words (founder, 2026-10-07: "the shift is so important that I want a better
// plan starting shift all the way to ending the shift").
//
// While one of the caregiver's visits is IN PROGRESS, every free-text message
// is read against THAT visit before any other keyword handler, flow or the
// intent classifier can claim it (live 2026-10-07: "I'm done with the visit" was
// classified CANCEL_SHIFT and answered "You don't have any upcoming shifts to
// cancel"). The exact keywords (START · DONE n · UNDO n · NOTE … · TASKS ·
// FINISH · SKIP) stay the fast path in inShift.ts and run first; this module
// handles what they don't match:
//
//   task done ("finished meal prep", "both done")      → checkTasks (the page's task toggle)
//   an observation for the family ("he ate well")       → addVisitNote (the page's notes box)
//   the visit is over ("I'm done with the visit")       → the FINISH question (the page's End)
//   a question about the visit ("who's the emergency    → answered from the visit's own record
//     contact", "what's left", "when does this end")
//   anything else / a question outside the visit        → falls through to the agent
//   could be a task OR a note                           → ONE question, never a guess
//
// Nothing new is written: every write is the same page button inShift.ts
// already mirrors. The crisis fast path runs before routing (webhooks.ts) and
// is untouched. STOP/opt-out likewise.
//
// With NO visit in progress, an arrival ("I'm here", "starting now") while a
// visit's Start window is open starts it — the same startVisit as START.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { fmtTime } from "./caregiverBookingRequests";
import {
  START_WINDOW_MINUTES, END_PROMPT, taskItems, startsInMinutes, checkTasks, addVisitNote, parkShiftEnd,
  visitLine, clock, type TaskItem,
} from "./inShift";

const db = admin.firestore();
type Doc = Record<string, unknown>;

export interface VisitClassification {
  kind: "task_done" | "task_undo" | "note" | "finish" | "question" | "ambiguous" | "other";
  /** Task numbers (from the numbered list) for task_done / task_undo / ambiguous. */
  tasks?: number[];
  /** The note text, in the caregiver's words (for note, or alongside task_done). */
  note?: string | null;
  /** The recipient named in the message, when the visit has more than one. */
  recipient?: string | null;
  /** question: is it about THIS visit (answerable from its record) or outside it? */
  scope?: "visit" | "outside";
}

/** The caregiver's in-progress visits (any date). */
export async function loadInProgressVisits(caregiverId: string): Promise<Array<{ id: string; shift: Doc; ref: FirebaseFirestore.DocumentReference }>> {
  const snap = await db.collection("shifts").where("caregiverId", "==", caregiverId).where("status", "==", "in-progress").get();
  return snap.docs.map((d) => ({ id: d.id, shift: d.data() as Doc, ref: d.ref }));
}

function recipientNames(shift: Doc): string[] {
  const rs = Array.isArray(shift.careRecipients) ? (shift.careRecipients as Array<Doc | string>) : [];
  return rs.map((r) => (typeof r === "string" ? r : String(r.name ?? ""))).filter(Boolean);
}

function safeJson(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

/** One quick-model call: the message against THIS visit's task list and people. Fails closed to "other" (the agent). */
export async function classifyVisitMessage(text: string, shift: Doc, items: TaskItem[]): Promise<VisitClassification> {
  const names = recipientNames(shift);
  const many = names.length > 1;
  const taskList = items.map((t) => `${t.number}. ${t.label}${many && t.recipientName ? ` (${t.recipientName})` : ""}${t.done ? " — already done" : ""}`).join("\n");
  const system =
    `A caregiver is in the middle of a home-care visit with ${names.join(" and ") || "the client"}. Their text message is about this visit. ` +
    `Tasks for this visit, numbered:\n${taskList || "(none)"}\n\n` +
    `Classify the message and reply with ONLY a JSON object {"kind","tasks","note","recipient","scope"}:\n` +
    `- "task_done": they say they completed one or more of the listed tasks (match by meaning, e.g. "fed him" → Meal Preparation). "tasks" = the numbers. If the message also contains an observation for the family, put it in "note".\n` +
    `- "task_undo": they say a task was NOT actually done / undo it. "tasks" = the numbers.\n` +
    `- "note": an observation or update about the person or the visit that the family should see (what they ate, mood, bathroom, anything that happened). "note" = the text in their words, cleaned of filler but not softened or rewritten.\n` +
    `- "finish": they say the visit is over / they are done with the visit / leaving / wrapping up. (Being done with a TASK is task_done, not finish.)\n` +
    `- "question": they are asking something. "scope" = "visit" if the visit's own record can answer it (emergency contact, address, the person's notes/care needs, tasks left, start/end time), else "outside" (pay, other days, jobs, account).\n` +
    `- "ambiguous": it could reasonably be either a completed task or a note and you cannot tell. "tasks" = the candidate numbers.\n` +
    `- "other": none of the above (greetings, chatter, a request for something not on this list).\n` +
    `"recipient": the person named in the message if the visit has more than one person (${many ? names.join(", ") : "only one — use null"}), else null.`;
  const raw = await quickComplete(system, text, { maxTokens: 160 }).catch(() => "");
  const j = safeJson(raw);
  const kind = String(j?.kind ?? "other");
  const kinds = ["task_done", "task_undo", "note", "finish", "question", "ambiguous", "other"];
  if (!j || !kinds.includes(kind)) return { kind: "other" };
  const nums = Array.isArray(j.tasks) ? (j.tasks as unknown[]).map((n) => Number(n)).filter((n) => Number.isInteger(n) && items.some((t) => t.number === n)) : [];
  const note = typeof j.note === "string" && j.note.trim() ? j.note.trim() : null;
  const recipient = typeof j.recipient === "string" && j.recipient.trim() && many ? names.find((n) => n.toLowerCase() === String(j.recipient).trim().toLowerCase()) ?? null : null;
  const scope = j.scope === "outside" ? "outside" : "visit";
  return { kind: kind as VisitClassification["kind"], tasks: nums, note, recipient, scope };
}

/** The visit's own record, in words, for answering a question about it. */
export function visitRecordText(shift: Doc, items: TaskItem[], bookingNote: string | null, nowMs = Date.now()): string {
  const lines: string[] = [];
  lines.push(`Visit: ${visitLine(shift)}`);
  if (shift.address) lines.push(`Address: ${String(shift.address)}`);
  const startedMs = (shift.startedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? (typeof shift.startedAt === "string" ? Date.parse(shift.startedAt) : NaN);
  if (Number.isFinite(startedMs)) lines.push(`Started at ${clock(startedMs)} (now ${clock(nowMs)})`);
  if (shift.endTime) lines.push(`Scheduled to end at ${fmtTime(String(shift.endTime))}`);
  const ec = shift.emergencyContact as { name?: string; relationship?: string; phone?: string } | null | undefined;
  lines.push(ec?.name ? `Emergency contact: ${ec.name}${ec.relationship ? ` (${ec.relationship})` : ""}${ec.phone ? ` · ${ec.phone}` : ""}` : "Emergency contact: none on the booking");
  const rs = Array.isArray(shift.careRecipients) ? (shift.careRecipients as Array<Doc | string>) : [];
  for (const r of rs) {
    if (typeof r === "string") { lines.push(`Care recipient: ${r}`); continue; }
    const needs = Array.isArray(r.careNeeds) ? (r.careNeeds as string[]).join(", ") : "";
    lines.push(`Care recipient: ${String(r.name ?? "")}${r.relationship ? ` (${String(r.relationship)})` : ""}${needs ? ` — care needs: ${needs}` : ""}${r.notes ? ` — notes: ${String(r.notes)}` : ""}`);
  }
  if (bookingNote) lines.push(`Booking note from the family: ${bookingNote}`);
  if (shift.notes && shift.notes !== bookingNote) lines.push(`This visit's note: ${String(shift.notes)}`);
  const open = items.filter((t) => !t.done), done = items.filter((t) => t.done);
  if (items.length) lines.push(`Tasks done: ${done.length ? done.map((t) => t.label).join(", ") : "none yet"}`, `Tasks still open: ${open.length ? open.map((t) => `${t.number}. ${t.label}`).join(", ") : "none"}`);
  return lines.join("\n");
}

const DURING_VISIT_HELP = "During a visit I can check off a task (DONE 1), save a note for the family (NOTE followed by the note), or end the visit (FINISH).";

/**
 * Free text while a visit is in progress. "handled" when this module answered;
 * "passthrough" when there is no visit in progress, the message is outside the
 * visit, or nothing here applies (the agent takes it).
 */
export async function handleVisitModeMessage(
  phone: string, chatId: string, caregiverId: string, text: string, _session: Record<string, unknown>, nowMs = Date.now(),
): Promise<"handled" | "passthrough"> {
  const raw = text.trim();
  if (!raw) return "passthrough";
  const say = (m: string) => sendMessage(chatId, m);

  const open = await loadInProgressVisits(caregiverId);
  if (open.length > 1) return "passthrough"; // the keywords' "which visit?" handles this; a second START is refused since 2026-10-07
  if (open.length === 0) return handleArrival(phone, chatId, caregiverId, raw, say, nowMs);

  const { id: shiftId, shift } = open[0];
  const items = taskItems(shift);
  const c = await classifyVisitMessage(raw, shift, items);
  const many = recipientNames(shift).length > 1;
  const prefixed = (note: string) => (c.recipient && many && !note.toLowerCase().startsWith(c.recipient.toLowerCase()) ? `${c.recipient}: ${note}` : note);

  switch (c.kind) {
    case "task_done":
    case "task_undo": {
      if (!c.tasks?.length) { await say(`Which task? ${items.map((t) => `${t.number}. ${t.label}`).join(", ")}. Reply DONE with its number.`); return "handled"; }
      const r = await checkTasks(caregiverId, shiftId, { numbers: c.tasks, completed: c.kind === "task_done" });
      const parts = [r.ok ? r.text : r.message];
      if (r.ok && c.kind === "task_done" && c.note) {
        const n = await addVisitNote(caregiverId, shiftId, prefixed(c.note), nowMs);
        if (n.ok) parts.push("Noted for the family too.");
      }
      await say(parts.join(" "));
      return "handled";
    }
    case "note": {
      const n = await addVisitNote(caregiverId, shiftId, prefixed(c.note ?? raw), nowMs);
      await say(n.ok ? n.text : n.message);
      return "handled";
    }
    case "finish":
      // The same parked END question the FINISH keyword asks (inShift.ts), for THIS visit by id, with the same
      // 30-minute expiry — the reply (the closing note, or SKIP) is then handled by handleInShiftKeyword's pendingShiftEnd branch.
      await parkShiftEnd(phone, shiftId, nowMs);
      await say(END_PROMPT);
      return "handled";
    case "ambiguous": {
      const which = c.tasks?.length ? ` (${c.tasks.map((n) => `DONE ${n}`).join(" or ")})` : "";
      await say(`Is that a note for the family, or a task you finished? Reply NOTE followed by the note to save it for the family, or DONE with the task number${which}.`);
      return "handled";
    }
    case "question": {
      if (c.scope === "outside") return "passthrough";
      const bookingSnap = shift.bookingRequestId ? await db.collection("booking_requests").doc(String(shift.bookingRequestId)).get().catch(() => null) : null;
      const bookingNote = bookingSnap?.exists ? ((bookingSnap.data()?.notes as string | undefined) ?? null) : null;
      const record = visitRecordText(shift, items, bookingNote, nowMs);
      const answer = await quickComplete(
        `You are Evia, texting a caregiver who is in the middle of a visit. Answer their question in one or two short sentences using ONLY this record of the visit. ` +
        `If the record does not contain the answer, say so plainly and suggest asking the family. Never invent a name, phone number or instruction.\n\n${record}`,
        raw, { maxTokens: 160 },
      ).catch(() => "");
      if (!answer.trim()) return "passthrough";
      await say(answer.trim());
      return "handled";
    }
    default:
      return "passthrough";
  }
}

/**
 * No visit in progress. START is the clock-in — the page's Start Shift button, pay time runs from it — so an
 * arrival ("I'm here", "at the house") never starts the visit by itself (founder, 2026-10-07: "when you arrive"
 * would be misleading). Inside the Start window it points at START; before the window it says when Start opens.
 * Everything else passes through. The model is only asked when a visit of theirs is scheduled today.
 */
async function handleArrival(
  _phone: string, _chatId: string, caregiverId: string, raw: string, say: (m: string) => Promise<unknown>, nowMs: number,
): Promise<"handled" | "passthrough"> {
  const { resolveVisit } = await import("./inShift");
  const v = await resolveVisit(caregiverId, undefined, "start");
  if (!v.ok || v.shift.status !== "scheduled") return "passthrough";
  const mins = startsInMinutes(v.shift, nowMs);
  if (mins === null) return "passthrough";
  const verdict = await quickComplete(
    `A caregiver has a home-care visit today at ${fmtTime(String(v.shift.startTime ?? ""))}. ` +
    `Does their text message say they have ARRIVED at the client's home or are about to start the visit ("I'm here", "arrived", "at the house", "starting now")? Reply ARRIVED or OTHER.`,
    raw, { maxTokens: 3 },
  ).catch(() => "OTHER");
  if (!verdict.trim().toUpperCase().startsWith("ARRIVED")) return "passthrough";
  if (mins <= START_WINDOW_MINUTES) {
    await say(`Start is open for your ${fmtTime(String(v.shift.startTime ?? ""))} visit with ${String(v.shift.clientName || "the family")}. Text START to begin it.`);
  } else {
    const opensMs = nowMs + (mins - START_WINDOW_MINUTES) * 60_000;
    await say(`You're early — Start opens at ${clock(opensMs)} for the ${fmtTime(String(v.shift.startTime ?? ""))} visit. Text START then.`);
  }
  return "handled";
}

export { DURING_VISIT_HELP };
