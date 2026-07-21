import { describe, it, expect, vi, beforeEach } from "vitest";

// The link-promise net: when the onboarding model NARRATES a link ("I'll send
// it here") without calling send_onboarding_link, the net delivers the step's
// link deterministically — and on failure records a tracked `link` commitment
// instead of going silent (the 2026-07-07 live-test bug).

const hoisted = vi.hoisted(() => {
  const sessionData: Record<string, unknown> = { onboardingStep: "caregiver_send_photo" };
  const quickComplete = vi.fn(async (..._a: unknown[]) => "YES");
  const sendOnboardingLink = vi.fn(async (..._a: unknown[]) => ({ success: true, linkType: "caregiver_photo" }));
  const recordCommitment = vi.fn(async (..._a: unknown[]) => "id-1");
  return { sessionData, quickComplete, sendOnboardingLink, recordCommitment };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({
    collection: () => ({
      doc: () => ({ get: vi.fn(async () => ({ exists: true, data: () => hoisted.sessionData })) }),
    }),
  });
  firestore.FieldValue = { delete: () => "__delete__" };
  return { __esModule: true, default: { firestore }, firestore };
});

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...a: unknown[]) => hoisted.quickComplete(...a),
}));
vi.mock("./commitmentTracker", () => ({
  recordCommitment: (...a: unknown[]) => hoisted.recordCommitment(...a),
}));
vi.mock("./onboardingConversation", () => ({
  sendOnboardingLink: (...a: unknown[]) => hoisted.sendOnboardingLink(...a),
}));

import { fulfillNarratedLinkPromise } from "./linkPromiseNet";

const BASE = { phone: "+15551112222", chatId: "chat-1", userType: "caregiver" as const };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.sessionData.onboardingStep = "caregiver_send_photo";
  hoisted.quickComplete.mockResolvedValue("YES");
  hoisted.sendOnboardingLink.mockResolvedValue({ success: true, linkType: "caregiver_photo" });
});

describe("fulfillNarratedLinkPromise", () => {
  it("delivers the step's link when the reply narrates a link and no tool fired", async () => {
    await fulfillNarratedLinkPromise({ ...BASE, reply: "I'm pulling up your secure photo link — I'll send it here." });

    expect(hoisted.sendOnboardingLink).toHaveBeenCalledWith("+15551112222", "caregiver_photo");
    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });

  it("does nothing when the reply never mentions a link (prescreen, no LLM call)", async () => {
    await fulfillNarratedLinkPromise({ ...BASE, reply: "Great, what's your hourly rate?" });

    expect(hoisted.quickComplete).not.toHaveBeenCalled();
    expect(hoisted.sendOnboardingLink).not.toHaveBeenCalled();
  });

  it("does nothing when the classifier says the reply is not a link promise", async () => {
    hoisted.quickComplete.mockResolvedValue("NO");
    await fulfillNarratedLinkPromise({ ...BASE, reply: "Just tap the link I sent you earlier." });

    expect(hoisted.sendOnboardingLink).not.toHaveBeenCalled();
    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });

  it("does nothing on collection steps (the gate-handoff nets own that transition)", async () => {
    hoisted.sessionData.onboardingStep = "caregiver_ask_bio";
    await fulfillNarratedLinkPromise({ ...BASE, reply: "Lovely — I'll send your photo link next." });

    expect(hoisted.sendOnboardingLink).not.toHaveBeenCalled();
  });

  it("maps the bg-check step to caregiver_background_check", async () => {
    hoisted.sessionData.onboardingStep = "caregiver_awaiting_bgcheck";
    hoisted.sendOnboardingLink.mockResolvedValue({ success: true, linkType: "caregiver_background_check" });
    await fulfillNarratedLinkPromise({ ...BASE, reply: "I'll text you the background check link right now." });

    expect(hoisted.sendOnboardingLink).toHaveBeenCalledWith("+15551112222", "caregiver_background_check");
  });

  it("records a tracked link commitment when deterministic delivery fails", async () => {
    hoisted.sendOnboardingLink.mockRejectedValue(new Error("checkr down"));
    await fulfillNarratedLinkPromise({ ...BASE, reply: "I'm sending your photo link now." });

    expect(hoisted.recordCommitment).toHaveBeenCalledWith(expect.objectContaining({
      kind:     "link",
      linkType: "caregiver_photo",
      phone:    "+15551112222",
    }));
  });

  it("records a commitment when delivery reports success:false", async () => {
    hoisted.sendOnboardingLink.mockResolvedValue({ success: false, linkType: "caregiver_photo" });
    await fulfillNarratedLinkPromise({ ...BASE, reply: "I'm sending your photo link now." });

    expect(hoisted.recordCommitment).toHaveBeenCalledWith(expect.objectContaining({ kind: "link" }));
  });

  it("fails closed to NO when the classifier throws (no send, no commitment)", async () => {
    hoisted.quickComplete.mockRejectedValue(new Error("provider down"));
    await fulfillNarratedLinkPromise({ ...BASE, reply: "I'm sending your photo link now." });

    expect(hoisted.sendOnboardingLink).not.toHaveBeenCalled();
    expect(hoisted.recordCommitment).not.toHaveBeenCalled();
  });
});
