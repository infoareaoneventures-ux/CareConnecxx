// The membership renewal timeline, by text and bell, same words on the site (founder, 2026-10-06):
//   • 7 days BEFORE the anniversary: one card reminder ("renews on <date> for $69.99 — reply
//     MANAGE MEMBERSHIP if your card changed"). Caregivers only.
//   • Anniversary (stripe.ts handleInvoicePaymentSucceeded): payment first, then
//     bgcheckConsentRequest 'renewal' parks the refresh on consent WITHOUT resetting the clear.
//   • Day 5 after: one reminder if still unauthorized.
//   • Day 7 after: the lock (the same reset the old renewal did on day 0) + the family notice
//     for upcoming visits (triggers/caregiverAccountEvents.ts releaseUpcomingVisitsOnLock).
// Failed payments never lock here — Stripe retries, and the lock lands when Stripe cancels.
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { caregiverAnnualDisplay } from "../config/pricing";

const db = admin.firestore();
const DAY = 24 * 3600 * 1000;

export type RenewalDecision = "none" | "remind" | "lock";
/** Pure: what the sweep does for a refresh still awaiting consent, given when it was asked. */
export function renewalRefreshDecision(rr: { status?: string; requestedAt?: string; remindedAt?: string | null } | undefined, now = Date.now()): RenewalDecision {
  if (!rr || rr.status !== "awaiting_consent") return "none";
  const asked = Date.parse(String(rr.requestedAt ?? ""));
  if (!Number.isFinite(asked)) return "none";
  const days = (now - asked) / DAY;
  if (days >= 7) return "lock";
  if (days >= 5 && !rr.remindedAt) return "remind";
  return "none";
}

/** Pure: is this subscription renewing in 7 days (within the sweep's one-day window)? */
export function cardReminderDue(periodEndMs: number | null | undefined, now = Date.now()): boolean {
  if (!periodEndMs || !Number.isFinite(periodEndMs)) return false;
  const daysLeft = (periodEndMs - now) / DAY;
  return daysLeft > 6 && daysLeft <= 7;
}

export function toMs(v: unknown): number | null {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  const t = v as { toDate?: () => Date; seconds?: number; _seconds?: number };
  if (typeof t.toDate === "function") return t.toDate().getTime();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  if (typeof t._seconds === "number") return t._seconds * 1000;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const ms = Date.parse(String(v)); return Number.isFinite(ms) ? ms : null;
}

/**
 * Day 7: the lock — the same reset the old renewal did on the anniversary, now only for someone who never authorized.
 * Decided INSIDE the write (caregiver sweep C15, 2026-10-11): the sweep's snapshot is minutes old by the time this
 * runs; a consent given meanwhile flips renewalRefresh.status to "running" (backgroundCheckConsent.ts) and a clear to
 * "cleared" — the transaction re-reads the record and locks only while the refresh is STILL awaiting consent and
 * still past day 7. Returns false when nothing was locked.
 */
export async function lockUnauthorizedRefresh(uid: string, now = Date.now()): Promise<boolean> {
  const ref = db.collection("caregivers").doc(uid);
  const locked = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const fresh = (snap.data() ?? {}) as Record<string, any>;
    if (renewalRefreshDecision(fresh.renewalRefresh, now) !== "lock") return false; // consent / clear landed since the sweep read
    if (fresh.backgroundCheckData?.consentGiven === true && Date.parse(String(fresh.backgroundCheckData?.consentGivenAt ?? "")) >= Date.parse(String(fresh.renewalRefresh?.requestedAt ?? ""))) return false;
    tx.set(ref, {
      verified: false, backgroundCheckStatus: "pending", backgroundCheckComplete: false, verificationStatus: "submitted",
      backgroundCheckData: { status: "pending", checkrClearedAt: null },
      renewalRefresh: { status: "locked", lockedAt: new Date(now).toISOString() },
    }, { merge: true });
    return true;
  });
  if (locked) await db.collection("users").doc(uid).set({ verificationStatus: "submitted" }, { merge: true }).catch(() => {});
  return locked;
}

