// Role-aware capability discovery for Cara (U7 / R13).
//
// Goal: let users discover Cara's high-value actions in a ROLE-AWARE,
// CONTEXT-AWARE, conversational way — never a generic chatbot menu and never
// "what can I help you with?".
//
// SINGLE SOURCE OF TRUTH: the example actions surfaced here are DERIVED from
// LAUNCH_ACTION_PARITY (functions/src/agents/launchActionParity.ts), the same
// registry that toolCapabilities.test.ts enforces against real MCP tools. We do
// NOT maintain a parallel hardcoded capability list — discovery stays in sync
// with what Cara can actually do. We only attach a short, warm, conversational
// phrasing to each shipped row we want to surface.
//
// AUTHORITY BOUNDARY (R-critical, AE4): the "family-secondary" list surfaces
// care-update / "how is Mom" capabilities but MUST NOT imply payment-approval
// authority. Only the primary account holder approves payments. This module
// enforces that by (a) sourcing secondary suggestions from a curated allow-list
// of action ids that excludes every billing/timesheet/refund row, and (b) a
// runtime assertion that no payment-authority phrasing leaks in.

import { LAUNCH_ACTION_PARITY } from "./launchActionParity";

export type DiscoveryRole = "client" | "caregiver" | "family-secondary";

/**
 * Conversational phrasings keyed by LAUNCH_ACTION_PARITY row id. Only ids that
 * appear here are eligible to be surfaced as discovery examples. This keeps the
 * surfaced set curated (high-value, warm) WITHOUT forking the capability list —
 * every phrasing must map to a shipped parity row or it is silently dropped.
 */
const ACTION_PHRASINGS: Record<string, string> = {
  // Client high-value actions
  "client-book-caregiver": "book a visit",
  "client-reschedule-appointment": "reschedule a visit",
  "client-cancel-appointment": "cancel a visit",
  "client-update-care-plan": "update Mom's care plan",
  "client-read-care-journal": "catch you up on how the last visit went",
  "client-add-family-member": "add a family member to the updates",
  "client-approve-timesheet": "review and approve a caregiver's hours",
  "client-view-invoices": "pull up your billing",
  "client-request-refund": "flag a charge for a refund",
  "client-find-caregiver": "find a backup caregiver",

  // Caregiver high-value actions
  "caregiver-browse-jobs": "find open jobs near you",
  "caregiver-apply-to-job": "apply to a job",
  "caregiver-respond-booking-request": "accept or decline a booking request",
  "caregiver-start-shift": "clock in for a shift",
  "caregiver-complete-shift": "clock out and submit your hours",
  "caregiver-submit-shift-hours": "submit your timesheet",
  "caregiver-view-earnings": "check your earnings",
  "caregiver-request-instant-payout": "cash out an instant payout",
  "caregiver-check-background-status": "check your background-check status",
  "caregiver-update-availability": "update your availability",

  // Family secondary — care-visibility ONLY. Intentionally NO billing/timesheet/
  // refund/payment ids here (authority boundary, AE4).
  "family-read-care-journal": "tell you how Mom's doing and what happened on the last visit",
  "family-add-sibling": "add another family member to the updates",
};

/**
 * Curated presentation ORDER per role — the most universally high-value actions
 * first, so a short (3-5) list always leads with what matters most (e.g. pay for
 * caregivers, booking for clients). Every id here must still be a SHIPPED row in
 * LAUNCH_ACTION_PARITY with a phrasing in ACTION_PHRASINGS; ids that aren't are
 * silently dropped, so this controls ordering without forking the capability set.
 */
const FEATURED_ORDER: Record<DiscoveryRole, readonly string[]> = {
  client: [
    "client-book-caregiver",
    "client-reschedule-appointment",
    "client-update-care-plan",
    "client-approve-timesheet",
    "client-view-invoices",
    "client-read-care-journal",
    "client-add-family-member",
  ],
  caregiver: [
    "caregiver-browse-jobs",
    "caregiver-complete-shift",
    "caregiver-view-earnings",
    "caregiver-request-instant-payout",
    "caregiver-start-shift",
    "caregiver-apply-to-job",
    "caregiver-update-availability",
  ],
  "family-secondary": [
    "family-read-care-journal",
    "family-add-sibling",
  ],
};

/**
 * Action ids a secondary family member is allowed to discover. This is an
 * explicit allow-list (not a filter over the whole registry) so a future
 * billing/payment row can never silently leak into the secondary surface.
 */
const FAMILY_SECONDARY_ALLOWED_IDS: readonly string[] = FEATURED_ORDER["family-secondary"];

// Phrasing that would (wrongly) imply a secondary member can move money. Used by
// the runtime guard below so a careless ACTION_PHRASINGS edit can't break AE4.
const PAYMENT_AUTHORITY_MARKERS = [
  "approve", "pay ", "payment", "invoice", "billing", "refund", "timesheet", "payout", "charge",
];

