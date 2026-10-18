import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { lintMessage, enforceCareProviderTerm } from "./linter";
import { CONSTITUTION_RULES } from "./constitution";

const db = admin.firestore();

export interface SuperviseContext {
  phone: string;
  role?: "client" | "caregiver";
  /**
   * The message is a FIXED string — a lifecycle notice, a reminder, a page's own
   * sentence — i.e. the founder's words, not the model's (caregiver sweep C12,
   * 2026-10-11). The reviewer may BLOCK such a message, never rephrase it: the
   * linter does not touch it either, and a flagged violation returns null from
   * reviewFixedString instead of a rewrite.
   */
  fixedString?: boolean;
}

interface ReviewVerdict { violation: boolean; revised: string | null }

/** The constitution check itself (Haiku), shared by supervise() and reviewFixedString(). Throws on a call failure. */
async function reviewWithModel(text: string, role: SuperviseContext["role"]): Promise<ReviewVerdict | null> {
  const rulesText = CONSTITUTION_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const roleNote = supervisorRoleNote(role);
  const result = await getSharedClient().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system:
      `You are a safety reviewer for a caregiving AI assistant named Evia. ` +
      `Evia texts with the family member responsible for a care recipient's care (an older adult or a child), and with care providers about the clients they serve — ` +
      `discussing that care recipient's care plan, onboarding, schedule, care providers, or general care needs with the ` +
      `responsible party is the entire point of the product and is NEVER a violation of Rule 3. Rule 3 only applies when ` +
      `Evia would disclose one family's data to a different, unrelated user.\n\n` +
      `Check if the message below clearly and unambiguously violates one of these rules:\n${rulesText}\n\n` +
      `Bias strongly toward {"violation": false}. Only flag a violation when the rule is broken in a concrete, specific way ` +
      `(e.g. Evia diagnoses a condition, prescribes a dose, quotes an unconfirmed price, fabricates an appointment). ` +
      `Ambiguity, hedging, or "this could be sensitive" feelings are NOT violations.\n\n` +
      `If you do rewrite, the rewrite MUST be a minimal edit that preserves the original meaning and warm tone. ` +
      `It MUST NOT introduce boilerplate refusals, third-party handoffs, or any of these forbidden phrases: ` +
      `"I'm not able to", "I cannot", "I am unable", "For privacy and security reasons", "contact our care team", ` +
      `"our main number", "our team will", "have the family member contact", "Is there anything else". ` +
      `Evia is the team — she never punts the user to a separate human team or phone number.\n\n` +
      roleNote +
      `Reply with ONLY valid JSON in this exact format: ` +
      `{"violation": false, "revised": "..."} ` +
      `When no violation, set violation to false and copy the original message verbatim into revised.`,
    messages: [{ role: "user", content: text }],
  });

  const raw = ((result.content[0] as { text: string }).text ?? "").trim();
  // Strip fences, then keep only the outermost {...} — the model sometimes
  // adds a trailing note after the closing fence, which broke JSON.parse and
  // silently dropped the rewrite (live 2026-09-20).
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const braceStart = unfenced.indexOf("{"); const braceEnd = unfenced.lastIndexOf("}");
  const jsonText = braceStart >= 0 && braceEnd > braceStart ? unfenced.slice(braceStart, braceEnd + 1) : unfenced;
  try {
    const candidate = JSON.parse(jsonText) as unknown;
    if (candidate !== null && typeof candidate === "object" && "violation" in candidate && "revised" in candidate && typeof (candidate as any).revised === "string") {
      return { violation: (candidate as any).violation === true, revised: (candidate as any).revised as string };
    }
    console.warn("supervisor: unexpected JSON shape, falling back to the original message", { jsonText: jsonText.slice(0, 100) });
  } catch (parseErr) {
    console.warn("supervisor: failed to parse JSON response, falling back to the original message", { raw: raw.slice(0, 100), error: String(parseErr) });
  }
  return null;
}

/**
 * Fixed strings (C12): the reviewer may block, never rephrase. Resolves true when the
 * message may go out exactly as written, false when the constitution check flagged a
 * concrete violation (logged to agent_safety_log with action "blocked" + an admin
 * alert so a wrongly blocked notice is seen). A reviewer outage fails OPEN — a
 * founder-worded notice is never lost to a model hiccup.
 */
export async function reviewFixedString(message: string, context: SuperviseContext): Promise<boolean> {
  let verdict: ReviewVerdict | null = null;
  try {
    verdict = await reviewWithModel(message, context.role);
  } catch (err) {
    console.warn("supervisor: Claude call failed on a fixed string, sending as written", { error: String(err) });
    return true;
  }
  if (!verdict?.violation) return true;
  const loggedAt = new Date().toISOString();
  db.collection("agent_safety_log").add({
    phone: context.phone, role: context.role ?? "client", original: message, revised: null, action: "blocked", fixedString: true, loggedAt,
  }).catch(() => {});
  db.collection("admin_alerts").add({
    type: "fixed_string_blocked", severity: "high", resolved: false, phone: context.phone,
    preview: message.slice(0, 200), reviewerRewrite: (verdict.revised ?? "").slice(0, 200), createdAt: loggedAt,
    message: "The safety reviewer blocked a fixed notice (lifecycle text / reminder). Fixed strings are never rephrased — check the wording or the rule.",
  }).catch(() => {});
  return false;
}

/**
 * Who Evia is texting changes what a "price" is. Live 2026-10-07: a caregiver set her own rates (1 person $15,
 * 2 people $35, 3+ $44) and the reviewer, reading rule 4 as the family-side rule, rewrote Evia's confirmation
 * into "I can only reference rates directly confirmed by each caregiver" — family wording sent to the caregiver.
 */
export function supervisorRoleNote(role: "client" | "caregiver" | undefined): string {
  if (role === "caregiver") {
    return "The user in this conversation is a CARE PROVIDER, texting about their own account, profile, rates, shifts and pay. " +
      "Rates they state are THEIR OWN rates for their own profile — repeating or confirming them is never \"quoting an unconfirmed price\" " +
      "(rule 4 is about quoting a care provider's rate to a FAMILY). Never add family-side wording such as \"confirmed with your care providers\" or \"each care provider\".\n\n";
  }
  return "The user in this conversation is a FAMILY member arranging care.\n\n";
}

export async function supervise(
  message: string,
  context: SuperviseContext
): Promise<string> {
  // A fixed string never goes through the rewriting path (C12): callers that
  // want the block-only review use reviewFixedString; a stray caller landing
  // here with the flag set gets the message back untouched.
  if (context.fixedString) return message;

  // Step 1: lint (synchronous, no LLM) — model-written text only (fixed strings
  // returned above), so the care-provider wording rule applies here too.
  const linted = enforceCareProviderTerm(lintMessage(message));

  // Step 2: constitution check via Claude Haiku
  let checked = linted;
  try {
    const parsed = await reviewWithModel(linted, context.role);

    if (parsed?.violation && parsed.revised) {
      // Re-lint the rewrite: Haiku sometimes injects phrases Evia isn't allowed
      // to use ("I'm not able to", "Is there anything else I can help you with",
      // "contact our care team"). Without this pass those bypass the upfront
      // linter and end up in the SMS the user sees.
      const relinted = enforceCareProviderTerm(lintMessage(parsed.revised));

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