export const renewalRefreshSweep = functions.pubsub
  .schedule("15 0 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const { notifyCaregiverAccountEvent } = await import("../notifications/caregiverAccountEvents");
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);

    // (a) authorize reminders / locks for refreshes still waiting
    const waiting = await db.collection("caregivers").where("renewalRefresh.status", "==", "awaiting_consent").get();
    for (const doc of waiting.docs) {
      const d = doc.data();
      const decision = renewalRefreshDecision(d.renewalRefresh, now);
      if (decision === "remind") {
        await doc.ref.set({ renewalRefresh: { remindedAt: new Date(now).toISOString() } }, { merge: true });
        await notifyCaregiverAccountEvent(doc.id, "renewal_refresh_reminder", { eventId: `renewal-remind:${doc.id}:${today}` }).catch((err) => console.error("renewal reminder failed", doc.id, err));
      } else if (decision === "lock") {
        const locked = await lockUnauthorizedRefresh(doc.id, now);
        if (!locked) { console.info(`renewalRefreshSweep: ${doc.id} authorized or cleared during the sweep — not locked`); continue; }
        await notifyCaregiverAccountEvent(doc.id, "renewal_refresh_locked", { eventId: `renewal-lock:${doc.id}:${today}` }).catch((err) => console.error("renewal lock notice failed", doc.id, err));
        await db.collection("admin_alerts").add({
          type: "renewal_refresh_locked", severity: "high", resolved: false, caregiverId: doc.id,
          caregiverName: String(d.name ?? "A caregiver"),
          message: `${String(d.name ?? "A caregiver")} did not authorize this year's background check within 7 days of the renewal — paused until they do.`,
          createdAt: new Date(now).toISOString(),
        }).catch(() => {});
      }
    }

    // The amount/period the reminder names come from the subscription record
    // itself (a legacy monthly caregiver plan is not "$69.99/year", B8
    // 2026-10-11); the flat annual display is only the fallback.
    const subscriptionAmountDisplay = (s: Record<string, unknown>): string => {
      const item = (Array.isArray(s.items) ? s.items[0] : undefined) as Record<string, unknown> | undefined;
      const price = (item?.price ?? item?.plan) as Record<string, unknown> | undefined;
      const cents = Number(price?.unit_amount ?? price?.amount);
      const interval = String((price?.recurring as Record<string, unknown> | undefined)?.interval ?? price?.interval ?? "");
      if (!Number.isFinite(cents) || cents <= 0 || !interval) return caregiverAnnualDisplay();
      return `$${(cents / 100).toFixed(2)}/${interval}`;
    };

    // (b) card reminder 7 days before the anniversary — caregivers only
    const members = await db.collection("caregivers").where("membershipStatus", "in", ["active", "trialing"]).get();
    const { readCaregiverSubscriptionRecord } = await import("../caregiverMembershipBilling");
    for (const doc of members.docs) {
      const d = doc.data();
      const sub = await readCaregiverSubscriptionRecord(doc.id).catch(() => null);
      if (!sub || sub.cancel_at_period_end === true) continue;
      const endMs = toMs(sub.current_period_end);
      if (!cardReminderDue(endMs, now)) continue;
      const key = new Date(endMs as number).toISOString().slice(0, 10);
      if (d.renewalReminders?.cardAskedFor === key) continue;
      await doc.ref.set({ renewalReminders: { cardAskedFor: key, cardAskedAt: new Date(now).toISOString() } }, { merge: true });
      const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(endMs as number));
      await notifyCaregiverAccountEvent(doc.id, "membership_renewal_upcoming", { eventId: `renewal-card:${doc.id}:${key}`, ctx: { date, amount: subscriptionAmountDisplay(sub) } })
        .catch((err) => console.error("renewal card reminder failed", doc.id, err));
    }
  });
