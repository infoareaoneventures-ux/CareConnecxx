import * as admin from "firebase-admin";
import { businessTodayStr, parseScheduledTimeMs } from "../utils/scheduledTime";

const db = admin.firestore();

const BUSINESS_TZ = "America/Los_Angeles";

// Pacific weekday (0=Sun … 6=Sat) of an instant — matches UserTrigger.dayOfWeek.
function businessWeekday(ms: number): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, weekday: "short" })
    .format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

// YYYY-MM-DD `days` after a business date (noon-anchored — DST-safe).
function addBusinessDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// UTC instant of `hour:minute` Pacific wall clock on a business date.
function fireAtMs(dateStr: string, hour: number, minute: number): number {
  return parseScheduledTimeMs(
    `${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  );
}

export interface UserTrigger {
  id?:          string;
  userId:       string;
  phone:        string;
  label:        string;
  recurrence:   "daily" | "weekly" | "monthly" | "once";
  dayOfWeek?:   number;   // 0=Sun … 6=Sat, used for weekly
  hour:         number;   // 0–23
  minute:       number;   // 0–59
  message:      string;
  active:       boolean;
  nextFireAt:   string;   // ISO
  createdAt:    string;
}

export function calculateNextFireAt(
  recurrence: UserTrigger["recurrence"],
  dayOfWeek:  number | undefined,
  hour:       number,
  minute:     number
): string {
  // hour/minute are the USER's wall clock — "remind me daily at 9am" means
  // 9am PACIFIC. Cloud Functions run in UTC, so the old setHours()-based
  // candidate fired daily reminders at 09:00 UTC = 1-2am PT (and weekly used
  // the UTC weekday). All candidates are built as Pacific wall-clock instants.
  const nowMs = Date.now();
  const today = businessTodayStr();

  switch (recurrence) {
    case "daily":
    case "once": {
      let ms = fireAtMs(today, hour, minute);
      if (ms <= nowMs) ms = fireAtMs(addBusinessDays(today, 1), hour, minute);
      return new Date(ms).toISOString();
    }
    case "weekly": {
      const targetDay = dayOfWeek ?? 1; // default Monday
      const daysUntil = (targetDay - businessWeekday(nowMs) + 7) % 7;
      let ms = fireAtMs(addBusinessDays(today, daysUntil), hour, minute);
      if (ms <= nowMs) ms = fireAtMs(addBusinessDays(today, daysUntil + 7), hour, minute);
      return new Date(ms).toISOString();
    }
    case "monthly": {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      let ms = fireAtMs(firstOfThisMonth, hour, minute);
      if (ms <= nowMs) {
        const [y, m] = today.split("-").map(Number);
        const nextY = m === 12 ? y + 1 : y;
        const nextM = m === 12 ? 1 : m + 1;
        ms = fireAtMs(`${nextY}-${String(nextM).padStart(2, "0")}-01`, hour, minute);
      }
      return new Date(ms).toISOString();
    }
  }
}

export async function createUserTrigger(
  phone:  string,
  userId: string,
  params: Omit<UserTrigger, "id" | "phone" | "userId" | "active" | "nextFireAt" | "createdAt">
): Promise<string> {
  const nextFireAt = calculateNextFireAt(params.recurrence, params.dayOfWeek, params.hour, params.minute);
  const ref = await db.collection("user_triggers").add({
    ...params,
    phone,
    userId,
    active:    true,
    nextFireAt,
    createdAt: new Date().toISOString(),
  });
  return ref.id;
}

export async function listUserTriggers(phone: string): Promise<Array<UserTrigger & { id: string }>> {
  const snap = await db.collection("user_triggers")
    .where("phone",  "==", phone)
    .where("active", "==", true)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as UserTrigger) }));
}

// Update an existing reminder's fields (ownership-checked, like delete). Recomputes
// nextFireAt when any scheduling field changes so the reminder fires at the new time.
export async function updateUserTrigger(
  phone:     string,
  triggerId: string,
  patch:     Partial<Pick<UserTrigger, "label" | "recurrence" | "dayOfWeek" | "hour" | "minute" | "message">>,
): Promise<boolean> {
  const ref  = db.collection("user_triggers").doc(triggerId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.phone !== phone || snap.data()?.active === false) return false;
  const cur = snap.data() as UserTrigger;
  const schedulingChanged =
    patch.recurrence !== undefined || patch.dayOfWeek !== undefined ||
    patch.hour !== undefined || patch.minute !== undefined;
  await ref.update({
    ...patch,
    ...(schedulingChanged
      ? { nextFireAt: calculateNextFireAt(
          patch.recurrence ?? cur.recurrence,
          patch.dayOfWeek  ?? cur.dayOfWeek,
          patch.hour       ?? cur.hour,
          patch.minute     ?? cur.minute,
        ) }
      : {}),
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function deleteUserTrigger(phone: string, triggerId: string): Promise<boolean> {
  const ref  = db.collection("user_triggers").doc(triggerId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.phone !== phone) return false;
  await ref.update({ active: false, deletedAt: new Date().toISOString() });
  return true;
}
