// Frontend mirror of Cara's user-facing capabilities.
//
// The canonical list lives in `functions/src/agents/caraCapabilities.ts` (used by
// the SMS welcome menu and `/help`). The frontend and Cloud Functions runtimes
// don't share code, so this is a deliberate parallel copy — kept honest by the
// CI alignment test in `constants/caraCapabilities.test.ts`, which asserts the
// id/label/example/featured fields match the backend entry-for-entry.
//
// Consumed by the in-chat suggestion chips (components/Chat.tsx).

export type CapabilityRole = "client" | "caregiver";

export interface FrontendCapabilityEntry {
  id: string;
  label: string;
  example: string;
  featured: boolean;
}

export const CARA_CAPABILITIES: Record<CapabilityRole, FrontendCapabilityEntry[]> = {
  client: [
    { id: "find_caregiver", label: "Find a caregiver", example: "Find me a caregiver for weekday mornings", featured: true },
    { id: "manage_visits", label: "Book or change visits", example: "Reschedule my Tuesday visit to Wednesday", featured: true },
    { id: "care_updates", label: "See care updates", example: "How is Mom doing this week?", featured: true },
    { id: "billing", label: "View billing", example: "Explain my latest invoice", featured: true },
    { id: "care_team", label: "See your care team", example: "Who's on my care team?", featured: false },
    { id: "message_caregiver", label: "Message a caregiver", example: "Send a message to Sarah", featured: false },
  ],
  caregiver: [
    { id: "find_work", label: "Find work", example: "Show me jobs near me", featured: true },
    { id: "manage_shifts", label: "Manage your shifts", example: "What shifts do I have this week?", featured: true },
    { id: "earnings", label: "Check earnings", example: "What are my earnings this month?", featured: true },
    { id: "availability", label: "Set your availability", example: "I'm available weekday mornings", featured: true },
    { id: "instant_payout", label: "Get paid", example: "Request an instant payout", featured: false },
    { id: "submit_hours", label: "Submit your hours", example: "Submit my hours for today's shift", featured: false },
  ],
};

/** Featured capabilities for a role, used to render suggestion chips. Defaults to client for unknown roles. */
export function featuredCapabilities(role: CapabilityRole | string | undefined | null): FrontendCapabilityEntry[] {
  const r: CapabilityRole = role === "caregiver" ? "caregiver" : "client";
  return CARA_CAPABILITIES[r].filter((e) => e.featured);
}
