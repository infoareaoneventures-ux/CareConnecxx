// What a lapsed family membership does to care already arranged (founder
// decision, 2026-09-17 — "freeze at the lapse"):
//   · visits already on the calendar ALWAYS happen and are coordinated as
//     normal — nothing is cancelled;
//   · the first daily run that sees the membership inactive stops adding new
//     visits for that family, right then. The already-generated runway (the
//     generator keeps 2–4 weeks ahead) is the family's time to reactivate with
//     no interruption. Both sides are told once, with the exact last visit date;
//   · three days before that last visit the family gets one reminder;
//   · reactivating resumes the schedule from that point (no re-booking) and
//     both sides are told.
// The membership fields are the ones the website's paywall reads
// (users.subscriptionActive / membershipStatus via isClientMembershipActive);
// the lapse date is stamped on users.membershipLapsedAt and cleared on
// reactivation; the pause lives on booking_requests.schedulePausedAt.
// No promise of pay is made to the caregiver — hours go through the normal
// timesheet and card-charge path, same as any family.
import * as admin from "firebase-admin";
import { isClientMembershipActive } from "../agents/clientAccessGate";
import { appLink } from "../config/appUrl";
import { formatDateWithWeekday } from "../utils/scheduledTime";

const db = admin.firestore();

export const LAST_VISIT_REMINDER_DAYS = 3;

export type LapseDecision = { state: "active" } | { state: "frozen"; lapsedAt: string };

export function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// `lapsedAt` defaults to today when the users doc has no stamp yet (first sighting).
export function decideMembershipLapse(user: Record<string, unknown> | undefined | null, todayStr: string): LapseDecision {
  if (isClientMembershipActive(user)) return { state: "active" };
  const lapsedAt = typeof user?.membershipLapsedAt === "string" && user.membershipLapsedAt ? user.membershipLapsedAt.slice(0, 10) : todayStr;
  return { state: "frozen", lapsedAt };
}

const first = (name: unknown, fallback: string) => { const s = String(name ?? "").trim(); return s ? s.split(/\s+/)[0] : fallback; };
const onDate = (d: string | null) => (d ? ` through ${formatDateWithWeekday(d)}` : "");

export function freezeFamilyText(caregiverName: unknown, lastVisit: string | null): string {
  const cg = first(caregiverName, "Your caregiver");
  return `Your Evia membership isn't active. ${cg}'s visits already on the calendar still happen${onDate(lastVisit)}. After that, no new visits are added until you reactivate — one tap here and the schedule keeps going: ${appLink("/client/membership")}`;
}
export function freezeCaregiverText(clientName: unknown, lastVisit: string | null): string {
  return `${first(clientName, "The family")}'s Evia membership has lapsed. Your visits with them${onDate(lastVisit)} still happen as scheduled; nothing new is being added for now. I'll let you know if it resumes.`;
}
export function reminderFamilyText(caregiverName: unknown, lastVisit: string): string {
  return `Heads up — your last scheduled visit with ${first(caregiverName, "your caregiver")} is ${formatDateWithWeekday(lastVisit)}. Reactivate your membership to keep the schedule going: ${appLink("/client/membership")}`;
}
export function resumeFamilyText(caregiverName: unknown): string {
  return `Welcome back — your membership is active again and ${first(caregiverName, "your caregiver")}'s recurring schedule is running again.`;
}
export function resumeCaregiverText(clientName: unknown): string {
  return `${first(clientName, "The family")}'s membership is active again — new visits with them are back on your schedule.`;
}

export interface LapseNotifier {
  client: (clientId: string, message: string) => Promise<void>;
  caregiver: (caregiverId: string, message: string) => Promise<void>;
}
export interface LapseOptions {
  notifier?: LapseNotifier;
  /** Latest scheduled visit date (YYYY-MM-DD) for a booking, or null. Defaults to the shifts collection. */
  lastScheduledVisit?: (bookingId: string) => Promise<string | null>;
}

async function defaultNotifier(): Promise<LapseNotifier> {
  const { notifyClientByText, notifyCaregiverByText } = await import("../triggers/notificationTriggers");
  return { client: notifyClientByText, caregiver: notifyCaregiverByText };
}

