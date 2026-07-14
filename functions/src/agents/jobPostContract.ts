// Evia ↔ Web job-post contract (client-side parity wave, 2026-07-10).
//
// The caregiver Job Board (components/caregiver/JobBoard.tsx) renders the web
// wizard's JobPost shape (types.ts): `title`, `location` as a STRING, `rate`
// (number) + `rateFlexible`, `date` (mirror of startDate), top-level `lat`/`lng`,
// `clientName`, `requirements` (mirror of careTypes), `createdAt` as an ISO
// STRING. The server writers (Evia onboarding, the clientIntakes trigger, the
// MCP create_job_post tool) each hand-rolled a different shape — `summary`
// instead of title, `location` as an OBJECT (which crashes the board's JSX),
// `hourlyRate` instead of rate, Timestamp createdAt that the daily
// string-compared `createdAt >= isoString` match sweep can never see.
//
// Every server-side job_posts write MUST go through buildWebJobPostDoc so the
// board, the match sweeps, and the SMS notifiers all read one shape. Server-only
// extras (schedule object, summary, hourlyRate passthrough, notifiedCount) ride
// along for the existing SMS/snapshot consumers.

export interface WebJobPostInput {
  clientId:         string;
  source:           string;                  // "cara" | "cara_sms" | "intake_trigger"
  title:            string;
  description?:     string;
  clientName?:      string;
  careTypes?:       string[];
  careLevel?:       string;
  startDate?:       string;                  // "2026-08-01" or "ASAP" or free text
  frequency?:       string;                  // occasional | part_time | full_time | flexible
  days?:            string[];                // named days when known
  daysPerWeek?:     number;                  // count fallback when days unnamed
  timeOfDay?:       string[];                // morning | afternoon | evening | overnight
  hourlyRate?:      number | string;         // number, or "flexible"
  paymentMethod?:   string;                  // "card" (Evia legacy) | cash | venmo | zelle | credit
  city?:            string;
  state?:           string;
  zipCode?:         string;
  lat?:             number | null;
  lng?:             number | null;
  recipientsCount?: number;
  petsInHome?:      boolean;
  smokingHousehold?: boolean;
  phone?:           string;
  intakeId?:        string;
}

export function buildWebJobPostDoc(p: WebJobPostInput): Record<string, unknown> {
  const careTypes  = p.careTypes ?? [];
  const days       = p.days ?? [];
  const timeOfDay  = p.timeOfDay ?? [];
  const startDate  = (p.startDate || "ASAP") as string;
  const daysPerWeek = days.length || (p.daysPerWeek ?? 0);

  // Web rate contract: numeric `rate` + `rateFlexible` (the wizard writes
  // rate 0 when flexible). Evia's intake yields a number or the string
  // "flexible".
  const numericRate  = typeof p.hourlyRate === "number" && Number.isFinite(p.hourlyRate) && p.hourlyRate > 0
    ? p.hourlyRate : 0;
  const rateFlexible = numericRate === 0;

  // Web enums: paymentMethod 'credit' (Evia said "card"); jobFrequency
  // hyphenated (the board's pill map already handles 'occasional').
  const paymentMethod = p.paymentMethod === "card" ? "credit" : p.paymentMethod;
  const jobFrequency  = p.frequency ? p.frequency.replace(/_/g, "-") : undefined;

  const locationStr = [p.city, p.state, p.zipCode].filter(Boolean).join(", ");

  const description = (p.description ?? "").trim() ||
    `${careTypes.length ? careTypes.join(", ") : "General care"} needed` +
    `${p.city ? ` in ${p.city}` : ""}. Start: ${startDate}.` +
    `${timeOfDay.length ? ` Preferred times: ${timeOfDay.join(", ")}.` : ""}`;

  return {
    // ── Web JobPost contract (what the caregiver Job Board renders) ──────────
    clientId:     p.clientId,
    clientName:   p.clientName || "An Evia family",
    title:        p.title,
    description,
    rate:         numericRate,
    rateFlexible,
    date:         startDate,           // legacy mirror, same as the web wizard
    startDate,
    ...(days.length      ? { daysOfWeek: days }   : {}),
    ...(timeOfDay.length ? { timeOfDay }          : {}),
    ...(jobFrequency     ? { jobFrequency }       : {}),
    ...(paymentMethod    ? { paymentMethod }      : {}),
    location:     locationStr,
    ...(p.city    ? { city: p.city }       : {}),
    ...(p.state   ? { state: p.state }     : {}),
    ...(p.zipCode ? { zipCode: p.zipCode } : {}),
    ...(typeof p.lat === "number" ? { lat: p.lat } : {}),
    ...(typeof p.lng === "number" ? { lng: p.lng } : {}),
    careTypes,
    requirements: careTypes,           // legacy mirror (jobMatchService keywords)
    ...(p.careLevel ? { careLevel: p.careLevel } : {}),
    ...(p.recipientsCount ? { recipientsCount: p.recipientsCount } : {}),
    petsInHome:       p.petsInHome ?? false,
    smokingHousehold: p.smokingHousehold ?? false,
    status:           "open",
    applicantCount:   0,
    // ISO string, NOT serverTimestamp: the board orders by createdAt alongside
    // web-written string values, and the daily match sweep compares
    // createdAt >= <iso string> — a Timestamp never matches either.
    createdAt:        new Date().toISOString(),

    // ── Server-side extras (SMS notifiers, snapshots, legacy readers) ─────────
    source:        p.source,
    notifiedCount: 0,
    ...(p.intakeId ? { intakeId: p.intakeId } : {}),
    ...(p.phone    ? { phone: p.phone }       : {}),
    ...(p.hourlyRate !== undefined ? { hourlyRate: p.hourlyRate } : {}),
    ...(daysPerWeek ? { daysPerWeek } : {}),
    schedule: { startDate, frequency: p.frequency ?? "flexible", days, timeOfDay, daysPerWeek },
    summary:  careTypes.length ? `New care job — ${careTypes.slice(0, 2).join(", ")}` : "New care job",
  };
}
