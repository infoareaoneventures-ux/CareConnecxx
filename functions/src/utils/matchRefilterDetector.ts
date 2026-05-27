import { quickComplete } from "./openaiClient";

// Detects when a family member, mid-presentation of caregiver matches, is asking
// to change the search criteria rather than picking from the list shown. Returns
// a structured refilter intent (which fields to adjust + direction) or null.
//
// Examples that should match:
//   "show me cheaper ones"             → { rate: { direction: "lower" } }
//   "any with dementia experience"     → { skills: ["dementia"] }
//   "anyone available Saturday"        → { availability: { days: ["saturday"] } }
//   "I'd prefer a woman"               → { genderPreference: "female" }
//   "Spanish-speaking?"                → { languages: ["spanish"] }
//   "anyone within 10 minutes"         → { distance: { direction: "closer" } }
//   "earlier in the morning"           → { timeOfDay: "morning" }
//
// Should NOT match:
//   "1", "2 and 3", "all of them"      → selection (handled separately)
//   "what's #2's rate?"                → question (handled by question guard)
//   "is alice good with mobility?"     → question

export interface RefilterIntent {
  // Anything provided overrides the existing search filter for the next match run.
  rate?:              { direction: "lower" | "higher" };
  skills?:            string[];                       // additive — append to existing
  availability?:      { days?: string[]; timeOfDay?: "morning" | "afternoon" | "evening" };
  genderPreference?:  "female" | "male" | "no_preference";
  languages?:         string[];                       // additive
  distance?:          { direction: "closer" | "wider" };
  experienceYears?:   { min?: number };
  /** Plain-English summary Cara echoes back to the family. */
  summary:            string;
}

export async function detectMatchRefilter(text: string): Promise<RefilterIntent | null> {
  if (text.trim().length < 4) return null;

  let raw = "";
  try {
    raw = await quickComplete(
      "Cara just showed a family member 3 caregiver options. They replied — is their reply a request " +
      "to change the search criteria (e.g. \"cheaper\", \"any with dementia experience\", \"available Saturday\", " +
      "\"a woman\", \"Spanish-speaking\")?\n\n" +
      "If YES, reply with JSON ONLY in this exact shape:\n" +
      "{\n" +
      "  \"isRefilter\": true,\n" +
      "  \"rate\": {\"direction\": \"lower\"|\"higher\"} | null,\n" +
      "  \"skills\": [\"dementia\", \"mobility\", ...] | null,\n" +
      "  \"availability\": {\"days\": [\"monday\", ...] | null, \"timeOfDay\": \"morning\"|\"afternoon\"|\"evening\" | null} | null,\n" +
      "  \"genderPreference\": \"female\"|\"male\"|\"no_preference\" | null,\n" +
      "  \"languages\": [\"spanish\", ...] | null,\n" +
      "  \"distance\": {\"direction\": \"closer\"|\"wider\"} | null,\n" +
      "  \"experienceYears\": {\"min\": <number>} | null,\n" +
      "  \"summary\": \"one short phrase Cara can repeat back, e.g. 'cheaper ones with dementia experience'\"\n" +
      "}\n\n" +
      "If NO (selection like \"1\", question, off-topic), reply with: {\"isRefilter\": false}\n" +
      "Only include fields the user explicitly mentioned. Use null for fields they didn't mention. " +
      "Reply ONLY with the JSON object — no prose.",
      text,
      { maxTokens: 200 },
    );
  } catch {
    return null;
  }

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!cleaned.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (parsed.isRefilter !== true) return null;
    if (!parsed.summary || typeof parsed.summary !== "string") return null;

    const intent: RefilterIntent = { summary: (parsed.summary as string).slice(0, 200) };
    if (parsed.rate)             intent.rate             = parsed.rate as any;
    if (parsed.skills)           intent.skills           = parsed.skills as any;
    if (parsed.availability)     intent.availability     = parsed.availability as any;
    if (parsed.genderPreference) intent.genderPreference = parsed.genderPreference as any;
    if (parsed.languages)        intent.languages        = parsed.languages as any;
    if (parsed.distance)         intent.distance         = parsed.distance as any;
    if (parsed.experienceYears)  intent.experienceYears  = parsed.experienceYears as any;

    // Ignore objects that have isRefilter=true but no actionable changes
    const hasAny = !!(intent.rate || intent.skills?.length || intent.availability ||
      intent.genderPreference || intent.languages?.length || intent.distance ||
      intent.experienceYears);
    if (!hasAny) return null;

    return intent;
  } catch {
    return null;
  }
}
