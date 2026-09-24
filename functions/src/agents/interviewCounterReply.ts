// A caregiver declined an interview but offered another time. On the website
// the family's Interviews card then shows "Accept this time" / "Propose another
// time" (PostsPage.tsx handleAcceptProposedTime / handleCounterProposeTime),
// both of which create a BRAND-NEW interview request through
// v1-createVideoInterviewRequest → requestVideoInterview. Over text, Evia
// arms this anchor when it relays the counter-offer, and the family's reply is
// classified here (LLM, never keyword) into those same two buttons, or a
// decline. Anything else is not ours and routes as normal.
import { quickComplete } from "../utils/openaiClient";
import { formatInterviewTime, parseScheduledTimeMs } from "../utils/scheduledTime";

export const INTERVIEW_COUNTER_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingInterviewCounter {
  interviewId: string;
  caregiverId: string;
  caregiverName: string;
  proposedTime: string;
  jobId?: string;
  jobTitle?: string;
}

/** The counter-offer Evia relayed, if it is still fresh. */
export function freshInterviewCounter(session: Record<string, unknown> | null | undefined, nowMs = Date.now()): PendingInterviewCounter | null {
  const raw = session?.pendingInterviewCounter as Partial<PendingInterviewCounter> | undefined;
  if (!raw || typeof raw.interviewId !== "string" || typeof raw.proposedTime !== "string" || typeof raw.caregiverId !== "string") return null;
  const setAt = session?.pendingInterviewCounterSetAt;
  if (typeof setAt === "string" && setAt && Date.parse(setAt) < nowMs - INTERVIEW_COUNTER_TTL_MS) return null;
  return {
    interviewId: raw.interviewId,
    caregiverId: raw.caregiverId,
    caregiverName: String(raw.caregiverName ?? ""),
    proposedTime: raw.proposedTime,
    ...(typeof raw.jobId === "string" && raw.jobId ? { jobId: raw.jobId } : {}),
    ...(typeof raw.jobTitle === "string" && raw.jobTitle ? { jobTitle: raw.jobTitle } : {}),
  };
}

export type InterviewCounterReply =
  | { action: "accept" }
  | { action: "other_time"; date: string | null; time: string | null }
  | { action: "decline" }
  | { action: "other" };

/** LLM classification of the reply (never regex on meaning). `complete` is injectable for tests. */
export async function classifyInterviewCounterReply(
  text: string,
  proposedLabel: string,
  todayIso: string,
  complete: (system: string, user: string) => Promise<string> = (s, u) => quickComplete(s, u, { maxTokens: 80 }),
): Promise<InterviewCounterReply> {
  const raw = await complete(
    `Evia told a family their caregiver can't make the interview time they asked for but is free ${proposedLabel}, and said ` +
    '"Reply YES to book that time, or send another time." Classify the family\'s reply. Return ONLY JSON: ' +
    '{"action": "accept" | "other_time" | "decline" | "other", "date": "YYYY-MM-DD" | null, "time": "HH:MM" | null}. ' +
    '"accept" = yes / that works / book it / sounds good / ok. "other_time" = they name or ask for a different day and/or time ' +
    `(resolve relative dates against today, ${todayIso}; 24h time; leave a part null if not stated). ` +
    '"decline" = no / not interested / forget it / let\'s not. "other" = a question or anything else. Never invent a date or time.',
    text,
  ).catch(() => "");
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: any = null;
  try { parsed = JSON.parse(stripped); } catch { parsed = null; }
  const date = typeof parsed?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;
  const time = typeof parsed?.time === "string" && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : null;
  switch (parsed?.action) {
    case "accept": return { action: "accept" };
    case "other_time": return { action: "other_time", date, time };
    case "decline": return { action: "decline" };
    default: return { action: "other" };
  }
}

export interface InterviewCounterDeps {
  /** The site's gate('interview') — true means blocked (and the family was already texted). */
  enforceGate: (clientId: string, caregiverName: string) => Promise<boolean>;
  /** The same write as the site's Accept this time / Propose another time buttons. */
  requestInterview: (params: { clientId: string; caregiverId: string; scheduledTime: string; jobId?: string; jobTitle?: string }) => Promise<unknown>;
  /** The scripted Request Interview flow, for a "different time" with no date/time stated. */
  startInterviewFlow: (caregiverId: string) => Promise<unknown>;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  clearAnchor: (phone: string) => Promise<void>;
  classify: (text: string, proposedLabel: string, todayIso: string) => Promise<InterviewCounterReply>;
  nowMs: () => number;
}

