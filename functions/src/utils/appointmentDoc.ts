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
}): { time: string; paymentStatus: "pending"; cost?: number } {
  const out: { time: string; paymentStatus: "pending"; cost?: number } = {
    time: opts.startTime,
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
