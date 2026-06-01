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
  knownNames?:    string[];     // first names Cara already expects on this account
                                // (client, all care recipients, family, caregivers)
}): Promise<PersonaShift | null> {
  const { text, sessionSenior, sessionRole, knownNames = [] } = params;
  if (!text.trim()) return null;

  // Short messages with no entity content aren't worth an LLM call.
  if (text.trim().length < 12) return null;

  const knownList = [...new Set(knownNames.map(n => n.trim()).filter(Boolean))];
  const sessionContext = [
    sessionSenior ? `Senior on file: ${sessionSenior}` : null,
    sessionRole   ? `Role on file: ${sessionRole}` : null,
    knownList.length
      ? `Names already known on this account (the client, their care recipients, family members, AND their caregivers): ${knownList.join(", ")}`
      : null,
  ].filter(Boolean).join("\n") || "Session has no recorded senior name yet.";

  let raw = "";
  try {
    raw = await quickComplete(
      "You are checking if an inbound SMS implies a DIFFERENT care recipient is now being discussed " +
      "from a shared phone. Cara stores care plans keyed by phone number; if Mom shares a phone with " +
      "Aunt and Aunt texts about her own father, Cara would otherwise treat it as Mom's request.\n\n" +
      `Session context:\n${sessionContext}\n\n` +
      "Reply with JSON only:\n" +
      `{"kind": "different_senior" | "different_role" | "none", "evidence": "<short quote from message>"}\n\n` +
      "CRITICAL — to avoid false alarms on name collisions:\n" +
      "- A message that merely MENTIONS a name already known on this account (see list above) is NEVER a " +
      "persona shift, even if that name differs from the senior on file. Caregivers, family members, and " +
      "the client all have names; hearing one is expected.\n" +
      "- Messages that are LOGISTICS ABOUT A CAREGIVER are NEVER a persona shift: asking for a caregiver's " +
      "profile or link, booking/scheduling them, asking if they're available, messaging/rating/paying them, " +
      "or asking who's on the care team. (e.g. \"send me Imran's profile\", \"book James\", \"is Maria free Friday\".)\n" +
      "- Single mentions like \"my husband\" or \"my sister\" referring to other family members do NOT count.\n\n" +
      "ONLY use \"different_senior\" when the message clearly introduces a NEW CARE RECIPIENT — a person who " +
      "needs care — identified by a relationship/care-need cue (e.g. \"my dad just fell and needs help\", " +
      "\"my mother can't be left alone\") whose name is NOT in the known list, OR a clearly different parent " +
      "than the one on file. Use \"different_role\" only if the speaker says they are a caregiver but the " +
      "session role is client (or vice versa). Otherwise reply {\"kind\": \"none\", \"evidence\": \"\"}.",
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
