// Canonical appointment display fields.
//
// The webapp (types.ts `Appointment`, ClientDashboard) and the appointment
// triggers/notifications (appointmentUpdated, triggerEngine, notifications,
// replacementAgent) read `time` and `cost`. Server writers that store
// `startTime`/`hourlyRate` must mirror them into the canonical fields or
// agent-booked visits render with a blank time and no dollar amount.
// Spread the result of this helper into every server-side appointment set().
//
// Childcare U7 (plan 2026-07-22-002, R33/R46): this file is ALSO the vertical
// seam for shared `appointments` docs. Childcare appointment writers spread
// canonicalApptFields() PLUS childcareApptFields() — a typed recipient
// REFERENCE (childIds + householdId) and vertical stamp, with the child's
// age-band-safe display label as the ONLY display field. Child-sensitive
// fields (names beyond the display label, DOB, address, custody, emergency
// contacts, care needs) are structurally rejected by
// assertChildSafeAppointmentDoc. Senior writers are untouched: every existing
// call site spreads canonicalApptFields() exactly as before and produces a
// byte-identical doc.
export function canonicalApptFields(opts: {
  startTime: string;
  durationHours?: number;
  hourlyRate?: number;
  /** Explicit per-visit cost — wins over the rate × duration derivation. */
  cost?: number;
}): { time: string; duration: number; paymentStatus: "pending"; cost?: number } {
  const duration = typeof opts.durationHours === "number" && isFinite(opts.durationHours) && opts.durationHours > 0
    ? opts.durationHours
    : 1;
  const out: { time: string; duration: number; paymentStatus: "pending"; cost?: number } = {
    time: opts.startTime,
    duration,
    paymentStatus: "pending",
  };
  const derived =
    typeof opts.cost === "number" && isFinite(opts.cost)
      ? opts.cost
      : typeof opts.hourlyRate === "number" && isFinite(opts.hourlyRate) &&
        typeof opts.durationHours === "number" && isFinite(opts.durationHours)
        ? opts.hourlyRate * opts.durationHours
        : undefined;
  if (derived !== undefined) out.cost = Math.round(derived * 100) / 100;
  return out;
}

export function normalizeAppointmentDate(raw: unknown): string | null {
  if (typeof raw === "string") {
    const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const value = raw && typeof (raw as { toDate?: unknown }).toDate === "function"
    ? (raw as { toDate: () => Date }).toDate()
    : raw instanceof Date
      ? raw
      : null;
  if (!value || !Number.isFinite(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function normalizeAppointmentTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3];
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// ── Childcare vertical seam (U7 — additive; senior writers never call these) ─

/** Typed recipient reference for a childcare appointment/shift (R33/R46). */
export interface ChildcareRecipientRef {
  careVertical: "child";
  householdId: string;
  /** child_profiles doc IDs — references only, NEVER names/DOB/details. */
  childIds: string[];
}

export interface ChildcareApptFields {
  careVertical: "child";
  recipientRef: ChildcareRecipientRef;
  /** Age-band-safe display label from the operational doc — the ONLY child
   *  display field an appointment may carry (never DOB/address). */
  recipientLabel: string;
  childcareBookingId: string;
}

/**
 * Fields child-sensitive by definition on a SHARED appointments doc (R46).
 * `seniorName` is on the list because a childcare appointment must never be
 * rendered through the senior display path; the senior writers keep using it
 * untouched.
 */
export const CHILD_SENSITIVE_APPT_FIELDS: readonly string[] = [
  "seniorName",
  "address",
  "location",
  "careNeeds",
  "emergencyContact",
  "dateOfBirth",
  "custodyNotes",
  "pickupNotes",
  "healthNotes",
  "allergiesNote",
  "safetyProjection",
  "childName",
  "childNames",
];

/**
 * Build the additive childcare fields every childcare appointment writer
 * spreads NEXT TO canonicalApptFields(). Throws on empty references — a
 * childcare appointment without a typed recipient reference fails closed (R2).
 */
export function childcareApptFields(opts: {
  householdId: string;
  childIds: string[];
  displayLabel: string;
  bookingId: string;
}): ChildcareApptFields {
  const householdId = String(opts.householdId ?? "").trim();
  const childIds = Array.isArray(opts.childIds)
    ? opts.childIds.map((c) => String(c ?? "").trim()).filter(Boolean)
    : [];
  const bookingId = String(opts.bookingId ?? "").trim();
  const displayLabel = String(opts.displayLabel ?? "").trim().slice(0, 80);
  if (!householdId || childIds.length === 0 || !bookingId) {
    throw new Error("childcareApptFields: householdId, childIds, and bookingId are required (fail closed)");
  }
  return {
    careVertical: "child",
    recipientRef: { careVertical: "child", householdId, childIds },
    recipientLabel: displayLabel || "your child",
    childcareBookingId: bookingId,
  };
}

/** Is this appointments/shifts/booking_requests doc a childcare-vertical doc? */
export function isChildcareVerticalDoc(data: unknown): boolean {
  return Boolean(data) && (data as Record<string, unknown>).careVertical === "child";
}

/**
 * Structural privacy guard for childcare appointment docs: the shared record
 * must not carry child-sensitive fields (R33/R46) — senior consumers never
 * load child-only detail because it is never stored there.
 */
export function assertChildSafeAppointmentDoc(doc: Record<string, unknown>, site: string): void {
  for (const field of CHILD_SENSITIVE_APPT_FIELDS) {
    if (doc[field] !== undefined) {
      throw new Error(`${site}: child-sensitive field "${field}" is prohibited on a shared appointment record (R46)`);
    }
  }
}

export function normalizeAppointmentDuration(
  duration: unknown,
  durationHours: unknown,
  startTime?: unknown,
  endTime?: unknown,
): number | null {
  for (const candidate of [duration, durationHours]) {
    const value = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isFinite(value) && value > 0 && value <= 24) return value;
  }
  const start = normalizeAppointmentTime(startTime);
  const end = normalizeAppointmentTime(endTime);
  if (!start || !end) return null;
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  let delta = minutes(end) - minutes(start);
  if (delta <= 0) delta += 24 * 60;
  const hours = delta / 60;
  return hours > 0 && hours <= 24 ? hours : null;
}
