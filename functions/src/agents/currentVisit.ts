// "Is a visit happening right now, when does it end, how far along is it" — the answer built by CODE from the visit record.
//
// Why this exists (live 2026-11-23, founders): "when does the shift end?" and "do I have a shift in progress?" made the agent
// call get_upcoming_appointments (up to five whole shift documents) plus read_memory_file, write a sentence from them, and the
// fact-checker then called the sentence UNSUPPORTED — three times in a row, each answered with a canned line. A question this
// common should not depend on a model re-reading a pile of JSON: this module reads the in-progress visit (and the next one) and
// returns finished, formatted facts plus ONE sentence the agent can send as is. The sentence is made from the data, so it is
// backed by construction.
import { formatHHMMForDisplay, formatClockTime, weekdayForDate, formatDateForDisplay } from "../utils/scheduledTime";
import { careZoneOf, zoneSuffix } from "../utils/careTime";
import { taskItems } from "./inShift";

type Doc = Record<string, unknown>;

export interface VisitFacts {
  shiftId: string;
  who: string;
  date: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  tasksDone: string[];
  tasksOpen: string[];
  notes: string[];
  sentence: string;
}

export interface CurrentVisitFacts {
  inProgress: VisitFacts[];
  next: VisitFacts | null;
  /** One message that answers "is anything in progress / when does it end / how far along", built from the facts above. */
  sentence: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function toMs(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Facts for ONE visit record. `perspective` decides whose name leads the sentence: the care provider for a family, the family for a care provider. */
export function visitFacts(shiftId: string, shift: Doc, perspective: "family" | "caregiver"): VisitFacts {
  const who = perspective === "family" ? str(shift.caregiverName) || "Your care provider" : str(shift.clientName) || "the family";
  const date = str(shift.date);
  const startRaw = str(shift.startTime);
  const endRaw = str(shift.endTime);
  const scheduledStart = startRaw ? formatHHMMForDisplay(startRaw) : null;
  const scheduledEnd = endRaw ? formatHHMMForDisplay(endRaw) : null;
  const zone = careZoneOf(shift as never);
  const startedMs = toMs(shift.startedAt);
  const startedAt = startedMs !== null ? formatClockTime(startedMs, zone) : null;
  const tasks = taskItems(shift);
  const tasksDone = tasks.filter((t) => t.done).map((t) => t.label);
  const tasksOpen = tasks.filter((t) => !t.done).map((t) => t.label);
  const notes = (Array.isArray(shift.notesLog) ? (shift.notesLog as Array<{ text?: unknown }>) : [])
    .map((n) => str(n?.text)).filter(Boolean).slice(-3);
  const tz = zoneSuffix(shift as never);

  const status = str(shift.status);
  const lead = perspective === "family" ? `${who}'s visit` : `Your visit with ${who}`;
  let sentence: string;
  if (status === "in-progress") {
    const window = scheduledStart && scheduledEnd
      ? `scheduled ${scheduledStart}–${scheduledEnd}${tz}`
      : scheduledStart ? `scheduled to start at ${scheduledStart}${tz}, with no end time on the visit` : "with no scheduled times on the visit";
    sentence = `${lead} is in progress, ${window}${startedAt ? `, started at ${startedAt}${tz}` : ""}.`;
    if (tasks.length) {
      sentence += ` ${tasksDone.length} of ${tasks.length} tasks done${tasksDone.length ? ` (${tasksDone.join(", ")})` : ""}.`;
      if (tasksOpen.length && tasksOpen.length <= 4) sentence += ` Still to do: ${tasksOpen.join(", ")}.`;
    }
  } else {
    const day = date ? `${weekdayForDate(date) ?? ""}${weekdayForDate(date) ? ", " : ""}${formatDateForDisplay(date)}` : "";
    const window = scheduledStart && scheduledEnd ? `${scheduledStart}–${scheduledEnd}${tz}` : scheduledStart ? `${scheduledStart}${tz}` : "";
    sentence = `${lead} is ${day ? `on ${day}` : "scheduled"}${window ? `, ${window}` : ""}.`;
  }
  return { shiftId, who, date, scheduledStart, scheduledEnd, startedAt, tasksDone, tasksOpen, notes, sentence };
}

/** Pure: the in-progress visit(s) and the next one in, one answer out. */
export function buildCurrentVisitFacts(
  inProgress: Array<{ id: string; data: Doc }>,
  next: { id: string; data: Doc } | null,
  perspective: "family" | "caregiver",
): CurrentVisitFacts {
  const live = inProgress.map((s) => visitFacts(s.id, s.data, perspective));
  const upNext = next ? visitFacts(next.id, next.data, perspective) : null;
  let sentence: string;
  if (live.length) {
    sentence = live.map((v) => v.sentence).join(" ");
    if (upNext) sentence += ` Next after that: ${upNext.sentence.charAt(0).toLowerCase()}${upNext.sentence.slice(1)}`;
  } else if (upNext) {
    sentence = `No visit is in progress right now. ${upNext.sentence}`;
  } else {
    sentence = "No visit is in progress right now, and nothing else is scheduled.";
  }
  return { inProgress: live, next: upNext, sentence };
}
