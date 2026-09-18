// What the family sees on their Active / Past Bookings card, delivered as text
// as it happens (standing rule, 2026-09-17):
//   · while a visit is in progress, tasks the caregiver checks off and notes
//     they add to the visit log are texted in ONE grouped message per burst
//     (a 2-minute window), never one text per tap;
//   · at completion, the Past Booking card in words — tasks done / not done per
//     recipient, the visit log, the closing note, and what happens next.
// The shift record is the only source: shifts.tasksCompleted (the caregiver
// pages' checkboxes, keyed `${ri}_${category}` / `${ri}_${category}_${sub}`),
// shifts.notesLog (append-only `{ at, text, by }` lines), shifts.completionNotes.
import * as admin from "firebase-admin";
import { formatClockTime, formatDateWithWeekday } from "../utils/scheduledTime";

const db = admin.firestore();

export const FAMILY_UPDATE_WINDOW_MS = 2 * 60 * 1000;

export interface VisitNoteEntry { at: string; text: string; by?: string }
export interface FamilyUpdateItem { kind: "task" | "note"; text: string; at: string; recipient?: string | null }

type Recipient = { name?: string; careNeeds?: string[]; careNeedDetails?: Record<string, string[]> };

const toMs = (v: unknown): number => {
  if (!v) return NaN;
  const t = v as { toMillis?: () => number; seconds?: number };
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  return Date.parse(String(v));
};

export function firstName(full: unknown, fallback = "Your caregiver"): string {
  const s = String(full ?? "").trim();
  return s ? s.split(/\s+/)[0] : fallback;
}

// A tasksCompleted key → { recipient, label } exactly as the cards render it.
export function taskLabel(key: string, shift: Record<string, unknown>): { recipient: string | null; label: string } {
  const recipients = (Array.isArray(shift.careRecipients) ? shift.careRecipients : []) as Recipient[];
  const m = /^(\d+)_(.+)$/.exec(key);
  if (m && recipients.length) {
    const ri = Number(m[1]);
    const rest = m[2];
    const r = recipients[ri];
    const recipient = (r?.name as string | undefined) || null;
    const cats = r?.careNeeds ?? [];
    // `${cat}_${sub}` — the category is the longest careNeeds entry that prefixes the rest.
    const cat = cats.filter((c) => rest === c || rest.startsWith(`${c}_`)).sort((a, b) => b.length - a.length)[0];
    if (cat) {
      const sub = rest.length > cat.length ? rest.slice(cat.length + 1) : "";
      return { recipient, label: sub ? `${sub} (${cat})` : cat };
    }
    return { recipient, label: rest.replace(/_/g, " ") };
  }
  return { recipient: null, label: key };
}

// Tasks and notes present after the write that weren't there before.
export function diffVisitProgress(before: Record<string, unknown> | undefined, after: Record<string, unknown>): FamilyUpdateItem[] {
  const now = new Date().toISOString();
  const prevTasks = new Set((Array.isArray(before?.tasksCompleted) ? before!.tasksCompleted : []) as string[]);
  const nextTasks = (Array.isArray(after.tasksCompleted) ? after.tasksCompleted : []) as string[];
  const items: FamilyUpdateItem[] = nextTasks
    .filter((k) => !prevTasks.has(k))
    .map((k) => { const { recipient, label } = taskLabel(k, after); return { kind: "task" as const, text: label, at: now, recipient }; });
  const prevNotes = new Set(((Array.isArray(before?.notesLog) ? before!.notesLog : []) as VisitNoteEntry[]).map((n) => `${n.at}|${n.text}`));
  const nextNotes = (Array.isArray(after.notesLog) ? after.notesLog : []) as VisitNoteEntry[];
  for (const n of nextNotes) {
    if (!prevNotes.has(`${n.at}|${n.text}`) && String(n.text ?? "").trim()) items.push({ kind: "note", text: String(n.text).trim(), at: n.at || now, recipient: null });
  }
  return items;
}

