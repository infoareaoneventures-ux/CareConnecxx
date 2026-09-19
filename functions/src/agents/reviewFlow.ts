// Scripted "Leave a Review" flow — the website's review modal
// (components/client/LeaveReviewModal.tsx) in text, step for step, and the
// SAME document that modal's Submit Review writes to `reviews`.
//
// Modal, top to bottom: Overall rating (required, 1–5) → Rate by category
// (optional: Punctuality, Professionalism, Communication, Quality of Care) →
// Your review (10–250 characters, required) → Would you recommend this
// caregiver? (Yes/No, required) → Submit. Eligibility is the profile page's
// rule: the Leave a Review button shows after a completed shift with the
// caregiver, and one review per caregiver per family (the modal's own
// duplicate guard). Aggregation is the server trigger onReviewWritten,
// exactly as for the modal — nothing here recomputes ratings.
//
// Built 2026-09-19. Replaced the MCP tool submit_review, which looked the
// visit up in the legacy `appointments` collection (families have shift ids,
// so it returned Not Found), allowed a second review of the same caregiver,
// and wrote a thinner Evia-only document.
import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";
import { quickComplete } from "../utils/openaiClient";
import { caraOutputGuardEnabled } from "../config/featureFlags";
import { guardModelOutput } from "../safety/outputGuard";
import { isBackOutRequest, TRIVIAL_CONFIRM_WORDS, isQuestionOrOther, answerMidFlow } from "./stepHandler";
import { readCaregiverProfilePage } from "./caregiverProfilePage";

const db = admin.firestore();

export const REVIEW_COMMENT_MIN = 10;
export const REVIEW_COMMENT_MAX = 250;
export const REVIEW_CATEGORY_KEYS = ["punctuality", "professionalism", "communication", "careQuality"] as const;
export type ReviewCategoryKey = (typeof REVIEW_CATEGORY_KEYS)[number];
export const REVIEW_CATEGORY_LABELS: Record<ReviewCategoryKey, string> = {
  punctuality: "Punctuality",
  professionalism: "Professionalism",
  communication: "Communication",
  careQuality: "Quality of Care",
};
export type ReviewCategories = Record<ReviewCategoryKey, number>;
const EMPTY_CATEGORIES: ReviewCategories = { punctuality: 0, professionalism: 0, communication: 0, careQuality: 0 };

export interface ReviewFlowData {
  caregiverId: string;
  caregiverName: string;
  rating?: number;
  /** 0 = not rated, like the modal's untouched stars. Absent until the step is answered. */
  categories?: ReviewCategories;
  comment?: string;
  wouldRecommend?: boolean;
}

export type ReviewFlowStep = "rv_ask_rating" | "rv_ask_categories" | "rv_ask_comment" | "rv_ask_recommend" | "rv_confirm";

const RV_DIDNT_CATCH = "Sorry, I didn't quite catch that.";

const first = (full: string) => (full.trim().split(/\s+/)[0] || "your caregiver");

// ── Questions (the modal's fields, in its order) ─────────────────────────────
export const RATING_QUESTION = (name: string) => `How was your experience with ${first(name)}? Overall rating, 1 to 5 stars.`;
export const CATEGORIES_QUESTION = () =>
  `Want to rate by category too? Punctuality, Professionalism, Communication, Quality of Care — reply with four numbers 1 to 5 in that order (e.g. "5 4 5 5"), or "skip".`;
export const COMMENT_QUESTION = () => `Your review — a few sentences about your experience (${REVIEW_COMMENT_MIN} to ${REVIEW_COMMENT_MAX} characters).`;
export const RECOMMEND_QUESTION = (name: string) => `Would you recommend ${first(name)}? Reply YES or NO.`;

// ── Pure helpers (tested) ────────────────────────────────────────────────────
export function isValidRating(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;
}

export function validateComment(text: string): { ok: true; comment: string } | { ok: false; reason: "too_short" | "too_long" } {
  const comment = text.trim();
  if (comment.length < REVIEW_COMMENT_MIN) return { ok: false, reason: "too_short" };
  if (comment.length > REVIEW_COMMENT_MAX) return { ok: false, reason: "too_long" };
  return { ok: true, comment };
}

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

