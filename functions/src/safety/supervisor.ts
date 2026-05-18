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

    const raw = ((result.content[0] as { text: string }).text ?? "").trim();
    // Strip markdown code fences if model wraps the JSON
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

    let parsed: { violation: boolean; revised: string } | null = null;
    try {
      const candidate = JSON.parse(jsonText) as unknown;
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        "violation" in candidate &&
        "revised" in candidate &&
        typeof (candidate as any).revised === "string"
      ) {
        parsed = candidate as { violation: boolean; revised: string };
      } else {
        console.warn("supervisor: unexpected JSON shape, falling back to linted message", { jsonText: jsonText.slice(0, 100) });
      }
    } catch (parseErr) {
      console.warn("supervisor: failed to parse JSON response, falling back to linted message", {
        raw: raw.slice(0, 100),
        error: String(parseErr),
      });
    }

    if (parsed?.violation && parsed.revised) {
      // Log to safety log (non-blocking)
      db.collection("agent_safety_log").add({
        phone:     context.phone,
        role:      context.role ?? "client",
        original:  message,
        revised:   parsed.revised,
        loggedAt:  new Date().toISOString(),
      }).catch(() => {});

      checked = parsed.revised;
    } else if (!parsed) {
      // JSON parse failed — linted message is already the safe fallback
      console.info("supervisor: using linted message as fallback", { phone: context.phone });
    }
  } catch (err) {
    // Supervisor Claude call failed — fall back to linted message
    console.warn("supervisor: Claude call failed, using linted message", { error: String(err) });
  }

  return checked;
}