async function defaultLastScheduledVisit(bookingId: string): Promise<string | null> {
  const snap = await db.collection("shifts")
    .where("bookingRequestId", "==", bookingId)
    .where("status", "==", "scheduled")
    .orderBy("date", "desc")
    .limit(1)
    .get();
  return snap.empty ? null : String(snap.docs[0].data().date ?? "") || null;
}

/**
 * Run by the daily generator for each accepted booking. Returns "frozen" when no
 * new visits may be generated. Stamps/clears users.membershipLapsedAt, writes the
 * booking's pause fields, and sends each notice exactly once.
 */
export async function applyMembershipLapse(
  bookingRef: admin.firestore.DocumentReference,
  booking: Record<string, unknown>,
  todayStr: string,
  userCache: Map<string, Record<string, unknown> | null>,
  opts: LapseOptions = {},
): Promise<"active" | "frozen"> {
  const clientId = String(booking.clientId ?? "");
  if (!clientId) return "active";
  if (!userCache.has(clientId)) {
    const snap = await db.collection("users").doc(clientId).get().catch(() => null);
    userCache.set(clientId, snap?.exists ? (snap.data() as Record<string, unknown>) : null);
  }
  const user = userCache.get(clientId);
  const decision = decideMembershipLapse(user, todayStr);
  const notify = opts.notifier ?? await defaultNotifier();
  const lastVisitOf = opts.lastScheduledVisit ?? defaultLastScheduledVisit;

  if (decision.state === "active") {
    if (user?.membershipLapsedAt) {
      await db.collection("users").doc(clientId).set({ membershipLapsedAt: admin.firestore.FieldValue.delete() }, { merge: true }).catch(() => {});
      userCache.set(clientId, { ...(user ?? {}), membershipLapsedAt: undefined });
    }
    if (booking.schedulePausedAt) {
      await bookingRef.set({
        schedulePausedAt: admin.firestore.FieldValue.delete(),
        schedulePausedReason: admin.firestore.FieldValue.delete(),
        membershipLastScheduledVisit: admin.firestore.FieldValue.delete(),
        membershipLastVisitReminderAt: admin.firestore.FieldValue.delete(),
      }, { merge: true }).catch(() => {});
      await notify.client(clientId, resumeFamilyText(booking.caregiverName)).catch(() => {});
      if (booking.caregiverId) await notify.caregiver(String(booking.caregiverId), resumeCaregiverText(booking.clientName)).catch(() => {});
    }
    return "active";
  }

  // Frozen. First sighting: stamp the lapse, pause the booking, tell both sides once.
  if (!user?.membershipLapsedAt) {
    await db.collection("users").doc(clientId).set({ membershipLapsedAt: decision.lapsedAt }, { merge: true }).catch(() => {});
    userCache.set(clientId, { ...(user ?? {}), membershipLapsedAt: decision.lapsedAt });
  }
  let lastVisit = typeof booking.membershipLastScheduledVisit === "string" ? booking.membershipLastScheduledVisit : null;
  if (!booking.schedulePausedAt) {
    lastVisit = await lastVisitOf(bookingRef.id).catch(() => null);
    await bookingRef.set({
      schedulePausedAt: new Date().toISOString(),
      schedulePausedReason: "membership_lapsed",
      membershipLastScheduledVisit: lastVisit,
    }, { merge: true }).catch(() => {});
    await notify.client(clientId, freezeFamilyText(booking.caregiverName, lastVisit)).catch(() => {});
    if (booking.caregiverId) await notify.caregiver(String(booking.caregiverId), freezeCaregiverText(booking.clientName, lastVisit)).catch(() => {});
    return "frozen";
  }

  // One reminder, three days before the last scheduled visit.
  if (lastVisit && !booking.membershipLastVisitReminderAt && todayStr >= addDaysStr(lastVisit, -LAST_VISIT_REMINDER_DAYS) && todayStr <= lastVisit) {
    await bookingRef.set({ membershipLastVisitReminderAt: new Date().toISOString() }, { merge: true }).catch(() => {});
    await notify.client(clientId, reminderFamilyText(booking.caregiverName, lastVisit)).catch(() => {});
  }
  return "frozen";
}
