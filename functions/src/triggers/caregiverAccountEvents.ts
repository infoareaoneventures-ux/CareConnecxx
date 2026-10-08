// caregivers/{uid} record changes → caregiver account-event notifications.
//
// The dashboard's progress bar reads the caregiver record; whoever changes it
// (Stripe / Checkr webhooks, the admin panel's overrides and document reviews,
// Evia's own steps, the daily badge job) the change lands here ONCE, and the
// caregiver hears about it once — bell + text with the same words
// (notifications/caregiverAccountEvents.ts). Events with no record transition
// (a payment-failed attempt, a renewal invoice, a scheduled cancel) are sent
// by their Stripe handlers through the same module.
import * as functions from "firebase-functions/v1";
import { notifyCaregiverAccountEvent, CaregiverAccountEventKind, CaregiverAccountEventContext } from "../notifications/caregiverAccountEvents";
import { isCaregiverBookable, isCaregiverMembershipActiveForFamilies } from "../utils/caregiverEligibility";
import * as admin from "firebase-admin";

type Doc = Record<string, any>;

function bg(d: Doc | undefined): Doc { return (d?.backgroundCheckData ?? {}) as Doc; }
// Transportation live = offered + driving record cleared (no documents, 2026-10-06).
function badge(d: Doc | undefined): boolean { return !!d && offersTransportation(d) && d.isApprovedDriver === true; }
function offersTransportation(d: Doc | undefined): boolean {
  const services = (Array.isArray(d?.services) && (d!.services as unknown[]).length ? d!.services : (d?.skills ?? [])) as string[]; // services first, else skills (2026-10-07)
  return services.includes("Transportation");
}

/** Pure: which events this before→after change represents, in the order they should be told. */
export function caregiverAccountTransitions(before: Doc | undefined, after: Doc | undefined): Array<{ kind: CaregiverAccountEventKind; ctx?: CaregiverAccountEventContext }> {
  const out: Array<{ kind: CaregiverAccountEventKind; ctx?: CaregiverAccountEventContext }> = [];
  if (!after) return out;
  const b = before ?? {};
  const a = after;

  // ── Membership ────────────────────────────────────────────────────────────
  const paidBefore = b.membershipPaid === true;
  const paidAfter = a.membershipPaid === true;
  if (!paidBefore && paidAfter && a.membershipStatus !== "canceled") out.push({ kind: "membership_paid" });
  if (paidBefore && !paidAfter) out.push({ kind: "membership_revoked" });
  if (b.membershipStatus !== "canceled" && a.membershipStatus === "canceled") out.push({ kind: "membership_cancelled" });
  // (payment_failed / cancel-scheduled / reactivated / renewal carry invoice facts → the Stripe handlers send them.)

  // ── Background check ──────────────────────────────────────────────────────
  const bgB = bg(b); const bgA = bg(a);
  if (bgB.invitationStatus !== "sent" && bgA.invitationStatus === "sent" && bgA.consentGiven === true && bgA.invitationUrl) {
    out.push({ kind: "bgcheck_consent_received", ctx: { url: String(bgA.invitationUrl), renewal: bgA.consentReason === "renewal" } });
  }
  const clearedNow = b.backgroundCheckStatus !== "clear" && a.backgroundCheckStatus === "clear";
  if (clearedNow) out.push({ kind: "bgcheck_clear" });
  if (b.backgroundCheckStatus === "clear" && a.backgroundCheckStatus !== "clear" && a.backgroundCheckStatus !== undefined) {
    // A yearly renewal resets the same fields but is announced by its invoice ("membership_renewed").
    if (!(bgA.consentRequired === true && bgA.consentReason === "renewal")) out.push({ kind: "bgcheck_revoked" });
  }
  if (bgB.status !== bgA.status) {
    if (bgA.status === "consider" && a.verificationStatus !== "pre_adverse_action" && a.verificationStatus !== "rejected") out.push({ kind: "bgcheck_review" });
    if (bgA.status === "suspended") out.push({ kind: "bgcheck_on_hold" });
    if (bgA.status === "canceled") out.push({ kind: "bgcheck_canceled" });
  }
  if (bgB.disputed !== true && bgA.disputed === true) out.push({ kind: "bgcheck_disputed" });
  if (b.verificationStatus !== "pre_adverse_action" && a.verificationStatus === "pre_adverse_action") out.push({ kind: "bgcheck_action_required" });
  if (b.verificationStatus !== "rejected" && a.verificationStatus === "rejected") out.push({ kind: "bgcheck_not_approved" });
  if (bgB.invitationStatus !== "expired" && bgA.invitationStatus === "expired") out.push({ kind: "bgcheck_link_expired" });
  if (bgB.invitationStatus !== "awaiting_documents" && bgA.invitationStatus === "awaiting_documents") out.push({ kind: "bgcheck_document_required" });

  // ── Driving record / Transportation ──────────────────────────────────────
  const badgeB = badge(b); const badgeA = badge(a);
  if (b.mvrStatus !== a.mvrStatus) {
    // The bundled criminal+MVR clear is announced by bgcheck_clear; the standalone MVR by its own line.
    if (a.mvrStatus === "clear" && !clearedNow) out.push({ kind: "mvr_clear" });
    if (a.mvrStatus === "consider" || a.mvrStatus === "suspended") out.push({ kind: "mvr_review" });
    if (a.mvrStatus === "not_approved") out.push({ kind: "mvr_not_approved" });
    // Later MVR, consent-first (2026-10-06): the record parked on "authorize your driving record check".
    if (a.mvrStatus === "awaiting_consent") out.push({ kind: "mvr_consent_requested" });
    // MVR-only check started (2026-10-07): text the completion link, as the bundled path texts its Checkr link.
    if (a.mvrStatus === "pending" && a.mvrCheckInitiated === true && typeof a.mvrInvitationUrl === "string") out.push({ kind: "mvr_check_started", ctx: { url: String(a.mvrInvitationUrl) } });
  }
  if (!badgeB && badgeA) out.push({ kind: "transport_badge_earned" });
  if (badgeB && !badgeA) {
    const reason: CaregiverAccountEventContext["reason"] = a.isApprovedDriver !== true ? "mvr" : !offersTransportation(a) ? "services" : undefined;
    out.push({ kind: "transport_badge_lost", ctx: { reason } });
  }

  // ── Payouts ───────────────────────────────────────────────────────────────
  const payB = b.payoutsEnabled === true || b.stripeOnboardingComplete === true;
  const payA = a.payoutsEnabled === true || a.stripeOnboardingComplete === true;
  if (!payB && payA) out.push({ kind: "payouts_enabled" });
  if (payB && !payA && (a.payoutsEnabled === false || a.stripeOnboardingComplete === false)) out.push({ kind: "payouts_disabled" });

  // ── Bookable (the one true "you're approved") ──────────────────────────────
  if (!isCaregiverBookable(b) && isCaregiverBookable(a)) out.push({ kind: "now_bookable" });

  return out;
}

