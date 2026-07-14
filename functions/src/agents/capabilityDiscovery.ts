// Role-aware capability discovery for Evia.
//
// Discovery should package shipped actions as concrete care workflows, not a
// generic chatbot feature list. The examples here come from careRecipes.ts, and
// those recipes are validated against LAUNCH_ACTION_PARITY.

import { getCareRecipeExamples, hasPaymentAuthorityLeak } from "./careRecipes";
import { buildCapabilityMenu } from "./caraCapabilities";

export type DiscoveryRole = "client" | "caregiver" | "family-secondary";

export function getCapabilityExamples(role: DiscoveryRole, limit = 4): string[] {
  const max = Math.max(2, Math.min(5, limit));
  const examples = getCareRecipeExamples(role, max);
  const guarded = role === "family-secondary"
    ? examples.filter((phrase) => !hasPaymentAuthorityLeak(phrase))
    : examples;
  return guarded.slice(0, max);
}

export function buildHelpSmsReply(role: DiscoveryRole, leadWith?: string, lang: string = "en"): string {
  // Spanish renders through the bilingual capability entries in
  // caraCapabilities — the care-recipe example phrases are English-only, so
  // splicing them into a Spanish frame would produce a mixed-language reply.
  if (lang === "es") {
    const intro = role === "caregiver"
      ? "Soy Evia — escríbeme y me encargo."
      : "Soy Evia, tu coordinadora de cuidados.";
    return `${intro} ${buildCapabilityMenu(role === "caregiver" ? "caregiver" : "client", "es")}`;
  }

  if (leadWith && leadWith.trim()) {
    return `I'm Evia - I'm right here. ${leadWith.trim()} Or just tell me what you need.`;
  }

  const examples = getCapabilityExamples(role, 3);
  const list = joinExamples(examples);

  switch (role) {
    case "caregiver":
      return `I'm Evia - text me and I'll handle it. I can ${list}. What do you need?`;
    case "family-secondary":
      return `I'm Evia, here for the family. I can ${list}. Ask me what changed or who needs to be looped in.`;
    case "client":
    default:
      return `I'm Evia - your care coordinator. I can ${list}. Just tell me what needs to happen.`;
  }
}

export function buildCapabilityHint(role: DiscoveryRole, hasContext: boolean): string {
  const examples = getCapabilityExamples(role, 4);
  const list = joinExamples(examples);

  const roleLabel =
    role === "caregiver"
      ? "a caregiver"
      : role === "family-secondary"
        ? "a family member following along"
        : "the family's care coordinator-holder";

  const lines: string[] = [
    "CAPABILITY DISCOVERY (use silently):",
    `If the user asks what you can do, what you can help with, or how to use you, answer as ${roleLabel} would expect - warm, short, and concrete. Name 2-3 real care recipes you can actually run, in plain prose, not a feature list or numbered menu. Real examples for this user: ${list}.`,
    "Never reply with a generic \"what can I help you with?\" or \"here is a list of my features.\" You are not a chatbot menu.",
  ];

  if (hasContext) {
    lines.push(
      "Because there is live context for this user (see the operations context above), LEAD with ONE relevant care recipe drawn from that context instead of listing capabilities - e.g. next visit briefing, review hours, care update summary, caregiver pay status, failed-action recovery, or memory correction.",
    );
  }

  if (role === "family-secondary") {
    lines.push(
      "AUTHORITY BOUNDARY: this is a SECONDARY family member. You can share care updates and help route family-add requests, but you must NOT imply they can approve payments, invoices, timesheets, refunds, or payouts - only the primary account holder approves payments. If they ask to approve a payment, explain that the primary account holder has to do that.",
    );
  }

  return lines.join("\n");
}

function joinExamples(examples: string[]): string {
  if (examples.length === 0) return "help coordinate care";
  if (examples.length === 1) return examples[0];
  return `${examples.slice(0, -1).join(", ")} and ${examples[examples.length - 1]}`;
}
