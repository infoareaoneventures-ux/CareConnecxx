import * as admin from "firebase-admin";

const db = admin.firestore();

export interface CaraPreferences {
  dndEnabled: boolean;
  dndStart: string;       // "22:00" (24h, local time of user)
  dndEnd: string;         // "08:00"
  activeHours: { start: string; end: string };
  preferredSummaryTime: string;   // "18:00"
  preferSMS: boolean;
}

const DEFAULTS: CaraPreferences = {
  dndEnabled:           false,
  dndStart:             "22:00",
  dndEnd:               "08:00",
  activeHours:          { start: "08:00", end: "21:00" },
  preferredSummaryTime: "18:00",
  preferSMS:            false,
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

export function isInDND(prefs: CaraPreferences, nowUtc?: Date): boolean {
  if (!prefs.dndEnabled) return false;
  const now = nowUtc ?? new Date();
  // Compare as HH:MM strings against UTC hour:minute (caller adjusts tz if needed)
  const hhmm = now.toISOString().slice(11, 16); // "HH:MM" in UTC
  const { dndStart, dndEnd } = prefs;

  if (dndStart <= dndEnd) {
    // Same-day window: 22:00–23:59 would not wrap; e.g. 08:00–18:00
    return hhmm >= dndStart && hhmm < dndEnd;
  } else {
    // Overnight window: e.g. 22:00–08:00 wraps midnight
    return hhmm >= dndStart || hhmm < dndEnd;
  }
}
