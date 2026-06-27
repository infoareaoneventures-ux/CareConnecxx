import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

const runtimeFiles = [
  "functions/src/linq/routeIntent.ts",
  "functions/src/linq/routeClient.ts",
  "functions/src/linq/routeCaregiver.ts",
  "functions/src/linq/webhooks.ts",
  "functions/src/agents/familyGroupManager.ts",
  "functions/src/agents/healthcareHandler.ts",
  "functions/src/agents/instantPayoutHandler.ts",
  "functions/src/agents/refundHandler.ts",
  "functions/src/agents/shiftOffer.ts",
  "functions/src/agents/approvalHandler.ts",
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
];

describe("Cara runtime voice contract", () => {
  it("keeps known chatbot/support-punt phrases out of Cara-owned runtime replies", () => {
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
});
