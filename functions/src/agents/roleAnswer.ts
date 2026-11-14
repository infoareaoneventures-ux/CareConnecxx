// The role question's answer word. The 2026-10-12 "caregiver → care provider" rename changed the prompt to ask for
// "care provider" but this code still compared against "caregiver", so every cold-text "I'm a care provider" was read
// as unclear and a new care provider could not sign up by text (live-caught 2026-11-14 over Call.com). Both words map
// to the internal role now.
export function normalizeRoleAnswer(answer: string): string {
  const a = String(answer ?? "").trim().toLowerCase().replace(/[.!"'`]/g, "");
  if (/^(care[\s-]?giver|care[\s-]?provider|provider)$/.test(a)) return "caregiver";
  return a;
}
