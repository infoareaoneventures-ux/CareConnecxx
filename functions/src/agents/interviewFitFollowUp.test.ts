import { describe, it, expect } from "vitest";
import { applyFitDecisionFollowUp } from "./interviewFitFollowUp";

const DETAILS = { interviewId: "iv-1", caregiverName: "Basra Yousuf" };

describe("applyFitDecisionFollowUp", () => {
  it("appends the fit question when complete_interview ran alone this turn", () => {
    const out = applyFitDecisionFollowUp({
      reply: "Great, glad it went well! I've marked the interview complete.",
      completedInterviewDetails: DETAILS,
      toolNamesThisTurn: ["complete_interview"],
    });
    expect(out).toContain("I've marked the interview complete.");
    expect(out).toContain("Would you like to move forward with Basra, or keep looking?");
  });

  it("does nothing when no interview was completed this turn", () => {
    const reply = "Sure, here's your schedule for the week.";
    expect(applyFitDecisionFollowUp({
      reply, completedInterviewDetails: null, toolNamesThisTurn: [],
    })).toBe(reply);
  });

  it("does not double-ask when submit_interview_feedback also ran this turn", () => {
    const reply = "Great, marked as a strong fit — I'll help you get them booked.";
    expect(applyFitDecisionFollowUp({
      reply,
      completedInterviewDetails: DETAILS,
      toolNamesThisTurn: ["complete_interview", "submit_interview_feedback"],
    })).toBe(reply);
  });

  it("does not double-ask when the model already asked the fit question on its own", () => {
    const reply = "Got it, marked complete! Would you like to move forward with Basra, or keep looking?";
    expect(applyFitDecisionFollowUp({
      reply,
      completedInterviewDetails: DETAILS,
      toolNamesThisTurn: ["complete_interview"],
    })).toBe(reply);
  });

  it("leaves an empty reply alone (e.g. a fully-handled self-delivering turn)", () => {
    expect(applyFitDecisionFollowUp({
      reply: "",
      completedInterviewDetails: DETAILS,
      toolNamesThisTurn: ["complete_interview"],
    })).toBe("");
  });

  it("falls back to \"them\" for a caregiver name with no readable first name", () => {
    const out = applyFitDecisionFollowUp({
      reply: "Marked complete.",
      completedInterviewDetails: { interviewId: "iv-2", caregiverName: "" },
      toolNamesThisTurn: ["complete_interview"],
    });
    expect(out).toContain("move forward with them, or keep looking?");
  });
});
