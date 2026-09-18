import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

const runtimeFiles = [
  "functions/src/utils/language.ts",
  "functions/src/agents/onboardingConversation.ts",
  "functions/src/linq/routeIntent.ts",
  "functions/src/linq/client.ts",
  "functions/src/linq/routeClient.ts",
  "functions/src/linq/routeCaregiver.ts",
  "functions/src/linq/webhooks.ts",
  "functions/src/agents/familyGroupManager.ts",
  "functions/src/agents/instantPayoutHandler.ts",
  "functions/src/agents/humanReply.ts",
  "functions/src/agents/stepHandler.ts",
  "functions/src/agents/caregiverProfileHandler.ts",
  "functions/src/agents/caregiverCancelShiftHandler.ts",
  "functions/src/agents/caregiverSwapHandler.ts",
  "functions/src/agents/shiftOffer.ts",
  "functions/src/agents/approvalHandler.ts",
  "functions/src/triggers/jobNotifications.ts",
  "functions/src/triggers/userCreated.ts",
  "functions/src/triggers/triggerEngine.ts",
  "functions/src/mcp/server.ts",
];

const bannedRuntimePhrases = [
  "Let me know if you need anything else",
  "how can I help today",
  "Please contact support",
  "Our team will follow up",
  "The support team will respond",
  "text the assistant anytime",
  "Our team will help resolve it",
  "Our team will review",
  "Give me a few minutes",
  "give me just a few minutes",
  "Give me a moment",
  "Let me get back",
  "Let me come back",
  "Here's what I can help you with",
  "your AI care assistant",
  "the AI care assistant",
  "an AI care assistant",
  "your care assistant",
  "AI care coordinator",
  "coordinadora de cuidados con IA",
  "get back to you shortly",
  "I'll get back to you",
];

describe("Evia runtime voice contract", () => {
  it("keeps known chatbot/support-punt phrases out of Evia-owned runtime replies", () => {
    const offenders: string[] = [];

    for (const relative of runtimeFiles) {
      const content = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      for (const phrase of bannedRuntimePhrases) {
        if (content.toLowerCase().includes(phrase.toLowerCase())) {
          offenders.push(`${relative}: ${phrase}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the client onboarding handoff out of the old directory-list dead end", () => {
    const content = fs.readFileSync(path.join(repoRoot, "functions/src/agents/onboardingConversation.ts"), "utf8");

    expect(content).not.toContain("Want me to set you up? (reply YES)");
    expect(content).not.toContain("Just reply YES when you're ready");
    expect(content).not.toContain("Reply YES to see your matches");
    expect(content).not.toContain("return `• ${name}");
    // Consent gate (2026-07-12): the pitch ends with an explicit ask and the
    // identity link goes out only AFTER the family says yes — never unrequested.
    expect(content).toContain("Want me to get you set up?");
    expect(content).toContain("Quick 30-second identity check first");
    expect(content).toContain('type: "link", value: identityUrl');
  });
});
