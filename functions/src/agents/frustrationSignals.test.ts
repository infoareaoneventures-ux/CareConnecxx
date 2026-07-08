import { describe, expect, it } from "vitest";
import { detectFrustrationSignals, normalize, detectAgentSelfRepeat } from "./frustrationSignals";

describe("frustrationSignals", () => {
  it("normalizes punctuation and casing without keeping formatting noise", () => {
    expect(normalize("Hey, Evia!!")).toBe("hey evia");
  });

  it("flags explicit frustration and missing-link complaints", () => {
    expect(detectFrustrationSignals({ text: "Evia still didn't send the link" })).toMatchObject({
      frustrationDetected: true,
    });
    expect(detectFrustrationSignals({ text: "this is horrible, I need a real person" })).toMatchObject({
      frustrationDetected: true,
    });
  });

  it("flags repeated greeting loops without treating a first greeting as frustrated", () => {
    expect(detectFrustrationSignals({ text: "Hey cara" })).toEqual({
      frustrationDetected: false,
      rephraseLoopDetected: false,
      repeatedGreetingDetected: false,
    });

    expect(detectFrustrationSignals({
      text: "Hey cara",
      recentHistory: [
        { role: "user", content: "hey cara" },
        { role: "assistant", content: "I am checking that now." },
      ],
    })).toMatchObject({
      repeatedGreetingDetected: true,
    });
  });

  it("flags repeated or closely rephrased requests", () => {
    expect(detectFrustrationSignals({
      text: "can you please send me the setup link for my mom",
      recentHistory: [
        { role: "user", content: "please send the setup link for my mom" },
        { role: "assistant", content: "I am checking that now." },
      ],
    })).toMatchObject({
      rephraseLoopDetected: true,
    });
  });

  it("does not flag ordinary short replies", () => {
    expect(detectFrustrationSignals({
      text: "yes",
      recentHistory: [{ role: "user", content: "no" }],
    })).toEqual({
      frustrationDetected: false,
      rephraseLoopDetected: false,
      repeatedGreetingDetected: false,
    });
  });
});

describe("detectAgentSelfRepeat (ch10 broken-record)", () => {
  it("flags a near-duplicate of Evia's own recent outbound (the loop bug's actual shape)", () => {
    // The confirm-name loop re-sent near-identical text, not a paraphrase — the
    // guard is tuned (0.8) to catch that, and to leave legitimate rephrasings be.
    const prior = "Just to confirm, do you go by Anahi or do you prefer a different name?";
    const candidate = "Just to confirm, do you go by Anahi or do you prefer a different first name?";
    const r = detectAgentSelfRepeat(candidate, [
      { role: "user", content: "hi" },
      { role: "assistant", content: prior },
    ]);
    expect(r.repeated).toBe(true);
    expect(r.matchedPrior).toBe(prior);
  });

  it("leaves a genuine rephrasing of the same intent alone (no false positive)", () => {
    const prior = "Happy to help — do you go by Anahi, or do you prefer another name?";
    const candidate = "Would you rather I call you something other than Anahi?";
    expect(detectAgentSelfRepeat(candidate, [{ role: "assistant", content: prior }]).repeated).toBe(false);
  });

  it("catches a verbatim resend", () => {
    const msg = "What time works best for the visit on Thursday?";
    expect(detectAgentSelfRepeat(msg, [{ role: "assistant", content: msg }]).repeated).toBe(true);
  });

  it("only compares against ASSISTANT messages, not the user's", () => {
    const msg = "please send the caregiver setup link for my mother today";
    // Same text but spoken by the USER — not a self-repeat.
    expect(detectAgentSelfRepeat(msg, [{ role: "user", content: msg }]).repeated).toBe(false);
  });

  it("does not flag genuinely different replies", () => {
    const r = detectAgentSelfRepeat("Your caregiver Maria is confirmed for 9am Tuesday.", [
      { role: "assistant", content: "Do you go by Anahi, or another name?" },
    ]);
    expect(r.repeated).toBe(false);
  });

  it("ignores the synthetic history-summary assistant line", () => {
    const summary = "Got it - I have context on this family and the ongoing care.";
    expect(detectAgentSelfRepeat(summary, [{ role: "assistant", content: summary }]).repeated).toBe(false);
  });

  it("does not flag very short replies (below the min-length floor)", () => {
    expect(detectAgentSelfRepeat("Sounds good!", [{ role: "assistant", content: "Sounds good!" }]).repeated).toBe(false);
  });

  // Regression: the caregiver job-type double-ask (founder test, 2026-07-08). The
  // repeated QUESTION sentence is identical, but a different intro sentence dilutes
  // the whole-message Jaccard below 0.8 — the sentence-level check must catch it.
  it("catches an identical question sentence hidden behind a different intro (job-type double-ask)", () => {
    const prior = "Morning weekday availability is great. Are you looking for occasional, part-time, or full-time work?";
    const candidate = "Got it. Are you looking for occasional, part-time, or full-time work?";
    const r = detectAgentSelfRepeat(candidate, [
      { role: "user", content: "Full time" },
      { role: "assistant", content: prior },
    ]);
    expect(r.repeated).toBe(true);
    expect(r.matchedPrior).toBe(prior);
  });

  it("does not flag two DIFFERENT question sentences that share an intro word", () => {
    const prior = "Got it. What's your city or ZIP so I can check we cover your area?";
    const candidate = "Got it. What hourly rate are you hoping for?";
    expect(detectAgentSelfRepeat(candidate, [{ role: "assistant", content: prior }]).repeated).toBe(false);
  });
});
