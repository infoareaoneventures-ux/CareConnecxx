// The caregiver care-services menu — the website's "What services do you offer?"
// step (components/caregiver/signup/constants.ts PRIMARY_SERVICES) — and the
// display label each one carries wherever the eight are shown. Pure constants:
// safe to import from prompt builders (no model client, no Firestore).
//
// The STORED value is always the PRIMARY_SERVICES string; only the label shown
// to people differs — "Medication Reminders" reads "Medication Reminders Only"
// (founder 2026-10-04: reminding when it's time, never administering medication).
// MUST stay byte-identical to the site's constants (parity test: caregiverServices.test.ts).

export const PRIMARY_SERVICES = [
  "Mobility Assistance",
  "Dementia / Memory Care",
  "Medication Reminders",
  "Personal Care",
  "Companionship",
  "Transportation",
  "Meal Preparation",
  "Light Housekeeping",
] as const;

// The six "additional services" (Hospice Care, Post-Surgery Recovery, …) were
// removed 2026-10-04 (founder: "those six shouldn't exist"): no site screen ever
// offered them — the wizard shows exactly these eight — so Evia must not save them.
export const CANONICAL_SERVICES: readonly string[] = [...PRIMARY_SERVICES];

export const SERVICE_DISPLAY_LABEL: Record<string, string> = {
  "Medication Reminders": "Medication Reminders Only",
};

/** The label people see for a stored service value ("Medication Reminders" → "Medication Reminders Only"). */
export function serviceLabel(name: string): string {
  return SERVICE_DISPLAY_LABEL[name] ?? name;
}

export function serviceLabels(names: readonly string[]): string[] {
  return names.map(serviceLabel);
}

/** The eight as shown — the menu Evia lists, one per line, by name, never numbered. */
export const SERVICE_LABELS: readonly string[] = CANONICAL_SERVICES.map(serviceLabel);

export function serviceMenuText(): string {
  return SERVICE_LABELS.join("\n");
}

const CANONICAL_SET = new Set(CANONICAL_SERVICES);

/** Dedupe to canonical strings, in the menu's order (stable; matches the backfill migration). */
export function orderedCanonicalServices(values: readonly unknown[]): string[] {
  const present = new Set(values.filter((v): v is string => typeof v === "string" && CANONICAL_SET.has(v)));
  return CANONICAL_SERVICES.filter((s) => present.has(s));
}

/** A stored value or a shown label → the stored value; null when it is neither. */
export function serviceFromNameOrLabel(text: string): string | null {
  const key = text.trim().toLowerCase();
  for (const s of CANONICAL_SERVICES) {
    if (s.toLowerCase() === key || serviceLabel(s).toLowerCase() === key) return s;
  }
  return null;
}
