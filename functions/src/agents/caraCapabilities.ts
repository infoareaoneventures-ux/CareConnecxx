// Canonical, user-facing list of what Evia can do, in plain language.
//
// This is the single source of truth for capability discovery (Track A of the
// agent-native legibility plan). It feeds:
//   - the post-onboarding capability menu (permissionsConversation / onboardingConversation)
//   - the `/help` command (routeIntent)
// The frontend keeps a structurally-aligned mirror in `constants/caraCapabilities.ts`
// for the in-chat suggestion chips; a CI test asserts the two stay in sync.
//
// Entries are derived from the real MCP tool surface (see toolCapabilities.ts)
// but written as outcomes a family or caregiver would recognize — NOT tool names.

export type CapabilityRole = "client" | "caregiver";

export interface CapabilityEntry {
  /** Stable id; must match the frontend mirror entry. */
  id: string;
  /** English, user-facing label. */
  label: string;
  /** English example the user could send to trigger this. */
  example: string;
  /** Spanish label (backend-only; SMS welcome/help is bilingual). */
  labelEs: string;
  /** Spanish example. */
  exampleEs: string;
  /** Whether this surfaces as a chat suggestion chip / in the short menu. */
  featured: boolean;
}

export const CARA_CAPABILITIES: Record<CapabilityRole, CapabilityEntry[]> = {
  client: [
    {
      id: "find_caregiver",
      label: "Find a caregiver",
      example: "Find me a caregiver for weekday mornings",
      labelEs: "Encontrar un cuidador",
      exampleEs: "Búscame un cuidador para las mañanas entre semana",
      featured: true,
    },
    {
      id: "manage_visits",
      label: "Book or change visits",
      example: "Reschedule my Tuesday visit to Wednesday",
      labelEs: "Reservar o cambiar visitas",
      exampleEs: "Cambia mi visita del martes al miércoles",
      featured: true,
    },
    {
      id: "care_updates",
      label: "See care updates",
      example: "How is Mom doing this week?",
      labelEs: "Ver novedades del cuidado",
      exampleEs: "¿Cómo está mamá esta semana?",
      featured: true,
    },
    {
      id: "billing",
      label: "View billing",
      example: "Review my timesheets",
      labelEs: "Ver facturación",
      exampleEs: "Revisar mis hojas de horas",
      featured: true,
    },
    {
      id: "care_team",
      label: "See your care team",
      example: "Who's on my care team?",
      labelEs: "Ver tu equipo de cuidado",
      exampleEs: "¿Quién está en mi equipo de cuidado?",
      featured: false,
    },
    {
      id: "message_caregiver",
      label: "Message a caregiver",
      example: "Send a message to Sarah",
      labelEs: "Enviar un mensaje a un cuidador",
      exampleEs: "Envía un mensaje a Sarah",
      featured: false,
    },
  ],
  caregiver: [
    {
      id: "find_work",
      label: "Find work",
      example: "Show me jobs near me",
      labelEs: "Buscar trabajo",
      exampleEs: "Muéstrame trabajos cerca de mí",
      featured: true,
    },
    {
      id: "manage_shifts",
      label: "Manage your shifts",
      example: "What shifts do I have this week?",
      labelEs: "Gestionar tus turnos",
      exampleEs: "¿Qué turnos tengo esta semana?",
      featured: true,
    },
    {
      id: "earnings",
      label: "Check earnings",
      example: "What are my earnings this month?",
      labelEs: "Ver ganancias",
      exampleEs: "¿Cuánto he ganado este mes?",
      featured: true,
    },
    {
      id: "availability",
      label: "Set your availability",
      example: "I'm available weekday mornings",
      labelEs: "Configurar tu disponibilidad",
      exampleEs: "Estoy disponible las mañanas entre semana",
      featured: true,
    },
    {
      id: "instant_payout",
      label: "Get paid",
      example: "Request an instant payout",
      labelEs: "Cobrar",
      exampleEs: "Solicita un pago instantáneo",
      featured: false,
    },
    {
      id: "submit_hours",
      label: "Submit your hours",
      example: "Submit my hours for today's shift",
      labelEs: "Enviar tus horas",
      exampleEs: "Envía mis horas del turno de hoy",
      featured: false,
    },
  ],
};

/** Normalize an arbitrary role string to a known capability role (default: client). */
function normalizeRole(role: string | undefined | null): CapabilityRole {
  return role === "caregiver" ? "caregiver" : "client";
}

/**
 * Build the user-facing capability menu sent over SMS/chat.
 * Used by the post-onboarding message and the `/help` command.
 */
export function buildCapabilityMenu(role: string | undefined | null, lang: string = "en"): string {
  const r = normalizeRole(role);
  const es = lang === "es";
  const entries = CARA_CAPABILITIES[r].filter((e) => e.featured).slice(0, 4);
  const examples = entries.map((e) => `"${es ? e.exampleEs : e.example}"`);
  const joinWord = es ? "o" : "or";
  const joined = examples.length <= 1
    ? examples.join("")
    : `${examples.slice(0, -1).join(", ")}, ${joinWord} ${examples[examples.length - 1]}`;
  const lead = es
    ? "Puedo coordinar cuidado contigo por aquí."
    : "I can coordinate care with you right here.";
  const ask = es
    ? "Dime qué necesitas en una frase."
    : "Tell me what you need in one sentence.";
  const exampleLead = es ? "Por ejemplo:" : "For example:";
  return `${lead} ${exampleLead} ${joined}. ${ask}`;
}