const joinList = (xs: string[]): string => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

// One grouped text: "Basra checked off A and B for Samira. Note 7:12 PM: "…""
export function buildFamilyUpdateText(caregiverName: unknown, items: FamilyUpdateItem[]): string {
  const cg = firstName(caregiverName);
  const parts: string[] = [];
  const tasks = items.filter((i) => i.kind === "task");
  if (tasks.length) {
    const byRecipient = new Map<string | null, string[]>();
    for (const t of tasks) { const k = t.recipient ?? null; if (!byRecipient.has(k)) byRecipient.set(k, []); byRecipient.get(k)!.push(t.text); }
    const groups = [...byRecipient.entries()].map(([r, labels]) => `${joinList(labels)}${r ? ` for ${firstName(r, r)}` : ""}`);
    parts.push(`${cg} checked off ${groups.join("; ")}.`);
  }
  for (const n of items.filter((i) => i.kind === "note")) {
    const ms = toMs(n.at);
    parts.push(`Note${Number.isFinite(ms) ? ` ${formatClockTime(ms)}` : ""}: "${n.text}"`);
  }
  return parts.join("\n");
}

// The Past Booking card in words.
export function buildVisitCompletionText(shift: Record<string, unknown>): string {
  const cgFull = String(shift.caregiverName ?? "Your caregiver");
  const cg = firstName(cgFull);
  const startMs = toMs(shift.startedAt);
  const endMs = toMs(shift.completedAt) || Date.now();
  const when = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? ` (${formatClockTime(startMs)}–${formatClockTime(endMs)}, ${fmtDuration((endMs - startMs) / 3_600_000)})`
    : "";
  const dateLabel = shift.date ? ` on ${formatDateWithWeekday(String(shift.date))}` : "";
  const lines: string[] = [`${cgFull}'s visit${dateLabel} is complete${when}.`];

  const done = new Set((Array.isArray(shift.tasksCompleted) ? shift.tasksCompleted : []) as string[]);
  const recipients = (Array.isArray(shift.careRecipients) ? shift.careRecipients : []) as Recipient[];
  const hasRecipientTasks = recipients.some((r) => (r.careNeeds ?? []).length > 0);
  let totalT = 0; let doneT = 0;
  if (hasRecipientTasks) {
    recipients.forEach((r, ri) => {
      const doneLabels: string[] = []; const notDone: string[] = [];
      (r.careNeeds ?? []).forEach((cat) => {
        const subs = (r.careNeedDetails ?? {})[cat] ?? [];
        if (subs.length) {
          subs.forEach((sub) => { totalT++; if (done.has(`${ri}_${cat}_${sub}`)) { doneT++; doneLabels.push(`${sub} (${cat})`); } else notDone.push(`${sub} (${cat})`); });
        } else {
          totalT++; if (done.has(`${ri}_${cat}`)) { doneT++; doneLabels.push(cat); } else notDone.push(cat);
        }
      });
      if (!doneLabels.length && !notDone.length) return;
      const nd = notDone.length > 6 ? `${notDone.length} tasks not done` : (notDone.length ? `${notDone.join(", ")} not done` : "all tasks done");
      lines.push(`${r.name ?? `Recipient ${ri + 1}`}: ${doneLabels.length ? `${doneLabels.join(", ")} ✓` : "nothing checked off"} · ${nd}`);
    });
  } else {
    const needs = (Array.isArray(shift.careNeeds) ? shift.careNeeds : []) as string[];
    totalT = needs.length; const doneLabels = needs.filter((n) => done.has(n)); doneT = doneLabels.length;
    const notDone = needs.filter((n) => !done.has(n));
    if (needs.length) lines.push(`Tasks: ${doneLabels.length ? `${doneLabels.join(", ")} ✓` : "nothing checked off"}${notDone.length ? ` · ${notDone.join(", ")} not done` : ""}`);
  }
  if (totalT) lines.push(`${doneT} of ${totalT} tasks checked off.`);

  const log = (Array.isArray(shift.notesLog) ? shift.notesLog : []) as VisitNoteEntry[];
  if (log.length) {
    lines.push("Visit notes:");
    for (const n of log) { const ms = toMs(n.at); lines.push(`${Number.isFinite(ms) ? `${formatClockTime(ms)} — ` : ""}${String(n.text ?? "").trim()}`); }
  }
  if (typeof shift.completionNotes === "string" && shift.completionNotes.trim()) lines.push(`Notes: ${shift.completionNotes.trim()}`);
  lines.push(`${cg} will submit the hours next; you'll get them here to review.`);
  return lines.join("\n");
}

