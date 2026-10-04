import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, ShieldCheck, XCircle, RefreshCw, ExternalLink, Calendar, CheckCircle, Car, Clock } from 'lucide-react';
import { BackgroundCheckModal } from '../BackgroundCheckModal';
import { getSubscriptionStatus, getCaregiverBillingPortalUrl } from '../../services/stripeService';
import { hasValidTransportDocs } from '../../utils/transportDocs';
import type { Caregiver } from '../../types';

// ── Membership & verification (Account Settings) ─────────────────────────────
// Founder decision 2026-10-04: a caregiver's standing lives in ONE place with its
// dates — membership (next charge), background check (last clear + next check,
// which is the renewal: paying the membership re-runs it), driving record, and
// the Transportation Documents section that follows on the page. Moved here from
// the Payments › Membership tab; Payments keeps the money she earns (Timesheets,
// Payouts). Every button keeps its server path: Manage = the Billing Portal,
// Activate = the membership checkout, Authorize = the FCRA consent modal.

interface SubscriptionInfo {
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

type ToastFn = (message: string, type: 'success' | 'error' | 'info') => void;

export const WHATS_INCLUDED = [
  'Keep 100% of your rate on every booking — families pay the service fee',
  'Access all job postings and apply instantly',
  'Background check badge on your profile',
  'Messaging',
];

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  active:         { label: 'Active',          color: 'text-green-700',  bg: 'bg-green-50 border-green-200',  icon: <CheckCircle2 className="w-4 h-4 text-green-600" /> },
  trialing:       { label: 'Trial',           color: 'text-blue-700',   bg: 'bg-blue-50 border-blue-200',    icon: <ShieldCheck className="w-4 h-4 text-blue-600" /> },
  past_due:       { label: 'Payment due',     color: 'text-amber-700',  bg: 'bg-amber-50 border-amber-200',  icon: <AlertCircle className="w-4 h-4 text-amber-600" /> },
  payment_failed: { label: 'Payment failed',  color: 'text-red-700',    bg: 'bg-red-50 border-red-200',      icon: <XCircle className="w-4 h-4 text-red-600" /> },
  canceled:       { label: 'Canceled',        color: 'text-slate-600',  bg: 'bg-slate-50 border-slate-200',  icon: <XCircle className="w-4 h-4 text-slate-400" /> },
};

const longDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = (iso: unknown): string | null => {
  if (!iso) return null;
  const d = typeof iso === 'string' ? new Date(iso) : (iso as any)?.toDate ? (iso as any).toDate() : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : null;
};

// ── Background check: the dashboard card's rules (CaregiverOnboardingDashboard) ──
export type BackgroundCheckState =
  | { kind: 'consent'; renewal: boolean }
  | { kind: 'cleared'; clearedOn: string | null }
  | { kind: 'in_progress'; detail: 'under_review' | 'on_hold' | 'running' }
  | { kind: 'not_approved' }
  | { kind: 'not_started' };

export function backgroundCheckState(p: any): BackgroundCheckState {
  const bg = p?.backgroundCheckData || {};
  const needsConsent = bg.consentRequired === true || bg.invitationStatus === 'awaiting_consent';
  if (needsConsent) return { kind: 'consent', renewal: bg.consentReason === 'renewal' };
  if (p?.verificationStatus === 'rejected') return { kind: 'not_approved' };
  const cleared = p?.verified === true || p?.backgroundCheckStatus === 'clear' || p?.backgroundCheckComplete === true;
  if (cleared) return { kind: 'cleared', clearedOn: shortDate(bg.checkrClearedAt ?? bg.completedAt ?? p?.approvedAt) };
  if (bg.checkrCandidateId) {
    return { kind: 'in_progress', detail: bg.status === 'consider' ? 'under_review' : bg.status === 'suspended' ? 'on_hold' : 'running' };
  }
  return { kind: 'not_started' };
}

