import * as admin from "firebase-admin";

const db = admin.firestore();

export interface CaraPreferences {
  dndEnabled: boolean;
  dndStart: string;       // "22:00" (24h, local time of user)
  dndEnd: string;         // "08:00"
  activeHours: { start: string; end: string };
  preferredSummaryTime: string;   // "18:00"
  preferSMS: boolean;
  timezone: string;       // IANA tz, e.g. "America/Los_Angeles"
  /** LEARNED quiet window (scheduled/inferActiveHours.ts) from when this user
   *  actually sends messages. Honored by isInDND ONLY when the user has not
   *  enabled explicit DND — user-set preferences always win. */
  inferredQuietHours?: {
    start: string;            // "23:00"
    end: string;              // "08:00"
    basedOnMessages: number;
    computedAt: string;
  };
}

const DEFAULTS: CaraPreferences = {
  dndEnabled:           false,
  dndStart:             "22:00",
  dndEnd:               "08:00",
  activeHours:          { start: "08:00", end: "21:00" },
  preferredSummaryTime: "18:00",
  preferSMS:            false,
  timezone:             "America/Los_Angeles",
};

export async function getPreferences(userId: string): Promise<CaraPreferences> {
  const snap = await db.collection("user_preferences").doc(userId).get();
  if (!snap.exists) return { ...DEFAULTS };
  return { ...DEFAULTS, ...snap.data() } as CaraPreferences;
}

export async function updatePreferences(
  userId: string,
  patch: Partial<CaraPreferences>
): Promise<void> {
  await db.collection("user_preferences").doc(userId).set(patch, { merge: true });
}

export function validatedTz(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    console.warn(`[preferences] Invalid timezone "${tz}", falling back to America/Los_Angeles`);
    return "America/Los_Angeles";
  }
}

// Shared HH:MM window check in the user's timezone (handles overnight spans).
function isInWindow(start: string, end: string, timezone: string, now?: Date): boolean {
  const d  = now ?? new Date();
  const tz = validatedTz(timezone || "America/Los_Angeles");
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
  }).formatToParts(d);
  const h    = parts.find(p => p.type === "hour")?.value   ?? "00";
  const m    = parts.find(p => p.type === "minute")?.value ?? "00";
  const hhmm = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  return start <= end ? (hhmm >= start && hhmm < end) : (hhmm >= start || hhmm < end);
}

export function isActiveHour(prefs: CaraPreferences, now?: Date): boolean {
  const d  = now ?? new Date();
  const tz = validatedTz(prefs.timezone || "America/Los_Angeles");
  const { start, end } = prefs.activeHours ?? { start: "08:00", end: "21:00" };

  const parts = new Intl.DateTimeFormat("en-US", {
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
    timeZone: tz,
  }).formatToParts(d);
  const h    = parts.find(p => p.type === "hour")?.value   ?? "00";
  const m    = parts.find(p => p.type === "minute")?.value ?? "00";
  const hhmm = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;

  if (start <= end) {
    return hhmm >= start && hhmm < end;
  } else {
    return hhmm >= start || hhmm < end;
  }
}

export function isInDND(prefs: CaraPreferences, now?: Date): boolean {
  // No explicit DND set, but we've LEARNED when this user is never active
  // (inferActiveHours job): treat that window as quiet hours. Explicit
  // settings always win — a user who enabled DND uses their own window, and
  // a user who set activeHours has that enforced separately by isActiveHour.
  if (!prefs.dndEnabled && prefs.inferredQuietHours?.start && prefs.inferredQuietHours?.end) {
    return isInWindow(
      prefs.inferredQuietHours.start,
      prefs.inferredQuietHours.end,
      prefs.timezone,
      now
    );
  }
  if (!prefs.dndEnabled) return false;
  const d  = now ?? new Date();
  const tz = validatedTz(prefs.timezone || "America/Los_Angeles");

  // Get HH:MM in the user's local timezone (avoids UTC-vs-local comparison bug)
  const parts = new Intl.DateTimeFormat("en-US", {
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
    timeZone: tz,
  }).formatToParts(d);
  const h    = parts.find(p => p.type === "hour")?.value   ?? "00";
  const m    = parts.find(p => p.type === "minute")?.value ?? "00";
  const hhmm = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;

  const { dndStart, dndEnd } = prefs;
  if (dndStart <= dndEnd) {
    return hhmm >= dndStart && hhmm < dndEnd;
  } else {
    // Overnight window e.g. 22:00–08:00
    return hhmm >= dndStart || hhmm < dndEnd;
  }
}