export function buildReviewRecap(data: ReviewFlowData): string {
  const cats = data.categories ?? EMPTY_CATEGORIES;
  const rated = REVIEW_CATEGORY_KEYS.filter((k) => cats[k] > 0);
  const catLine = rated.length ? rated.map((k) => `${REVIEW_CATEGORY_LABELS[k]} ${cats[k]}`).join(" · ") : "Skipped";
  return [
    `Here's your review of ${data.caregiverName}:`,
    ``,
    `Overall: ${stars(data.rating ?? 0)} (${data.rating ?? 0}/5)`,
    `By category: ${catLine}`,
    `Your review: "${data.comment ?? ""}"`,
    `Would recommend: ${data.wouldRecommend ? "Yes" : "No"}`,
    ``,
    `Reply YES to submit it, or tell me what to change.`,
  ].join("\n");
}

/** The exact document LeaveReviewModal.tsx writes (field for field, same order). */
export function reviewDocFor(input: {
  clientId: string; clientName: string; clientPhotoURL: string | null;
  caregiverId: string; caregiverName: string;
  rating: number; comment: string; categories: ReviewCategories; wouldRecommend: boolean;
  nowIso: string; serverTimestamp: unknown;
}): Record<string, unknown> {
  return {
    clientId: input.clientId,
    clientName: input.clientName,
    clientPhotoURL: input.clientPhotoURL,
    caregiverId: input.caregiverId,
    caregiverName: input.caregiverName,
    rating: input.rating,
    comment: input.comment,
    categories: input.categories,
    wouldRecommend: input.wouldRecommend,
    wouldRehire: input.wouldRecommend,
    isPublic: true,
    createdAt: input.nowIso,
    timestamp: input.serverTimestamp,
  };
}

// ── Model calls (quick tier; never regex on meaning) ─────────────────────────
async function ask(prompt: string, userText: string): Promise<string> {
  const raw = (await quickComplete(prompt + "\nReply with ONLY the requested value or format — no explanation, no extra text. Never invent information the user's message does not state.", userText, { maxTokens: 120 })).trim();
  if (raw && caraOutputGuardEnabled() && !guardModelOutput(raw).ok) return "__parse_error__";
  return raw;
}

function parseJsonLoose(raw: string): any | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { return null; }
}

// ── Session state ────────────────────────────────────────────────────────────
async function getFlowData(phone: string): Promise<ReviewFlowData> {
  const snap = await db.collection("agent_sessions").doc(phone).get();
  return (snap.data()?.reviewFlowData ?? {}) as ReviewFlowData;
}
async function mergeFlowData(phone: string, data: Partial<ReviewFlowData>): Promise<void> {
  const existing = await getFlowData(phone);
  await db.collection("agent_sessions").doc(phone).update({ reviewFlowData: { ...existing, ...data } });
}
async function updateStep(phone: string, step: ReviewFlowStep): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({ reviewFlowStep: step });
}
async function clearFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    reviewFlowStep: admin.firestore.FieldValue.delete(),
    reviewFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt: admin.firestore.FieldValue.delete(),
  });
}

async function handleBackOut(phone: string, chatId: string, data: ReviewFlowData): Promise<void> {
  await clearFlow(phone);
  await sendMessage(chatId, `No problem — nothing was posted. The Leave a Review button stays on ${first(data.caregiverName)}'s profile whenever you'd like.`);
}

