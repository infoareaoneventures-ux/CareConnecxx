import { quickComplete } from "./openaiClient";

// Persona shift detector — catches the shared-phone case where two family
// members text Cara from the same line. Phone is the session key, so without
// this check Aunt's message about her dad would get routed to Mom's care plan
// and any booking/matching would fire under Mom's userId.
//
// Heuristic: if the inbound mentions a senior name that doesn't match the
// session's senior, OR explicitly references "my mom / my dad / my [parent]"
// while the session is set up for an unrelated name, flag it. We only run on
// "complete" sessions — onboarding flows already self-reset via START OVER.

export interface PersonaShift {
  kind:        "different_senior" | "different_role";
  evidence:    string;   // user-facing quote so Cara's question feels grounded
  sessionSenior?: string;
}

export async function detectPersonaShift(params: {
  text:           string;
  sessionSenior?: string;       // senior name on file for this session
  sessionRole?:   "client" | "caregiver" | null;
}): Promise<PersonaShift | null> {
  const { text, sessionSenior, sessionRole } = params;
  if (!text.trim()) return null;

  // Short messages with no entity content aren't worth an LLM call.
  if (text.trim().length < 12) return null;

  const sessionContext = [
    sessionSenior ? `Senior on file: ${sessionSenior}` : null,
    sessionRole   ? `Role on file: ${sessionRole}` : null,
  ].filter(Boolean).join("\n") || "Session has no recorded senior name yet.";

  let raw = "";
  try {
    raw = await quickComplete(
      "You are checking if an inbound SMS implies a different person is now texting from a shared phone. " +
      "Cara stores care plans keyed by phone number; if Mom shares a phone with Aunt and Aunt texts " +
      "about her own father, Cara would otherwise treat it as Mom's request.\n\n" +
      `Session context:\n${sessionContext}\n\n` +
      "Reply with JSON only:\n" +
      `{"kind": "different_senior" | "different_role" | "none", "evidence": "<short quote from message>"}\n` +
      "Use \"different_senior\" when the message clearly references a senior with a different name " +
      "than the one on file, or refers to a different parent (e.g. session is for the user's mom but " +
      "they say \"my dad just fell\"). Use \"different_role\" if the speaker says they are a caregiver " +
      "but session role is client (or vice versa). Otherwise reply {\"kind\": \"none\", \"evidence\": \"\"}.\n" +
      "Single mentions like \"my husband\" or \"my sister\" referring to other family members do NOT count " +
      "— only flag clear references to a different care recipient.",
      text,
      { maxTokens: 80 },
    );
  } catch {
    return null;
  }

  // Strip fences if Claude/4o wrapped it
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!cleaned.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(cleaned) as { kind?: string; evidence?: string };
    if (parsed.kind !== "different_senior" && parsed.kind !== "different_role") return null;
    return {
      kind:           parsed.kind,
      evidence:       (parsed.evidence ?? "").slice(0, 200),
      sessionSenior:  sessionSenior,
    };
  } catch {
    return null;
  }
}