/**
 * Returns a SHORT (3–5) list of real, high-value example actions for a role,
 * phrased conversationally. Derived from LAUNCH_ACTION_PARITY shipped rows so
 * discovery stays in sync with real capabilities.
 *
 * @param role   client | caregiver | family-secondary
 * @param limit  max examples (default 4; clamped 3..5)
 */
export function getCapabilityExamples(role: DiscoveryRole, limit = 4): string[] {
  const max = Math.max(3, Math.min(5, limit));

  // Set of shipped parity row ids — the single source of truth. Any featured id
  // not shipped (or not phrased) is silently dropped, so discovery never
  // advertises a blocker/non-goal action.
  const shippedIds = new Set(
    LAUNCH_ACTION_PARITY.filter((row) => row.status === "shipped").map((row) => row.id),
  );

  // Walk the curated order, keeping only shipped + phrased rows. For
  // family-secondary also require the explicit allow-list (defense in depth).
  const examples: string[] = [];
  for (const id of FEATURED_ORDER[role]) {
    if (!shippedIds.has(id)) continue;
    if (!(id in ACTION_PHRASINGS)) continue;
    if (role === "family-secondary" && !FAMILY_SECONDARY_ALLOWED_IDS.includes(id)) continue;
    examples.push(ACTION_PHRASINGS[id]);
  }

  // AUTHORITY GUARD (AE4): for secondary members, hard-drop anything that reads
  // like payment authority. Defense-in-depth on top of the allow-list.
  const guarded =
    role === "family-secondary"
      ? examples.filter(
          (phrase) => !PAYMENT_AUTHORITY_MARKERS.some((m) => phrase.toLowerCase().includes(m)),
        )
      : examples;

  return guarded.slice(0, max);
}

/**
 * Builds a concise, warm, role-aware SMS reply for the literal "HELP" carrier
 * keyword. Action-oriented, conversational, no feature-list framing. When the
 * caller has recent context worth leading with, pass `leadWith` to surface ONE
 * relevant suggestion instead of a list.
 *
 * NOTE: this is for the carrier-protocol HELP keyword path ONLY. Natural-language
 * "what can you do?" is handled by the LLM via buildCapabilityHint() injected
 * into the system prompt — never by keyword matching.
 */
export function buildHelpSmsReply(role: DiscoveryRole, leadWith?: string): string {
  if (leadWith && leadWith.trim()) {
    // Lead with one contextual suggestion — context exists, so don't dump a list.
    return `I'm Cara — I'm right here. ${leadWith.trim()} Or just tell me what you need.`;
  }

  const examples = getCapabilityExamples(role, 3);
  const list = joinExamples(examples);

  switch (role) {
    case "caregiver":
      return `I'm Cara — text me and I'll handle it. I can ${list}. What do you need?`;
    case "family-secondary":
      // Care-visibility framing only — never payment authority (AE4).
      return `I'm Cara, here for the family. I can ${list}. Just ask me anything about how things are going.`;
    case "client":
    default:
      return `I'm Cara — your care coordinator. I can ${list}. Just tell me what you need.`;
  }
}

/**
 * Brief role-aware capability hint for injection into the qaAgent system prompt
 * / operational context. This drives the NATURAL-LANGUAGE path ("what can you
 * do?", "what can I ask you") — the LLM reads this and answers conversationally
 * with role-relevant examples. When `hasContext` is true, the hint tells Cara to
 * lead with ONE contextual suggestion from her operations context rather than
 * listing capabilities (R12 — never feel generic when context exists).
 */
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
    `If the user asks what you can do, what you can help with, or how to use you, answer as ${roleLabel} would expect — warm, short, and concrete. Name 2-3 real things you can actually do for them, in plain prose, not a feature list or numbered menu. Real examples for this user: ${list}.`,
    "Never reply with a generic \"what can I help you with?\" or \"here is a list of my features.\" You are not a chatbot menu.",
  ];

  if (hasContext) {
    lines.push(
      "Because there is live context for this user (see the operations context above), LEAD with ONE relevant next action drawn from that context instead of listing capabilities — e.g. surface their next visit, a pending approval, or a recent care note and offer to act on it.",
    );
  }

  if (role === "family-secondary") {
    lines.push(
      "AUTHORITY BOUNDARY: this is a SECONDARY family member. You can share care updates and add other family members, but you must NOT imply they can approve payments, invoices, timesheets, or refunds — only the primary account holder approves payments. If they ask to approve a payment, explain that the primary account holder has to do that.",
    );
  }

  return lines.join("\n");
}

/** "a, b and c" — natural prose join for an examples list. */
function joinExamples(examples: string[]): string {
  if (examples.length === 0) return "help coordinate care";
  if (examples.length === 1) return examples[0];
  return `${examples.slice(0, -1).join(", ")} and ${examples[examples.length - 1]}`;
}
