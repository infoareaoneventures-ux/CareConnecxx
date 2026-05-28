import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { lintMessage } from "./linter";
import { CONSTITUTION_RULES } from "./constitution";

const db = admin.firestore();

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
    const result = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        `You are a safety reviewer for a caregiving AI assistant named Cara. ` +
        `Cara texts with the family member responsible for a senior's care, and with caregivers about the clients they serve — ` +
        `discussing that senior's care plan, onboarding, schedule, caregivers, medications, or general care needs with the ` +
        `responsible party is the entire point of the product and is NEVER a violation of Rule 3. Rule 3 only applies when ` +
        `Cara would disclose one family's data to a different, unrelated user.\n\n` +
        `Check if the message below clearly and unambiguously violates one of these rules:\n${rulesText}\n\n` +
        `Bias strongly toward {"violation": false}. Only flag a violation when the rule is broken in a concrete, specific way ` +
        `(e.g. Cara diagnoses a condition, prescribes a dose, quotes an unconfirmed price, fabricates an appointment). ` +
        `Ambiguity, hedging, or "this could be sensitive" feelings are NOT violations.\n\n` +
        `If you do rewrite, the rewrite MUST be a minimal edit that preserves the original meaning and warm tone. ` +
        `It MUST NOT introduce boilerplate refusals, third-party handoffs, or any of these forbidden phrases: ` +
        `"I'm not able to", "I cannot", "I am unable", "For privacy and security reasons", "contact our care team", ` +
        `"our main number", "our team will", "have the family member contact", "Is there anything else". ` +
        `Cara is the team — she never punts the user to a separate human team or phone number.\n\n` +
        `Reply with ONLY valid JSON in this exact format: ` +
        `{"violation": false, "revised": "..."} ` +
        `When no violation, set violation to false and copy the original message verbatim into revised.`,
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
      // Re-lint the rewrite: Haiku sometimes injects phrases Cara isn't allowed
      // to use ("I'm not able to", "Is there anything else I can help you with",
      // "contact our care team"). Without this pass those bypass the upfront
      // linter and end up in the SMS the user sees.
      const relinted = lintMessage(parsed.revised);

      // Log to safety log (non-blocking)
      db.collection("agent_safety_log").add({
        phone:     context.phone,
        role:      context.role ?? "client",
        original:  message,
        revised:   relinted,
        loggedAt:  new Date().toISOString(),
      }).catch(() => {});

      // If the rewrite collapsed to punctuation/whitespace only (every meaningful
      // clause was a banned phrase that got stripped), prefer the original linted
      // message over a hollow ". . ." artifact. We test for "has a real word
      // remaining" rather than non-empty because the linter leaves trailing
      // periods and commas behind when it removes banned phrases.
      const hasContent = /[A-Za-z0-9]{2,}/.test(relinted);
      checked = hasContent ? relinted : linted;
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
