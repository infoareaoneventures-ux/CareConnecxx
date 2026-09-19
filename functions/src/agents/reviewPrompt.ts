// The first-visit review prompt (founder, 2026-09-19): the one time the site
// asks a family to review a caregiver is when the Leave a Review button first
// becomes available — their FIRST completed shift with that caregiver. On the
// site that is a dashboard card ("How was your first visit with Alice?") plus
// a bell notification; here it is one extra line on the visit-completion
// recap the family already receives, and a star reply starts reviewFlow.ts.
// Never fires again for the same caregiver (later shifts, no review) — one
// ask, then the button stays on the profile page.
import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";

export const REVIEW_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;

const first = (full: unknown, fallback = "your caregiver") => { const s = String(full ?? "").trim(); return s ? s.split(/\s+/)[0] : fallback; };

/** The recap's closing line. */
export function firstVisitReviewPromptLine(caregiverName: unknown): string {
  return `This was your first visit with ${first(caregiverName)} — want to leave a review? Reply with 1 to 5 stars to start, or text "review" any time. You can also do it from their profile.`;
}

/** The dashboard card / bell notification copy (the site's wording). */
export function firstVisitReviewNotification(caregiverName: unknown, caregiverId: string, shiftId: string) {
  return {
    type: "review_prompt",
    title: "How was your first visit?",
    body: `Leave a review for ${first(caregiverName)} — it helps other families choose.`,
    data: { caregiverId, shiftId },
  };
}

/**
 * True only for the FIRST completed shift with this caregiver (no other
 * completed shift on file) and no review by this family yet — the moment the
 * profile page's Leave a Review button first appears.
 */
export async function isFirstCompletedVisit(clientId: string, caregiverId: string, shiftId: string): Promise<boolean> {
  const db = admin.firestore();
  const [completed, reviewed] = await Promise.all([
    db.collection("shifts").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).where("status", "==", "completed").get().catch(() => null),
    db.collection("reviews").where("clientId", "==", clientId).where("caregiverId", "==", caregiverId).limit(1).get().catch(() => null),
  ]);
  if (!completed || !reviewed) return false;
  if (!reviewed.empty) return false;
  return !completed.docs.some((d) => d.id !== shiftId);
}

/** Remember which caregiver the prompt was about so a "5" reply can start the flow. */
export async function setReviewPromptAnchor(clientId: string, caregiverId: string, caregiverName: string): Promise<void> {
  const db = admin.firestore();
  const userSnap = await db.collection("users").doc(clientId).get().catch(() => null);
  const phone = userSnap?.data()?.phone as string | undefined;
  if (!phone) return;
  await db.collection("agent_sessions").doc(phone).set({
    pendingReviewPromptCaregiverId: caregiverId,
    pendingReviewPromptCaregiverName: caregiverName,
    pendingReviewPromptSetAt: new Date().toISOString(),
  }, { merge: true }).catch(() => {});
}

/** The caregiver a fresh prompt asked about, if any. */
export function freshReviewPromptCaregiver(session: Record<string, unknown> | null | undefined, nowMs = Date.now()): { caregiverId: string; caregiverName: string } | null {
  const id = session?.pendingReviewPromptCaregiverId;
  if (typeof id !== "string" || !id) return null;
  const setAt = session?.pendingReviewPromptSetAt;
  if (typeof setAt === "string" && setAt && Date.parse(setAt) < nowMs - REVIEW_PROMPT_TTL_MS) return null;
  return { caregiverId: id, caregiverName: String(session?.pendingReviewPromptCaregiverName ?? "") };
}

export type ReviewPromptReply = { kind: "start"; rating: number | null } | { kind: "decline" } | { kind: "other" };

/** LLM classification of the reply to the prompt (never regex on meaning). Exposed for tests via `complete`. */
export async function classifyReviewPromptReply(text: string, complete: (system: string, user: string) => Promise<string> = (s, u) => quickComplete(s, u, { maxTokens: 60 })): Promise<ReviewPromptReply> {
  const raw = await complete(
    'Evia just asked a family: "want to leave a review? Reply with 1 to 5 stars to start." Classify their reply. Return ONLY JSON: ' +
    '{"action": "start" | "decline" | "other", "rating": integer 1-5 or null}. "start" = a star count ("5", "4 stars", "⭐⭐⭐⭐⭐", "5/5") or a clear yes/"sure"/"review"/"let\'s do it" (rating null unless stated). ' +
    '"decline" = no / not now / maybe later / no thanks. "other" = anything else (a question, a different topic, a message about a shift or bill). Never invent a rating.',
    text,
  ).catch(() => "");
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: any = null;
  try { parsed = JSON.parse(stripped); } catch { parsed = null; }
  if (parsed?.action === "start") {
    const r = parsed.rating;
    return { kind: "start", rating: typeof r === "number" && Number.isInteger(r) && r >= 1 && r <= 5 ? r : null };
  }
  if (parsed?.action === "decline") return { kind: "decline" };
  return { kind: "other" };
}

export interface ReviewPromptDeps {
  startReviewFlow: (phone: string, chatId: string, session: Record<string, unknown>, args: { caregiverId: string; rating?: number }) => Promise<{ started: boolean }>;
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
  clearAnchor: (phone: string) => Promise<void>;
  classify: (text: string) => Promise<ReviewPromptReply>;
}

async function defaultDeps(): Promise<ReviewPromptDeps> {
  const { startReviewFlow } = await import("./reviewFlow");
  const { sendMessage } = await import("../linq/client");
  return {
    startReviewFlow: (phone, chatId, session, args) => startReviewFlow(phone, chatId, session as any, args),
    sendMessage: (chatId, text) => sendMessage(chatId, text),
    clearAnchor: async (phone) => {
      await admin.firestore().collection("agent_sessions").doc(phone).update({
        pendingReviewPromptCaregiverId: admin.firestore.FieldValue.delete(),
        pendingReviewPromptCaregiverName: admin.firestore.FieldValue.delete(),
        pendingReviewPromptSetAt: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
    },
    classify: (text) => classifyReviewPromptReply(text),
  };
}

/**
 * Handles the family's reply to a fresh first-visit prompt. Returns true when
 * this turn was consumed (flow started or prompt declined); false → the turn
 * is not ours and routing continues as normal.
 */
export async function handleReviewPromptReply(
  params: { phone: string; chatId: string; text: string; session: Record<string, unknown> | null | undefined; nowMs?: number },
  deps?: ReviewPromptDeps,
): Promise<boolean> {
  const anchor = freshReviewPromptCaregiver(params.session, params.nowMs);
  if (!anchor) return false;
  const d = deps ?? await defaultDeps();
  const verdict = await d.classify(params.text);
  if (verdict.kind === "other") return false;
  if (verdict.kind === "decline") {
    await d.clearAnchor(params.phone);
    await d.sendMessage(params.chatId, `No problem — the Leave a Review button stays on ${first(anchor.caregiverName)}'s profile whenever you'd like.`);
    return true;
  }
  // startReviewFlow clears the anchor itself and sends the first question.
  await d.startReviewFlow(params.phone, params.chatId, (params.session ?? {}) as Record<string, unknown>, {
    caregiverId: anchor.caregiverId, ...(verdict.rating ? { rating: verdict.rating } : {}),
  });
  return true;
}