export const AccountStandingSection: React.FC<{
  profile: Caregiver | null;
  addToast: ToastFn;
  onActivate: () => void;
}> = ({ profile, addToast, onActivate }) => {
  const p = profile as any;
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [showBgModal, setShowBgModal] = useState(false);

  // The same read the Payments tab made: the live subscription record.
  useEffect(() => {
    if (subscription !== null) return;
    setSubLoading(true);
    getSubscriptionStatus()
      .then(s => setSubscription({ status: s.status, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd }))
      .catch(() => setSubscription({ status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }))
      .finally(() => setSubLoading(false));
  }, [subscription]);

  const handleManage = async () => {
    setManaging(true);
    try {
      const url = await getCaregiverBillingPortalUrl();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      const code = e?.code as string | undefined;
      let msg = 'Could not open billing portal. Please try again.';
      if (code === 'functions/not-found' || e?.message?.includes('No billing account')) {
        msg = 'No billing account found. Please purchase a membership first.';
      } else if (code === 'functions/unauthenticated') {
        msg = 'Please log in to manage your membership.';
      } else if (code === 'functions/internal' || code === 'internal') {
        msg = 'Billing portal unavailable right now. Please try again later.';
      } else if (e?.message && !['internal', 'unknown'].includes(e.message)) {
        msg = e.message;
      }
      addToast(msg, 'error');
    } finally {
      setManaging(false);
    }
  };

  const status = p?.membershipStatus as string | undefined;
  const isActive = status === 'active' || status === 'trialing';
  const badge = status ? STATUS_BADGE[status] : null;
  const renewalDate = subscription?.currentPeriodEnd ? longDate(subscription.currentPeriodEnd) : null;
  const bg = backgroundCheckState(p);
  const offersTransportation = ((p?.services || p?.skills || []) as string[]).includes('Transportation');
  const isApprovedDriver = p?.isApprovedDriver === true;
  const badgeLive = hasValidTransportDocs(p);
  const mvrPending = p?.mvrStatus === 'pending' || (p?.mvrPaid === true && !isApprovedDriver);
  const mvrClearedOn = shortDate(p?.mvrClearedAt);

  return (
    <>
      {showBgModal && (
        <BackgroundCheckModal
          onClose={() => setShowBgModal(false)}
          onShowToast={addToast}
          onSuccess={() => setShowBgModal(false)}
        />
      )}
      {/* Rendered inside Account Settings' "Membership & verification" accordion — the cards only. */}
      <div className="p-5 space-y-4">

          {/* ── Membership ── */}
          {subLoading && subscription === null ? (
            <div className="rounded-2xl border border-slate-200 p-6 flex items-center justify-center gap-2 text-slate-400 text-sm">
              <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !isActive ? (
            <div className="rounded-2xl border border-slate-200 p-6 text-center">
              <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <ShieldCheck className="w-7 h-7 text-slate-400" />
              </div>
              <h3 className="font-bold text-slate-900 mb-1">No active membership</h3>
              <p className="text-sm text-slate-500 mb-5">
                {status === 'canceled'
                  ? 'Your membership was canceled. Renew to access jobs and platform features.'
                  : 'Activate your membership to start accepting bookings and applying for jobs.'}
              </p>
              <button
                onClick={onActivate}
                className="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                Activate Membership
              </button>
            </div>
          ) : (
            <div className="bg-gradient-to-br from-primary-600 to-blue-700 rounded-3xl p-6 text-white relative overflow-hidden">
              <div className="absolute right-4 top-4 opacity-10">
                <ShieldCheck size={100} />
              </div>
              <div className="relative z-10">
                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold mb-3 ${badge ? badge.bg + ' ' + badge.color : 'bg-white/20 text-white border-white/30'}`}>
                  {badge?.icon}
                  {badge?.label ?? status}
                </div>
                <p className="text-white/70 text-sm mb-0.5">Evia Membership</p>
                {/* No hardcoded amount — legacy $66.49 members and current $69.99 members both land here; exact billing lives in the Stripe portal via Manage. */}
                <p className="text-2xl font-bold">Annual plan</p>
                {subscription?.cancelAtPeriodEnd ? (
                  <p className="text-sm text-amber-200 mt-2">⚠ Cancels on {renewalDate ?? '—'}</p>
                ) : renewalDate ? (
                  <p className="text-sm text-white/60 mt-2 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" /> Renews {renewalDate}
                  </p>
                ) : null}
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-white/80 hover:text-white select-none">What's included</summary>
                  <ul className="mt-2 space-y-1.5">
                    {WHATS_INCLUDED.map(item => (
                      <li key={item} className="flex items-start gap-2 text-white/90">
                        <CheckCircle2 className="w-4 h-4 text-green-300 shrink-0 mt-0.5" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <p className="text-xs text-white/60">Update payment method, cancel, or view invoices via Stripe.</p>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setSubscription(null)}
                      disabled={subLoading}
                      className="p-2 rounded-xl border border-white/30 text-white/80 hover:bg-white/10 transition-colors disabled:opacity-40"
                      title="Refresh status"
                    >
                      <RefreshCw className={`w-4 h-4 ${subLoading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={handleManage}
                      disabled={managing}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white text-primary-700 text-sm font-semibold hover:bg-white/90 transition-colors disabled:opacity-60"
                    >
                      {managing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                      {managing ? 'Opening…' : 'Manage'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Background check ── */}
          <div className={`rounded-2xl border p-5 flex items-center gap-3 ${bg.kind === 'cleared' ? 'border-green-200 bg-green-50/40' : bg.kind === 'consent' ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200'}`}>
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${bg.kind === 'cleared' ? 'bg-green-500' : bg.kind === 'consent' ? 'bg-amber-500' : 'bg-slate-100'}`}>
              {bg.kind === 'cleared'
                ? <CheckCircle className="w-5 h-5 text-white" />
                : bg.kind === 'consent'
                  ? <AlertCircle className="w-5 h-5 text-white" />
                  : <Clock className="w-5 h-5 text-slate-400" />}
            </div>
            <div className="flex-1 min-w-0">
              {bg.kind === 'consent' && (
                <>
                  <p className="font-semibold text-slate-900 text-sm">{bg.renewal ? 'Renew your background check' : 'Start your background check'}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {bg.renewal
                      ? "Your annual membership renewed. Authorize this year's background check refresh to stay bookable."
                      : 'Authorize your background check — it takes about 2 minutes. Your SSN and date of birth go directly to Checkr, never to Evia.'}
                  </p>
                </>
              )}
              {bg.kind === 'cleared' && (
                <>
                  <p className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">Background check cleared</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {bg.clearedOn ? `Cleared ${bg.clearedOn}` : 'Cleared'}
                    {isActive && renewalDate ? ` · Next check with your renewal on ${renewalDate}` : ''}
                  </p>
                </>
              )}
              {bg.kind === 'in_progress' && (
                <>
                  <p className="font-semibold text-slate-900 text-sm">
                    {bg.detail === 'under_review' ? 'Background check under review' : bg.detail === 'on_hold' ? 'Background check on hold' : 'Background check in progress'}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {bg.detail === 'under_review'
                      ? 'This is normal — our team will follow up if anything is needed.'
                      : bg.detail === 'on_hold'
                        ? 'Checkr is gathering additional information. Check your email from Checkr for next steps.'
                        : 'Checkr emailed you a secure link — it usually takes about 5 minutes.'}
                  </p>
                </>
              )}
              {bg.kind === 'not_approved' && (
                <>
                  <p className="font-semibold text-slate-900 text-sm">Background check not approved</p>
                  <p className="text-xs text-slate-500 mt-0.5">Contact support if you have questions.</p>
                </>
              )}
              {bg.kind === 'not_started' && (
                <>
                  <p className="font-semibold text-slate-900 text-sm">Background check</p>
                  <p className="text-xs text-slate-500 mt-0.5">Starts right after your membership is active — it's included in the annual fee.</p>
                </>
              )}
            </div>
            {bg.kind === 'consent' && (
              <button
                onClick={() => setShowBgModal(true)}
                className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white transition-colors"
              >
                {bg.renewal ? "Authorize this year's check" : 'Start background check'}
              </button>
            )}
          </div>

          {/* ── Driving record (Approved Driver) ── */}
          {isApprovedDriver && !badgeLive ? (
            <div className="rounded-2xl border border-slate-200 p-5 flex items-center gap-3">
              <div className="w-11 h-11 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0"><Car className="w-5 h-5 text-blue-600" /></div>
              <div className="flex-1">
                <p className="font-semibold text-slate-900 text-sm">Driving record cleared</p>
                <p className="text-xs text-slate-500">{mvrClearedOn ? `Cleared ${mvrClearedOn}. ` : ''}Your transportation badge turns on once your driver's license, insurance and registration are approved.</p>
              </div>
            </div>
          ) : isApprovedDriver ? (
            <div className="rounded-2xl border border-blue-200 p-5 flex items-center gap-3">
              <div className="w-11 h-11 bg-blue-500 rounded-xl flex items-center justify-center flex-shrink-0"><Car className="w-5 h-5 text-white" /></div>
              <div className="flex-1">
                <p className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">Approved Driver <CheckCircle className="w-4 h-4 text-blue-600" /></p>
                <p className="text-xs text-slate-500">{mvrClearedOn ? `Cleared ${mvrClearedOn} · ` : ''}Families who need a driver can see your verified-driver badge.</p>
              </div>
            </div>
          ) : mvrPending ? (
            <div className="rounded-2xl border border-slate-200 p-5 flex items-center gap-3">
              <div className="w-11 h-11 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0"><Car className="w-5 h-5 text-slate-400" /></div>
              <div className="flex-1">
                <p className="font-semibold text-slate-900 text-sm">Driver check in progress</p>
                <p className="text-xs text-slate-500">Your Motor Vehicle Report is being reviewed. We'll activate your Approved Driver badge once it clears.</p>
              </div>
            </div>
          ) : offersTransportation ? (
            <div className="rounded-2xl border border-slate-200 p-5 flex items-center gap-3">
              <div className="w-11 h-11 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0"><Car className="w-5 h-5 text-blue-600" /></div>
              <div className="flex-1">
                <p className="font-semibold text-slate-900 text-sm">Driving record check included</p>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">Your membership covers the Motor Vehicle Report. It starts automatically once your background check clears — no extra charge.</p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 p-5 flex items-center gap-3">
              <div className="w-11 h-11 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0"><Car className="w-5 h-5 text-slate-400" /></div>
              <div className="flex-1">
                <p className="font-semibold text-slate-900 text-sm">Offer transportation?</p>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">Add Transportation to your services and upload your driver's license, insurance, and registration. Your membership already covers the driving record check.</p>
              </div>
            </div>
          )}
      </div>
    </>
  );
};