// ── The write (the modal's Submit Review) ────────────────────────────────────
export async function submitReview(clientId: string, data: ReviewFlowData): Promise<{ ok: true; reviewId: string } | { ok: false; reason: "duplicate" | "incomplete" }> {
  if (!isValidRating(data.rating) || !data.comment || typeof data.wouldRecommend !== "boolean") return { ok: false, reason: "incomplete" };
  // The modal's guard: one review per caregiver per family.
  const dup = await db.collection("reviews").where("clientId", "==", clientId).where("caregiverId", "==", data.caregiverId).limit(1).get();
  if (!dup.empty) return { ok: false, reason: "duplicate" };
  // The modal: Auth displayName || 'Client'; photo = Auth photoURL → users doc chain → null.
  const userSnap = await db.collection("users").doc(clientId).get().catch(() => null);
  const u = (userSnap?.data() ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const clientName = s(u.displayName) || [s(u.firstName), s(u.lastName)].filter(Boolean).join(" ") || "Client";
  const clientPhotoURL = s(u.photoURL) || s(u.photo) || s(u.imageUrl) || s(u.profilePhoto) || null;
  const ref = await db.collection("reviews").add(reviewDocFor({
    clientId, clientName, clientPhotoURL,
    caregiverId: data.caregiverId, caregiverName: data.caregiverName,
    rating: data.rating, comment: data.comment, categories: data.categories ?? EMPTY_CATEGORIES, wouldRecommend: data.wouldRecommend,
    nowIso: new Date().toISOString(), serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  }));
  return { ok: true, reviewId: ref.id };
}

// ── Entry point ──────────────────────────────────────────────────────────────
export async function startReviewFlow(
  phone: string, chatId: string, session: AgentSession,
  args: { caregiverId: string; rating?: number },
): Promise<{ started: boolean; reason?: string }> {
  const clientId = session.userId as string | undefined;
  if (!clientId) {
    await sendMessage(chatId, "I couldn't find your account to start a review. Please try again.");
    return { started: false, reason: "no_client_id" };
  }
  // The profile page's own eligibility: a completed shift with them, and no review yet.
  const page = await readCaregiverProfilePage(args.caregiverId, clientId, 1);
  if (!page) {
    await sendMessage(chatId, "I couldn't find that caregiver's profile.");
    return { started: false, reason: "not_found" };
  }
  const name = page.name;
  if (page.relationship.hasReviewed) {
    await sendMessage(chatId, `You've already reviewed ${first(name)} — it's on their profile. Each family can leave one review per caregiver.`);
    return { started: false, reason: "already_reviewed" };
  }
  if (!page.relationship.hasCompletedShift) {
    await sendMessage(chatId, `The Leave a Review button appears on ${first(name)}'s profile after your first completed visit together — you don't have one yet.`);
    return { started: false, reason: "no_completed_shift" };
  }
  const data: ReviewFlowData = { caregiverId: args.caregiverId, caregiverName: name };
  if (isValidRating(args.rating)) data.rating = args.rating;
  await db.collection("agent_sessions").doc(phone).set({
    reviewFlowData: data,
    reviewFlowStep: data.rating ? "rv_ask_categories" : "rv_ask_rating",
    stateExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    // The first-visit prompt anchor is consumed by starting the flow.
    pendingReviewPromptCaregiverId: admin.firestore.FieldValue.delete(),
    pendingReviewPromptCaregiverName: admin.firestore.FieldValue.delete(),
    pendingReviewPromptSetAt: admin.firestore.FieldValue.delete(),
  }, { merge: true });
  await sendMessage(chatId, data.rating
    ? `${stars(data.rating)} for ${first(name)} — got it. ${CATEGORIES_QUESTION()}`
    : RATING_QUESTION(name));
  return { started: true };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
export async function handleReviewFlowStep(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const step = ((session as any).reviewFlowStep as string) ?? "";
  switch (step) {
    case "rv_ask_rating":     return handleRvAskRating(phone, chatId, text);
    case "rv_ask_categories": return handleRvAskCategories(phone, chatId, text);
    case "rv_ask_comment":    return handleRvAskComment(phone, chatId, text);
    case "rv_ask_recommend":  return handleRvAskRecommend(phone, chatId, text);
    case "rv_confirm":        return handleRvConfirm(phone, chatId, text, session);
    default: {
      const data = await getFlowData(phone);
      await updateStep(phone, "rv_ask_rating");
      await sendMessage(chatId, RATING_QUESTION(data.caregiverName));
    }
  }
}

async function guard(phone: string, chatId: string, text: string, question: string, data: ReviewFlowData): Promise<boolean> {
  if (await isBackOutRequest(text, question)) { await handleBackOut(phone, chatId, data); return true; }
  if (await isQuestionOrOther(text, question)) {
    await sendMessage(chatId, await answerMidFlow(text, question));
    await sendMessage(chatId, question);
    return true;
  }
  return false;
}

async function extractRating(text: string): Promise<number | null> {
  const raw = await ask('The family is giving a caregiver an overall star rating from 1 to 5. Return ONLY JSON: {"rating": integer 1-5 or null}. "five stars"/"5/5"/"⭐⭐⭐⭐⭐" → 5; "3 out of 5" → 3; null if no clear rating is stated.', text);
  const parsed = parseJsonLoose(raw);
  return isValidRating(parsed?.rating) ? parsed.rating : null;
}

async function handleRvAskRating(phone: string, chatId: string, text: string): Promise<void> {
  const data = await getFlowData(phone);
  const question = RATING_QUESTION(data.caregiverName);
  if (await guard(phone, chatId, text, question, data)) return;
  const rating = await extractRating(text);
  if (rating === null) { await sendMessage(chatId, `${RV_DIDNT_CATCH} ${question}`); return; }
  await mergeFlowData(phone, { rating });
  await updateStep(phone, "rv_ask_categories");
  await sendMessage(chatId, `${stars(rating)} — got it. ${CATEGORIES_QUESTION()}`);
}

async function handleRvAskCategories(phone: string, chatId: string, text: string): Promise<void> {
  const data = await getFlowData(phone);
  const question = CATEGORIES_QUESTION();
  if (await guard(phone, chatId, text, question, data)) return;
  const raw = await ask(
    'The family may rate four categories 1-5 in this order: punctuality, professionalism, communication, careQuality — or skip. Return ONLY JSON: ' +
    '{"skip": boolean, "punctuality": 1-5 or null, "professionalism": 1-5 or null, "communication": 1-5 or null, "careQuality": 1-5 or null}. ' +
    '"skip"/"no"/"not now"/"all 5s"→ for "all 5s" set every category to 5 and skip false. Four bare numbers map in order. Never invent a number that isn\'t stated.',
    text,
  );
  const parsed = parseJsonLoose(raw);
  if (!parsed) { await sendMessage(chatId, `${RV_DIDNT_CATCH} ${question}`); return; }
  const categories: ReviewCategories = { ...EMPTY_CATEGORIES };
  if (parsed.skip !== true) {
    let any = false;
    for (const k of REVIEW_CATEGORY_KEYS) if (isValidRating(parsed[k])) { categories[k] = parsed[k]; any = true; }
    if (!any) { await sendMessage(chatId, `${RV_DIDNT_CATCH} ${question}`); return; }
  }
  await mergeFlowData(phone, { categories });
  await updateStep(phone, "rv_ask_comment");
  await sendMessage(chatId, `${parsed.skip === true ? "Skipped. " : "Noted. "}${COMMENT_QUESTION()}`);
}

async function handleRvAskComment(phone: string, chatId: string, text: string): Promise<void> {
  const data = await getFlowData(phone);
  const question = COMMENT_QUESTION();
  if (await isBackOutRequest(text, question)) return handleBackOut(phone, chatId, data);
  // The message IS the review text — only a clear question gets answered first.
  const v = validateComment(text);
  if (!v.ok) {
    if (v.reason === "too_short" && await isQuestionOrOther(text, question)) {
      await sendMessage(chatId, await answerMidFlow(text, question));
      await sendMessage(chatId, question);
      return;
    }
    await sendMessage(chatId, v.reason === "too_short"
      ? `That's a bit short — the review needs at least ${REVIEW_COMMENT_MIN} characters. ${question}`
      : `That's over ${REVIEW_COMMENT_MAX} characters (${text.trim().length}). Could you trim it a little and send it again?`);
    return;
  }
  await mergeFlowData(phone, { comment: v.comment });
  await updateStep(phone, "rv_ask_recommend");
  await sendMessage(chatId, `Thank you. ${RECOMMEND_QUESTION(data.caregiverName)}`);
}

async function handleRvAskRecommend(phone: string, chatId: string, text: string): Promise<void> {
  const data = await getFlowData(phone);
  const question = RECOMMEND_QUESTION(data.caregiverName);
  const norm = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  let verdict: "YES" | "NO" | null = norm === "YES" ? "YES" : norm === "NO" ? "NO" : null; // the stated YES/NO protocol
  if (!verdict) {
    if (await guard(phone, chatId, text, question, data)) return;
    const raw = (await ask('The family was asked "Would you recommend this caregiver? Reply YES or NO." Reply with exactly YES, NO, or UNCLEAR.', text)).toUpperCase();
    verdict = raw.startsWith("YES") ? "YES" : raw.startsWith("NO") ? "NO" : null;
  }
  if (!verdict) { await sendMessage(chatId, `${RV_DIDNT_CATCH} ${question}`); return; }
  await mergeFlowData(phone, { wouldRecommend: verdict === "YES" });
  await updateStep(phone, "rv_confirm");
  const updated = await getFlowData(phone);
  await sendMessage(chatId, buildReviewRecap(updated));
}

const CONFIRM_FALLBACK = "Confirming whether to post this review — reply YES to submit it, or NO to cancel.";

async function handleRvConfirm(phone: string, chatId: string, text: string, session: AgentSession): Promise<void> {
  const data = await getFlowData(phone);
  const bare = text.trim().toUpperCase().replace(/[.!?]+$/g, "");
  let action: string | undefined;
  let parsed: any = null;
  if (TRIVIAL_CONFIRM_WORDS.has(bare)) {
    action = "confirm";
  } else {
    if (await isBackOutRequest(text, buildReviewRecap(data))) return handleBackOut(phone, chatId, data);
    const raw = await ask(
      'The family is reviewing their caregiver review before it posts. Return ONLY JSON: {"action": "confirm" | "cancel" | "edit_rating" | "edit_categories" | "edit_comment" | "edit_recommend" | "other", ' +
      '"rating": 1-5 or null, "comment": string or null, "recommend": true | false | null}. "confirm" = yes/post it/looks good. "cancel" = no/never mind. ' +
      '"edit_rating" = wants a different overall star count (set rating only if this message states it). "edit_categories" = wants to change the category ratings. ' +
      '"edit_comment" = wants to change the written review (set comment to the exact new text only if this message contains it). "edit_recommend" = wants to flip the recommend answer (set recommend only if stated). ' +
      '"other" = a question or anything else. Never invent values.',
      text,
    );
    parsed = parseJsonLoose(raw);
    action = parsed?.action;
  }
  if (action === "cancel") return handleBackOut(phone, chatId, data);
  if (action === "edit_rating") {
    if (isValidRating(parsed?.rating)) { await mergeFlowData(phone, { rating: parsed.rating }); await sendMessage(chatId, buildReviewRecap(await getFlowData(phone))); return; }
    await updateStep(phone, "rv_ask_rating"); await sendMessage(chatId, RATING_QUESTION(data.caregiverName)); return;
  }
  if (action === "edit_categories") { await updateStep(phone, "rv_ask_categories"); await sendMessage(chatId, CATEGORIES_QUESTION()); return; }
  if (action === "edit_comment") {
    const v = typeof parsed?.comment === "string" ? validateComment(parsed.comment) : null;
    if (v?.ok) { await mergeFlowData(phone, { comment: v.comment }); await sendMessage(chatId, buildReviewRecap(await getFlowData(phone))); return; }
    await updateStep(phone, "rv_ask_comment"); await sendMessage(chatId, COMMENT_QUESTION()); return;
  }
  if (action === "edit_recommend") {
    if (typeof parsed?.recommend === "boolean") { await mergeFlowData(phone, { wouldRecommend: parsed.recommend }); await sendMessage(chatId, buildReviewRecap(await getFlowData(phone))); return; }
    await updateStep(phone, "rv_ask_recommend"); await sendMessage(chatId, RECOMMEND_QUESTION(data.caregiverName)); return;
  }
  if (action !== "confirm") {
    if (await isQuestionOrOther(text, CONFIRM_FALLBACK)) {
      await sendMessage(chatId, await answerMidFlow(text, CONFIRM_FALLBACK));
      await sendMessage(chatId, CONFIRM_FALLBACK);
      return;
    }
    await sendMessage(chatId, buildReviewRecap(data));
    return;
  }

  // YES — the modal's Submit Review write.
  const clientId = session.userId as string | undefined;
  if (!clientId) { await sendMessage(chatId, "I couldn't find your account to post this review. Please try again."); return; }
  try {
    const res = await submitReview(clientId, data);
    if (!res.ok) {
      await clearFlow(phone);
      await sendMessage(chatId, res.reason === "duplicate"
        ? `Looks like you've already reviewed ${first(data.caregiverName)} — it's on their profile, so I didn't post a second one.`
        : "Something's missing from this review — let's start it again when you're ready.");
      return;
    }
    await clearFlow(phone);
    await sendMessage(chatId, `Posted — thank you! Your review of ${first(data.caregiverName)} is now on their profile.`);
  } catch (err) {
    console.error("[reviewFlow] submitReview error:", err);
    await sendMessage(chatId, "Sorry, I ran into a problem posting that review. Please try again.");
  }
}
