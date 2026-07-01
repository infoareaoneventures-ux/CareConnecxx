// Frontend mirror of Cara's user-facing capabilities.
//
// The canonical list lives in `functions/src/agents/caraCapabilities.ts` (used by
// the SMS welcome menu and `/help`). The frontend and Cloud Functions runtimes
// don't share code, so this is a deliberate parallel copy — kept honest by the
// CI alignment test in `constants/caraCapabilities.test.ts`, which asserts the
// id/label/example/featured AND the Spanish labelEs/exampleEs fields match the
// backend entry-for-entry.
//
// Consumed by the in-app Cara surface (components/AiSearchAgent.tsx) for
// suggestion chips and the in-app `/help` capability menu.

export type CapabilityRole = "client" | "caregiver";

export interface FrontendCapabilityEntry {
  id: string;
  label: string;
  example: string;
  /** Spanish label — frontend hints are bilingual, matching the backend menu. */
  labelEs: string;
  /** Spanish example. */
  exampleEs: string;
  featured: boolean;
}

export const CARA_CAPABILITIES: Record<CapabilityRole, FrontendCapabilityEntry[]> = {
  client: [
    { id: "find_caregiver", label: "Find a caregiver", example: "Find me a caregiver for weekday mornings", labelEs: "Encontrar un cuidador", exampleEs: "Búscame un cuidador para las mañanas entre semana", featured: true },
    { id: "manage_visits", label: "Book or change visits", example: "Reschedule my Tuesday visit to Wednesday", labelEs: "Reservar o cambiar visitas", exampleEs: "Cambia mi visita del martes al miércoles", featured: true },
    { id: "care_updates", label: "See care updates", example: "How is Mom doing this week?", labelEs: "Ver novedades del cuidado", exampleEs: "¿Cómo está mamá esta semana?", featured: true },
    { id: "billing", label: "View billing", example: "Explain my latest invoice", labelEs: "Ver facturación", exampleEs: "Explícame mi última factura", featured: true },
    { id: "care_team", label: "See your care team", example: "Who's on my care team?", labelEs: "Ver tu equipo de cuidado", exampleEs: "¿Quién está en mi equipo de cuidado?", featured: false },
    { id: "message_caregiver", label: "Message a caregiver", example: "Send a message to Sarah", labelEs: "Enviar un mensaje a un cuidador", exampleEs: "Envía un mensaje a Sarah", featured: false },
  ],
  caregiver: [
    { id: "find_work", label: "Find work", example: "Show me jobs near me", labelEs: "Buscar trabajo", exampleEs: "Muéstrame trabajos cerca de mí", featured: true },
    { id: "manage_shifts", label: "Manage your shifts", example: "What shifts do I have this week?", labelEs: "Gestionar tus turnos", exampleEs: "¿Qué turnos tengo esta semana?", featured: true },
    { id: "earnings", label: "Check earnings", example: "What are my earnings this month?", labelEs: "Ver ganancias", exampleEs: "¿Cuánto he ganado este mes?", featured: true },
    { id: "availability", label: "Set your availability", example: "I'm available weekday mornings", labelEs: "Configurar tu disponibilidad", exampleEs: "Estoy disponible las mañanas entre semana", featured: true },
    { id: "instant_payout", label: "Get paid", example: "Request an instant payout", labelEs: "Cobrar", exampleEs: "Solicita un pago instantáneo", featured: false },
    { id: "submit_hours", label: "Submit your hours", example: "Submit my hours for today's shift", labelEs: "Enviar tus horas", exampleEs: "Envía mis horas del turno de hoy", featured: false },
  ],
};

function normalizeRole(role: CapabilityRole | string | undefined | null): CapabilityRole {
  return role === "caregiver" ? "caregiver" : "client";
}

/** True when the given locale string is Spanish (e.g. "es", "es-MX"). */
export function isSpanish(locale: string | undefined | null): boolean {
  return !!locale && locale.toLowerCase().startsWith("es");
}

/** Featured capabilities for a role, used to render suggestion chips. Defaults to client for unknown roles. */
export function featuredCapabilities(role: CapabilityRole | string | undefined | null): FrontendCapabilityEntry[] {
  return CARA_CAPABILITIES[normalizeRole(role)].filter((e) => e.featured);
}

/** Locale-aware label for a capability entry. */
export function capabilityLabel(e: FrontendCapabilityEntry, locale?: string | null): string {
  return isSpanish(locale) ? e.labelEs : e.label;
}

/** Locale-aware example for a capability entry. */
export function capabilityExample(e: FrontendCapabilityEntry, locale?: string | null): string {
  return isSpanish(locale) ? e.exampleEs : e.example;
}

/**
 * Build the in-app `/help` capability menu (mirrors the backend buildCapabilityMenu).
 * Rendered as a Cara message bubble when the user invokes `/help` in the app.
 */
export function buildCapabilityMenu(role: CapabilityRole | string | undefined | null, locale?: string | null): string {
  const es = isSpanish(locale);
  const entries = CARA_CAPABILITIES[normalizeRole(role)].filter((e) => e.featured).slice(0, 4);
  const examples = entries.map((e) => `"${es ? e.exampleEs : e.example}"`);
  const joinWord = es ? "o" : "or";
  const joined = examples.length <= 1
    ? examples.join("")
    : `${examples.slice(0, -1).join(", ")}, ${joinWord} ${examples[examples.length - 1]}`;
  const lead = es
    ? "Puedo coordinar cuidado contigo por aquí."
    : "I can coordinate care with you right here.";
  const exampleLead = es ? "Por ejemplo:" : "For example:";
  const ask = es
    ? "Dime qué necesitas en una frase."
    : "Tell me what you need in one sentence.";
  return `${lead} ${exampleLead} ${joined}. ${ask}`;
}
