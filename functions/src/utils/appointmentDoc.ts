// Canonical appointment display fields.
//
// The webapp (types.ts `Appointment`, ClientDashboard) and the appointment
// triggers/notifications (appointmentUpdated, triggerEngine, notifications,
// replacementAgent) read `time` and `cost`. Server writers that store
// `startTime`/`hourlyRate` must mirror them into the canonical fields or
// agent-booked visits render with a blank time and no dollar amount.
// Spread the result of this helper into every server-side appointment set().
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
