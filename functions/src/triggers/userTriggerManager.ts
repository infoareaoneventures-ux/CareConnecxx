import * as admin from "firebase-admin";

const db = admin.firestore();

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
  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute);

  switch (recurrence) {
    case "daily": {
      if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate.toISOString();
    }
    case "weekly": {
      const targetDay = dayOfWeek ?? 1; // default Monday
      const daysUntil = (targetDay - now.getDay() + 7) % 7 || 7;
      candidate.setDate(now.getDate() + daysUntil);
      if (daysUntil === 0 && candidate <= now) candidate.setDate(candidate.getDate() + 7);
      return candidate.toISOString();
    }
    case "monthly": {
      candidate.setDate(1); // 1st of next occurrence
      if (candidate <= now) candidate.setMonth(candidate.getMonth() + 1);
      return candidate.toISOString();
    }
    case "once": {
      if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate.toISOString();
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

export async function deleteUserTrigger(phone: string, triggerId: string): Promise<boolean> {
  const ref  = db.collection("user_triggers").doc(triggerId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.phone !== phone) return false;
  await ref.update({ active: false, deletedAt: new Date().toISOString() });
  return true;
}