async function defaultDeps(phone: string, chatId: string, session: Record<string, unknown>): Promise<InterviewCounterDeps> {
  const admin = await import("firebase-admin");
  const { sendMessage } = await import("../linq/client");
  const { requestVideoInterview } = await import("./videoInterviewRequest");
  const { startInterviewFlow } = await import("./interviewFlow");
  const { enforceClientGate } = await import("./clientAccessGate");
  return {
    enforceGate: (clientId, caregiverName) => enforceClientGate(phone, chatId, clientId, "interview", caregiverName),
    requestInterview: (p) => requestVideoInterview({ ...p, source: "interviewCounterReply", phone }),
    startInterviewFlow: (caregiverId) => startInterviewFlow(phone, chatId, session as any, { caregiverId }),
    sendMessage: (c, t) => sendMessage(c, t),
    clearAnchor: async (p) => {
      await admin.firestore().collection("agent_sessions").doc(p).update({
        pendingInterviewCounter:      admin.firestore.FieldValue.delete(),
        pendingInterviewCounterSetAt: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
    },
    classify: (t, label, today) => classifyInterviewCounterReply(t, label, today),
    nowMs: () => Date.now(),
  };
}

const first = (name: string, fallback = "the caregiver") => { const s = name.trim(); return s ? s.split(/\s+/)[0] : fallback; };

/**
 * Returns true when this turn was the family's answer to a fresh counter-offer
 * (already handled and replied to); false when the turn is not ours.
 */
export async function handleInterviewCounterReply(
  params: { phone: string; chatId: string; text: string; session: Record<string, unknown> | null | undefined },
  deps?: InterviewCounterDeps,
): Promise<boolean> {
  // Cheap check first — most turns have no counter pending, and the default
  // deps pull in Firestore/Linq modules that must not load for nothing.
  if (!freshInterviewCounter(params.session, deps?.nowMs() ?? Date.now())) return false;
  const clientId = String(params.session?.userId ?? "");
  if (!clientId) return false;
  const d = deps ?? await defaultDeps(params.phone, params.chatId, (params.session ?? {}) as Record<string, unknown>);
  const pending = freshInterviewCounter(params.session, d.nowMs());
  if (!pending) return false;

  const proposedMs = Date.parse(pending.proposedTime);
  const proposedLabel = Number.isNaN(proposedMs) ? "at another time" : formatInterviewTime(proposedMs);
  const todayIso = new Date(d.nowMs()).toISOString().slice(0, 10);
  const verdict = await d.classify(params.text, proposedLabel, todayIso);
  if (verdict.action === "other") return false;

  const cg = first(pending.caregiverName);
  if (verdict.action === "decline") {
    await d.clearAnchor(params.phone);
    await d.sendMessage(params.chatId, `No problem — I'll leave that one. Say the word if you'd like to try another time with ${cg}, or look at other caregivers.`);
    return true;
  }

  // Both remaining actions are the site's two buttons: a NEW interview request
  // at the accepted time, or at the family's own stated time.
  let scheduledMs: number | null = null;
  if (verdict.action === "accept") {
    scheduledMs = Number.isNaN(proposedMs) ? null : proposedMs;
  } else if (verdict.date && verdict.time) {
    const ms = parseScheduledTimeMs(`${verdict.date}T${verdict.time}:00`);
    scheduledMs = Number.isNaN(ms) ? null : ms;
  }

  if (scheduledMs === null || scheduledMs < d.nowMs()) {
    // "Propose another time" with nothing usable stated → the flow asks date/time.
    await d.clearAnchor(params.phone);
    await d.startInterviewFlow(pending.caregiverId);
    return true;
  }

  // ScheduleInterviewModal / PostsPage: the submit runs gate('interview', name).
  if (await d.enforceGate(clientId, pending.caregiverName)) return true;

  try {
    await d.requestInterview({
      clientId,
      caregiverId: pending.caregiverId,
      scheduledTime: new Date(scheduledMs).toISOString(),
      ...(pending.jobId ? { jobId: pending.jobId } : {}),
      ...(pending.jobTitle ? { jobTitle: pending.jobTitle } : {}),
    });
    await d.clearAnchor(params.phone);
    await d.sendMessage(params.chatId,
      `Done — I've asked ${cg} for ${formatInterviewTime(scheduledMs)}. It's on your Care Requests > Interviews tab, and I'll let you know as soon as they confirm.`);
  } catch (err) {
    await d.sendMessage(params.chatId,
      `I couldn't send that interview request just now — ${err instanceof Error ? err.message : String(err)}. You can also accept the time from the Interviews tab on your Care Requests page.`);
  }
  return true;
}
