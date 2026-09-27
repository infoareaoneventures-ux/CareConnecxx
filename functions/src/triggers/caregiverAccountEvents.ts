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
import { notifyCaregiverAccountEvent, TRANSPORT_DOC_LABELS, CaregiverAccountEventKind, CaregiverAccountEventContext } from "../notifications/caregiverAccountEvents";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { hasValidTransportDocs as transportDocsApprovedForMatching } from "../agents/caregiverMatchScoring";

type Doc = Record<string, any>;
const TRANSPORT_DOCS = ["driversLicense", "insurance", "registration"] as const;

function bg(d: Doc | undefined): Doc { return (d?.backgroundCheckData ?? {}) as Doc; }
function badge(d: Doc | undefined): boolean { return !!d && transportDocsApprovedForMatching(d) && d.isApprovedDriver === true; }
function allDocsApproved(d: Doc | undefined): boolean {
  const docs = (d?.documents ?? {}) as Doc;
  return TRANSPORT_DOCS.every((t) => docs[t]?.status === "approved");
}
function anyDocExpired(d: Doc | undefined): boolean {
  const docs = (d?.documents ?? {}) as Doc;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return TRANSPORT_DOCS.some((t) => {
    const exp = docs[t]?.expirationDate as string | undefined;
    if (!exp) return false;
    const [y, m, dd] = exp.split("-").map(Number);
    return new Date(y, m - 1, dd) < today;
  });
}
function offersTransportation(d: Doc | undefined): boolean {
  const services = [...((d?.skills as string[]) ?? []), ...((d?.services as string[]) ?? [])];
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

  // ── Transport documents / driving record / badge ──────────────────────────
  const docsB = (b.documents ?? {}) as Doc; const docsA = (a.documents ?? {}) as Doc;
  for (const t of TRANSPORT_DOCS) {
    const sb = docsB[t]?.status; const sa = docsA[t]?.status;
    if (sb === sa) continue;
    if (sa === "approved") out.push({ kind: "transport_doc_approved", ctx: { docLabel: TRANSPORT_DOC_LABELS[t] } });
    if (sa === "rejected") out.push({ kind: "transport_doc_rejected", ctx: { docLabel: TRANSPORT_DOC_LABELS[t], docNotes: docsA[t]?.notes ? String(docsA[t].notes) : undefined } });
  }
  const badgeB = badge(b); const badgeA = badge(a);
  if (!allDocsApproved(b) && allDocsApproved(a) && !badgeA) out.push({ kind: "transport_docs_all_approved" });
  if (b.mvrStatus !== a.mvrStatus) {
    // The bundled criminal+MVR clear is announced by bgcheck_clear; the standalone MVR by its own line.
    if (a.mvrStatus === "clear" && !clearedNow) out.push({ kind: "mvr_clear" });
    if (a.mvrStatus === "consider" || a.mvrStatus === "suspended") out.push({ kind: "mvr_review" });
  }
  if (!badgeB && badgeA) out.push({ kind: "transport_badge_earned" });
  if (badgeB && !badgeA) {
    const reason: CaregiverAccountEventContext["reason"] =
      anyDocExpired(a) ? "expired" : !allDocsApproved(a) ? "documents" : a.isApprovedDriver !== true ? "mvr" : !offersTransportation(a) ? "services" : undefined;
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
  });
