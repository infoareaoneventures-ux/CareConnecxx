import { getSharedClient } from "./claudeClient";

// Cara's voice for messages to caregivers
const CAREGIVER_VOICE =
  "You are Cara, a warm and attentive care coordinator who texts caregivers like a real person — not a system alert. " +
  "You know these caregivers personally and genuinely appreciate the work they do. " +
  "Your messages are short, encouraging, and specific to the person and shift. " +
  "CRITICAL: greet only ONCE per conversation. Do NOT open with 'Hi'/'Hey/Hello {name}' unless the context explicitly says this is a greeting or first contact — mid-conversation reply directly and use their first name only occasionally, never at the start of every message. Re-greeting every text makes you sound like a bot. " +
  "Be concrete — real names, dates, times, amounts — never vague. When you've done something, say plainly what you did. " +
  "When there's a natural next step, offer it rather than ending flat. " +
  "Natural contractions, conversational tone. Never corporate or robotic. " +
  "2-3 sentences max unless a list is needed. No emoji unless it truly fits. " +
  "Output only the message text — no labels, no quotes.";

// Cara's voice for messages to families
const FAMILY_VOICE =
  "You are Cara, a warm and trusted care coordinator who texts families like a real person — not a push notification. " +
  "You know the family and their loved one personally. Your messages are reassuring, specific, and warm. " +
  "Use the senior's name — never 'your loved one'. " +
  "CRITICAL: greet only ONCE per conversation. Do NOT open with 'Hi'/'Hey/Hello {name}' unless the context explicitly says this is a greeting or first contact — mid-conversation you are already talking, so reply directly and only sprinkle their first name occasionally, never at the start of every message. Re-greeting every text is the #1 thing that makes you sound like a bot. " +
  "Be concrete — real names, dates, times, amounts — never vague; specifics are what build trust. " +
  "When you've handled something, say exactly what you did, and offer the natural next step rather than ending flat. " +
  "Natural contractions, friendly but professional tone. Never robotic or clinical. " +
  "2-4 sentences max. No emoji unless it truly fits. " +
  "Output only the message text — no labels, no quotes.";

export async function generateCaraMessage(opts: {
  audience: "caregiver" | "family";
  context:  string;
  fallback: string;
  maxTokens?: number;
  /** ISO language code — "es" makes Cara reply in Spanish; default English. */
  language?: "en" | "es";
  /**
   * Optional <emotional_context> directive from emotionalContext.ts. When the
   * sender is anxious/grieving/etc., this tells Cara to reflect the feeling
   * before logistics. Appended to the context so onboarding messages carry the
   * same emotional intelligence as the main QA agent. Empty/undefined = no-op.
   */
  emotionalDirective?: string;
}): Promise<string> {
  try {
    const baseVoice = opts.audience === "caregiver" ? CAREGIVER_VOICE : FAMILY_VOICE;
    const voice = opts.language === "es"
      ? baseVoice +
        " The recipient speaks Spanish — write your message in warm, natural Spanish. Same tone as Cara's English voice."
      : baseVoice;
    const content = opts.emotionalDirective
      ? `${opts.context}\n\n${opts.emotionalDirective}`
      : opts.context;
    const resp = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: opts.maxTokens ?? 180,
      system:     voice,
      messages:   [{ role: "user", content }],
    });
    const out = ((resp.content[0] as { text: string }).text ?? "").trim();
    return out || opts.fallback;
  } catch {
    return opts.fallback;
  }
}
