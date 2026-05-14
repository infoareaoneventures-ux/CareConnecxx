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

export function isInDND(prefs: CaraPreferences, now?: Date): boolean {
  if (!prefs.dndEnabled) return false;
  const d  = now ?? new Date();
  const tz = prefs.timezone || "America/Los_Angeles";

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
