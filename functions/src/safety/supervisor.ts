import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { lintMessage } from "./linter";
import { CONSTITUTION_RULES } from "./constitution";

const db = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

export interface SuperviseContext {
  phone: string;
  role?: "client" | "caregiver";
}

export async function supervise(
  message: string,
  context: SuperviseContext
): Promise<string> {
  // Step 1: lint (synchronous, no LLM)
  const linted = lintMessage(message);

  // Step 2: constitution check via Claude Haiku
  let checked = linted;
  try {
    const rulesText = CONSTITUTION_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
    const result = await getClaude().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        `You are a safety reviewer for a caregiving AI assistant named Cara. ` +
        `Check if the message below violates any of these rules:\n${rulesText}\n\n` +
        `Reply with ONLY valid JSON in this exact format: ` +
        `{"violation": false, "revised": "..."} ` +
        `If no violation, set violation to false and revised to the original message. ` +
        `If a violation, set violation to true and revised to a safe rewrite that still addresses the user's need. ` +
        `Never change the friendly tone or add formal language.`,
      messages: [{ role: "user", content: linted }],
    });

    const raw = (result.content[0] as { text: string }).text ?? "";
    const parsed = JSON.parse(raw) as { violation: boolean; revised: string };

    if (parsed.violation && parsed.revised) {
      // Log to safety log (non-blocking)
      db.collection("agent_safety_log").add({
        phone:     context.phone,
        role:      context.role ?? "client",
        original:  message,
        revised:   parsed.revised,
        loggedAt:  new Date().toISOString(),
      }).catch(() => {});

      checked = parsed.revised;
    }
  } catch {
    // Supervisor failure is non-critical — fall back to linted message
  }

  return checked;
}
