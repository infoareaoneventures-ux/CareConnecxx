// The Leave a Review modal in text — same fields, same limits, same document.
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: Object.assign(() => ({ collection: () => ({ doc: () => ({ collection: () => ({}) }) }) }), { FieldValue: { delete: () => "__del__", serverTimestamp: () => "__ts__" } }) }));
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn() }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn() }));
vi.mock("../stepHandler", () => ({ isBackOutRequest: vi.fn(), TRIVIAL_CONFIRM_WORDS: new Set(["YES"]), isQuestionOrOther: vi.fn(), answerMidFlow: vi.fn() }));
vi.mock("../caregiverProfilePage", () => ({ readCaregiverProfilePage: vi.fn() }));
vi.mock("../../config/appUrl", () => ({ getAppUrl: () => "https://eviacares.com" }));

import { validateComment, isValidRating, buildReviewRecap, reviewDocFor, REVIEW_COMMENT_MAX, RATING_QUESTION, RECOMMEND_QUESTION } from "../reviewFlow";
import { firstVisitReviewPromptLine, firstVisitReviewNotification, freshReviewPromptCaregiver, classifyReviewPromptReply, handleReviewPromptReply } from "../reviewPrompt";

describe("the modal's field rules", () => {
  it("rating is an integer 1–5", () => {
    expect(isValidRating(5)).toBe(true);
    expect(isValidRating(0)).toBe(false);
    expect(isValidRating(6)).toBe(false);
    expect(isValidRating(4.5)).toBe(false);
    expect(isValidRating("5")).toBe(false);
  });
  it("comment needs 10 characters and caps at 250 (the modal's counter and maxLength)", () => {
    expect(validateComment("  Great!  ")).toEqual({ ok: false, reason: "too_short" });
    expect(validateComment("Great with my dad")).toEqual({ ok: true, comment: "Great with my dad" });
    expect(validateComment("x".repeat(REVIEW_COMMENT_MAX + 1))).toEqual({ ok: false, reason: "too_long" });
  });
  it("questions follow the modal's order and use the first name", () => {
    expect(RATING_QUESTION("Basra Ali")).toBe("How was your experience with Basra? Overall rating, 1 to 5 stars.");
    expect(RECOMMEND_QUESTION("Basra Ali")).toBe("Would you recommend Basra? Reply YES or NO.");
  });
});

describe("recap + document", () => {
  const data = { caregiverId: "cg1", caregiverName: "Basra Ali", rating: 5, categories: { punctuality: 5, professionalism: 4, communication: 0, careQuality: 5 }, comment: "Kind and always on time", wouldRecommend: true };
  it("recap shows every field the modal has, skipped categories as Skipped", () => {
    const r = buildReviewRecap(data);
    expect(r).toContain("Overall: ★★★★★ (5/5)");
    expect(r).toContain("By category: Punctuality 5 · Professionalism 4 · Quality of Care 5");
    expect(r).toContain('Your review: "Kind and always on time"');
    expect(r).toContain("Would recommend: Yes");
    expect(buildReviewRecap({ ...data, categories: undefined })).toContain("By category: Skipped");
  });
  it("writes exactly LeaveReviewModal's document", () => {
    const doc = reviewDocFor({ clientId: "c1", clientName: "Hamse M", clientPhotoURL: null, caregiverId: "cg1", caregiverName: "Basra Ali", rating: 5, comment: "Kind and always on time", categories: data.categories, wouldRecommend: true, nowIso: "2026-09-19T10:00:00.000Z", serverTimestamp: "__ts__" });
    expect(Object.keys(doc)).toEqual(["clientId", "clientName", "clientPhotoURL", "caregiverId", "caregiverName", "rating", "comment", "categories", "wouldRecommend", "wouldRehire", "isPublic", "createdAt", "timestamp"]);
    expect(doc).toMatchObject({ wouldRehire: true, isPublic: true, createdAt: "2026-09-19T10:00:00.000Z", timestamp: "__ts__" });
    // No Evia-only markers (the old tool stamped source: cara_sms and appointmentId).
    expect(doc).not.toHaveProperty("source");
    expect(doc).not.toHaveProperty("appointmentId");
  });
});

describe("first-visit prompt", () => {
  it("recap line and bell copy name the caregiver by first name", () => {
    expect(firstVisitReviewPromptLine("Basra Ali")).toContain("This was your first visit with Basra — want to leave a review? Reply with 1 to 5 stars");
    expect(firstVisitReviewNotification("Basra Ali", "cg1", "s1")).toEqual({ type: "review_prompt", title: "How was your first visit?", body: "Leave a review for Basra — it helps other families choose.", data: { caregiverId: "cg1", shiftId: "s1" } });
  });
  it("the anchor is fresh for 24h", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const s = { pendingReviewPromptCaregiverId: "cg1", pendingReviewPromptCaregiverName: "Basra Ali", pendingReviewPromptSetAt: "2026-09-19T00:00:00Z" };
    expect(freshReviewPromptCaregiver(s, now)).toEqual({ caregiverId: "cg1", caregiverName: "Basra Ali" });
    expect(freshReviewPromptCaregiver({ ...s, pendingReviewPromptSetAt: "2026-09-17T00:00:00Z" }, now)).toBeNull();
    expect(freshReviewPromptCaregiver({}, now)).toBeNull();
  });
  it("classifies through the model, never regex: a star count starts with the rating, no thanks declines, anything else passes through", async () => {
    const complete = async (_s: string, u: string) => u === "5" ? '{"action":"start","rating":5}' : u === "no thanks" ? '{"action":"decline","rating":null}' : '{"action":"other","rating":null}';
    expect(await classifyReviewPromptReply("5", complete)).toEqual({ kind: "start", rating: 5 });
    expect(await classifyReviewPromptReply("no thanks", complete)).toEqual({ kind: "decline" });
    expect(await classifyReviewPromptReply("when is the next visit", complete)).toEqual({ kind: "other" });
  });
  it("a star reply starts the review flow with the rating prefilled; a decline clears the anchor; other turns are not consumed", async () => {
    const session = { userId: "c1", pendingReviewPromptCaregiverId: "cg1", pendingReviewPromptCaregiverName: "Basra Ali", pendingReviewPromptSetAt: new Date().toISOString() };
    const deps = { startReviewFlow: vi.fn(async () => ({ started: true })), sendMessage: vi.fn(async () => undefined), clearAnchor: vi.fn(async () => undefined), classify: vi.fn() };
    deps.classify.mockResolvedValueOnce({ kind: "start", rating: 4 });
    expect(await handleReviewPromptReply({ phone: "+1", chatId: "ch", text: "4", session }, deps)).toBe(true);
    expect(deps.startReviewFlow).toHaveBeenCalledWith("+1", "ch", session, { caregiverId: "cg1", rating: 4 });
    deps.classify.mockResolvedValueOnce({ kind: "decline" });
    expect(await handleReviewPromptReply({ phone: "+1", chatId: "ch", text: "not now", session }, deps)).toBe(true);
    expect(deps.clearAnchor).toHaveBeenCalledWith("+1");
    expect(deps.sendMessage).toHaveBeenCalledWith("ch", expect.stringContaining("Basra's profile"));
    deps.classify.mockResolvedValueOnce({ kind: "other" });
    expect(await handleReviewPromptReply({ phone: "+1", chatId: "ch", text: "what time tomorrow", session }, deps)).toBe(false);
    expect(await handleReviewPromptReply({ phone: "+1", chatId: "ch", text: "5", session: {} }, deps)).toBe(false);
  });
});