export function fmtDuration(hours: number): string {
  const totalSecs = Math.max(0, Math.round((Number(hours) || 0) * 3600));
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── queue + flush ────────────────────────────────────────────────────────────
// familyUpdateQueue / familyUpdateQueuedAt / familyUpdateLastTextAt live on the
// shift. A burst's first item goes out at once if nothing went out in the last
// window; later items wait and the minute sweep (or completion) sends them as
// one text.

type Sender = (clientId: string, message: string) => Promise<void>;

export async function recordVisitProgress(
  ref: admin.firestore.DocumentReference,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  send: Sender,
): Promise<boolean> {
  const items = diffVisitProgress(before, after);
  if (!items.length) return false;
  const clientId = String(after.clientId ?? "");
  if (!clientId) return false;
  const nowMs = Date.now();
  const lastMs = toMs(after.familyUpdateLastTextAt);
  const queued = (Array.isArray(after.familyUpdateQueue) ? after.familyUpdateQueue : []) as FamilyUpdateItem[];
  if (!Number.isFinite(lastMs) || nowMs - lastMs >= FAMILY_UPDATE_WINDOW_MS) {
    await send(clientId, buildFamilyUpdateText(after.caregiverName, [...queued, ...items]));
    await ref.update({
      familyUpdateLastTextAt: new Date(nowMs).toISOString(),
      familyUpdateQueue: admin.firestore.FieldValue.delete(),
      familyUpdateQueuedAt: admin.firestore.FieldValue.delete(),
    });
    return true;
  }
  await ref.update({
    familyUpdateQueue: admin.firestore.FieldValue.arrayUnion(...items),
    ...(after.familyUpdateQueuedAt ? {} : { familyUpdateQueuedAt: new Date(nowMs).toISOString() }),
  });
  return true;
}

// Anything still waiting when the visit ends rides along in the completion text.
export function queuedItems(shift: Record<string, unknown>): FamilyUpdateItem[] {
  return (Array.isArray(shift.familyUpdateQueue) ? shift.familyUpdateQueue : []) as FamilyUpdateItem[];
}

export async function flushQueuedUpdates(send: Sender): Promise<number> {
  const cutoff = new Date(Date.now() - FAMILY_UPDATE_WINDOW_MS).toISOString();
  const snap = await db.collection("shifts").where("familyUpdateQueuedAt", "<=", cutoff).limit(100).get();
  let sent = 0;
  for (const doc of snap.docs) {
    const shift = doc.data() as Record<string, unknown>;
    const items = queuedItems(shift);
    const clientId = String(shift.clientId ?? "");
    if (items.length && clientId && shift.status === "in-progress") {
      await send(clientId, buildFamilyUpdateText(shift.caregiverName, items));
      sent++;
    }
    await doc.ref.update({
      familyUpdateQueue: admin.firestore.FieldValue.delete(),
      familyUpdateQueuedAt: admin.firestore.FieldValue.delete(),
      ...(items.length && clientId ? { familyUpdateLastTextAt: new Date().toISOString() } : {}),
    }).catch(() => {});
  }
  return sent;
}