/** Pure: can this caregiver work right now — membership active (incl. Stripe retries) AND background cleared. */
export function canWork(d: Doc | undefined): boolean {
  if (!d) return false;
  const bgOk = d.verified === true || d.backgroundCheckStatus === "clear" || d.backgroundCheckComplete === true;
  return bgOk && isCaregiverMembershipActiveForFamilies(d);
}
/** Pure: did this change lock the caregiver (working → not working)? */
export function lockedNow(before: Doc | undefined, after: Doc | undefined): boolean {
  return canWork(before) && !canWork(after);
}

/**
 * Founder, 2026-10-06: when a caregiver gets locked (Stripe gave up on the renewal, the
 * yearly refresh wasn't authorized in time or came back not clear, admin Revoked), the
 * family must not find out by a no-show. Every upcoming scheduled visit goes through the
 * SAME write the caregiver's own ✕ makes (cancelShiftLikeThePage) — the family gets the
 * usual "cancelled the visit… find a replacement or skip it" text and the Needs
 * Replacement card from onShiftStatusChanged; the reason is never stated. The team gets
 * one alert with the count.
 */
export async function releaseUpcomingVisitsOnLock(uid: string): Promise<number> {
  const db = admin.firestore();
  const today = new Date().toISOString().slice(0, 10);
  const snap = await db.collection("shifts")
    .where("caregiverId", "==", uid)
    .where("status", "in", ["scheduled"])
    .where("date", ">=", today)
    .limit(120)
    .get();
  const { cancelShiftLikeThePage } = await import("../agents/caregiverCancelShiftHandler");
  let released = 0;
  for (const d of snap.docs) {
    const r = await cancelShiftLikeThePage(d.id, "system").catch(() => ({ ok: false as const, reason: "not_found" as const }));
    if (r.ok) released++;
  }
  const cg = (await db.collection("caregivers").doc(uid).get()).data() ?? {};
  await db.collection("admin_alerts").add({
    type: "caregiver_locked",
    severity: released > 0 ? "high" : "medium",
    resolved: false,
    caregiverId: uid,
    caregiverName: String(cg.name ?? "A caregiver"),
    releasedVisits: released,
    membershipStatus: cg.membershipStatus ?? null,
    backgroundCheckStatus: cg.backgroundCheckStatus ?? null,
    message: `${String(cg.name ?? "A caregiver")} is locked (membership ${cg.membershipStatus ?? "unknown"}, background ${cg.backgroundCheckStatus ?? "unknown"}); ${released} upcoming visit${released === 1 ? "" : "s"} released to the families.`,
    createdAt: new Date().toISOString(),
  }).catch(() => {});
  return released;
}

export const onCaregiverAccountChange = functions.firestore
  .document("caregivers/{uid}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() as Doc | undefined;
    const after = change.after.data() as Doc | undefined;
    const uid = context.params.uid as string;
    const events = caregiverAccountTransitions(before, after);
    for (const ev of events) {
      await notifyCaregiverAccountEvent(uid, ev.kind, { eventId: context.eventId, ctx: ev.ctx })
        .catch((err) => console.error(`[onCaregiverAccountChange] ${ev.kind} failed for ${uid}:`, err));
    }
    if (lockedNow(before, after)) {
      await releaseUpcomingVisitsOnLock(uid)
        .catch((err) => console.error(`[onCaregiverAccountChange] visit release failed for ${uid}:`, err));
    }
  });
