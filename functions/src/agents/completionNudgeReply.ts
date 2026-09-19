// The "did your interview happen?" check-in (scheduled/interviewCompletionNudge.ts)
// asks a yes/no question. On the website the same moment is the interview
// card's buttons: "Mark as Completed" once the time has passed, or Reschedule /
// Cancel if it didn't happen. A bare YES/NO reply to that check-in must land on
// those buttons — never on the no-tools quick-reply path (live-caught
// 2026-09-18: "yes" → "Got it, noted." and the interview stayed Accepted).
//
// YES → the SAME write as "Mark as Completed" (complete_interview, which is
// handleMarkInterviewComplete's update). NO → offer the card's other two
// buttons and leave the anchor in place so the agent resolves the follow-up
// against this exact interview. Anything else falls through to the agent,
// which already gets the interview id in its prompt.
import { TRIVIAL_CONFIRM_WORDS } from "./stepHandler";

export const COMPLETION_NUDGE_TTL_MS = 24 * 60 * 60 * 1000;

const NOT_HAPPENED = new Set([
  "NO", "N", "NOPE", "NAH", "NOT YET", "IT DIDN'T", "IT DIDNT", "DIDN'T HAPPEN", "DIDNT HAPPEN", "NO IT DIDN'T", "NO IT DIDNT",
]);
const HAPPENED_EXTRA = new Set(["IT DID", "IT HAPPENED", "YES IT DID", "DONE", "WE DID", "YES WE DID"]);

/** The interview the check-in asked about, if the check-in is still fresh. */
export function freshCompletionNudgeInterviewId(session: Record<string, unknown> | null | undefined, nowMs = Date.now()): string | null {
  const id = session?.pendingCompletionNudgeInterviewId;
  if (typeof id !== "string" || !id) return null;
  const setAt = session?.pendingCompletionNudgeSetAt;
  if (typeof setAt === "string" && setAt && Date.parse(setAt) < nowMs - COMPLETION_NUDGE_TTL_MS) return null;
  return id;
}

/** Bare yes / no to "did it happen?" — the stated reply protocol, like YES/NO gates. Anything else → null (the agent takes it). */
export function classifyCompletionNudgeReply(text: string): "happened" | "not_happened" | null {
  const bare = text.trim().toUpperCase().replace(/[.!?,]+$/g, "").replace(/\s+/g, " ");
  if (!bare || bare.length > 24) return null;
  if (TRIVIAL_CONFIRM_WORDS.has(bare) || HAPPENED_EXTRA.has(bare)) return "happened";
  if (NOT_HAPPENED.has(bare)) return "not_happened";
  return null;
}

export interface CompletionNudgeDeps {
  /** The site's Mark as Completed write (complete_interview). */
  completeInterview: (interviewId: string, clientId: string) => Promise<{ success?: boolean; caregiverName?: string | null; alreadyCompleted?: boolean; message?: string }>;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  clearAnchor: (phone: string) => Promise<void>;
}

async function defaultDeps(): Promise<CompletionNudgeDeps> {
  const admin = await import("firebase-admin");
  const { handleToolCall } = await import("../mcp/server");
  const { sendMessage } = await import("../linq/client");
  return {
    completeInterview: async (interviewId, clientId) =>
      (await handleToolCall("complete_interview", { interviewId, clientId })) as { success?: boolean; caregiverName?: string | null; alreadyCompleted?: boolean; message?: string },
    sendMessage: (chatId, text) => sendMessage(chatId, text),
    clearAnchor: async (phone) => {
      await admin.firestore().collection("agent_sessions").doc(phone).update({
        pendingCompletionNudgeInterviewId: admin.firestore.FieldValue.delete(),
        pendingCompletionNudgeSetAt:       admin.firestore.FieldValue.delete(),
      }).catch(() => {});
    },
  };
}

const first = (name: unknown, fallback = "your caregiver") => { const s = String(name ?? "").trim(); return s ? s.split(/\s+/)[0] : fallback; };

/**
 * Returns the reply text when this turn was a bare yes/no to a fresh check-in
 * (already sent), or null when the turn is not ours.
 */
export async function handleCompletionNudgeReply(
  params: { phone: string; chatId: string; text: string; session: Record<string, unknown> | null | undefined; nowMs?: number },
  deps?: CompletionNudgeDeps,
): Promise<string | null> {
  const interviewId = freshCompletionNudgeInterviewId(params.session, params.nowMs);
  if (!interviewId) return null;
  const verdict = classifyCompletionNudgeReply(params.text);
  if (!verdict) return null;
  const clientId = String(params.session?.userId ?? "");
  if (!clientId) return null;
  const d = deps ?? await defaultDeps();

  if (verdict === "not_happened") {
    // The card's other two buttons. Keep the anchor: the agent resolves
    // "reschedule it" / "cancel it" against this interview.
    const reply = "No problem — would you like to reschedule it, or cancel it?";
    await d.sendMessage(params.chatId, reply);
    return reply;
  }

  let reply: string;
  try {
    const res = await d.completeInterview(interviewId, clientId);
    if (res?.success) {
      const cg = first(res.caregiverName);
      reply = res.alreadyCompleted
        ? `That one's already marked completed — it's under Completed on your Care Requests page.`
        : `Done — your interview with ${cg} is marked completed; it's under Completed on your Care Requests page. Want to send ${cg} a booking request, or keep looking?`;
    } else {
      reply = `I couldn't mark that interview completed${res?.message ? ` — ${res.message}` : ""}. You can also do it from the Interviews tab on your Care Requests page.`;
    }
  } catch (err) {
    reply = `I couldn't mark that interview completed just now — ${err instanceof Error ? err.message : String(err)}. You can also do it from the Interviews tab on your Care Requests page.`;
  }
  await d.clearAnchor(params.phone);
  await d.sendMessage(params.chatId, reply);
  return reply;
}
