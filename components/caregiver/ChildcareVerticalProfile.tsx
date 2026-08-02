// ── ChildcareVerticalProfile (plan 2026-07-22-002, U11) ──────────────────────
//
// The caregiver's SINGLE childcare vertical-profile page (pilot staging
// decision: self-serve dual-vertical UI is one functional page reachable from
// CaregiverAccountSettings — admin-driven onboarding remains primary).
//
// Callable-only (R11/KTD6), mirroring the U5 provider callables exactly:
//   • v1-getMyChildcareProviderState — own state + eligibility.issues codes;
//     every issue maps to EXACT remediation copy below (what's missing + what
//     to do), unknown codes fall back to a generic remediation that still
//     names the code (never silent omission).
//   • v1-upsertChildcareVerticalProfile — the childcare DELTA only; the
//     response's reusedBaseFields are surfaced so nothing re-asks base data
//     (AE21).
//   • v1-acceptChildcarePolicy — versioned consent (R23).
//   • v1-startChildcareScreening — screening start/renewal; the returned
//     invitationUrl is the caregiver's own Checkr apply link.
//
// Senior independence (R24/R31/AE9): nothing on this page touches senior
// services, rates, approval, or reputation — stated in the UI copy and pinned
// by tests.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { functions } from '../../lib/firebase';
import { childcareCallable } from '../../lib/childcareCallable';
import { CaregiverTopNav } from './CaregiverTopNav';
import {
  ageBandLabel,
  callableErrorCode,
  categoryLabel,
  isChildcareDisabledError,
  type ChildcareProviderStateResponse,
} from '../shared/childcareAccess';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

const AGE_BAND_OPTIONS = ['toddler', 'preschool', 'school_age', 'preteen', 'teen'] as const;
const SERVICE_OPTIONS = ['babysitting', 'nanny_care', 'after_school_care', 'date_night_care'] as const;

/**
 * Exact remediation copy per eligibility issue code (U11 binding rule:
 * "what's missing + what to do", mirroring getMyChildcareProviderState issues).
 */
export const CHILDCARE_REMEDIATION: Record<string, { missing: string; action: string }> = {
  vertical_profile_missing: {
    missing: 'You have not created a childcare profile yet.',
    action: 'Fill out and save the childcare profile form below.',
  },
  profile_incomplete: {
    missing: 'Your childcare profile is missing required details.',
    action: 'Complete the highlighted fields in the form below and save again.',
  },
  base_profile_incomplete: {
    missing: 'Your base caregiver profile is missing required details (name, email, or location).',
    action: 'Update them in Account Settings — they are shared across senior and childcare work.',
  },
  jurisdiction_not_ready: {
    missing: 'Childcare is not open in your state yet.',
    action: 'No action needed — we will notify you the moment your state opens.',
  },
  credential_missing: {
    missing: 'A credential required for childcare in your state is missing.',
    action: 'Add the required credential in the form below.',
  },
  credential_expired: {
    missing: 'A required childcare credential has expired.',
    action: 'Add a current version of the credential in the form below.',
  },
  screening_absent: {
    missing: 'Your childcare background check has not been started.',
    action: 'Start it with the button in the Background check section below.',
  },
  evidence_none: {
    missing: 'No childcare background-check evidence exists yet.',
    action: 'Start the background check below.',
  },
  evidence_pending: {
    missing: 'Your childcare background check is still in progress.',
    action: 'No action needed — we will update this page automatically when it completes.',
  },
  invitation_expired: {
    missing: 'Your background-check invitation expired before it was completed.',
    action: 'Restart the background check below to get a fresh invitation.',
  },
  invitation_canceled: {
    missing: 'Your background-check invitation was canceled.',
    action: 'Restart the background check below.',
  },
  report_expired: {
    missing: 'Your childcare background check has expired.',
    action: 'Renew it with the button in the Background check section below.',
  },
  evidence_consider: {
    missing: 'Your background check needs a human review before childcare can proceed.',
    action: 'Our team follows the required review process and will contact you — questions go to support@eviacares.com.',
  },
  evidence_suspended: {
    missing: 'Your background check is suspended pending more information.',
    action: 'Check your email for a request from the screening provider, or contact support@eviacares.com.',
  },
  evidence_disputed: {
    missing: 'Your background-check result is under dispute.',
    action: 'No action needed while the dispute is reviewed — contact support@eviacares.com with questions.',
  },
  evidence_canceled: {
    missing: 'Your background check was canceled.',
    action: 'Restart it with the button in the Background check section below.',
  },
  manual_approval_missing: {
    missing: 'Your childcare profile has not been approved by the Evia team yet.',
    action: 'Complete everything above — our team reviews profiles once all other requirements are met.',
  },
  manual_approval_revoked: {
    missing: 'Your childcare approval was revoked.',
    action: 'Contact support@eviacares.com to understand the decision and next steps.',
  },
  policy_acceptance_missing: {
    missing: 'You have not accepted the childcare policy for your state.',
    action: 'Review and accept it in the Policy section below.',
  },
  policy_acceptance_stale: {
    missing: 'The childcare policy was updated since you accepted it.',
    action: 'Re-accept the current version in the Policy section below.',
  },
  suspension_active: {
    missing: 'Your childcare visibility is suspended.',
    action: 'Contact support@eviacares.com — your senior care work is not affected by this suspension.',
  },
  base_account_paused: {
    missing: 'Your caregiver account is paused.',
    action: 'Contact support@eviacares.com to reactivate your account.',
  },
  membership_inactive: {
    missing: 'An active caregiver membership is required for childcare visibility.',
    action: 'Renew your membership from the Membership page.',
  },
  payout_not_ready: {
    missing: 'Your payout setup (Stripe) is incomplete.',
    action: 'Finish payout setup from the Payments page.',
  },
};

function remediationFor(code: string, field: string): { missing: string; action: string } {
  const known = CHILDCARE_REMEDIATION[code];
  if (known) {
    if (code === 'profile_incomplete' && field && !field.startsWith('(')) {
      return { missing: `Your childcare profile is missing: ${categoryLabel(field)}.`, action: known.action };
    }
    if (code === 'base_profile_incomplete' && field && !field.startsWith('(')) {
      return { missing: `Your base caregiver profile is missing: ${categoryLabel(field)}.`, action: known.action };
    }
    return known;
  }
  return {
    missing: `A requirement is not met (code: ${code}).`,
    action: 'Contact support@eviacares.com if this does not clear after completing the sections below.',
  };
}

export const ChildcareVerticalProfile: React.FC = () => {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [state, setState] = useState<ChildcareProviderStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);

  // Form state (seeded from the loaded profile).
  const [ageBands, setAgeBands] = useState<Set<string>>(new Set());
  const [services, setServices] = useState<Set<string>>(new Set());
  const [yearsExperience, setYearsExperience] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [offersTransport, setOffersTransport] = useState(false);
  const [jurisdictionState, setJurisdictionState] = useState('CA');
  const [adultAgeAttested, setAdultAgeAttested] = useState(false);

  const seedForm = useCallback((resp: ChildcareProviderStateResponse) => {
    const profile = resp.verticalProfile;
    if (!profile) return;
    setAgeBands(new Set(profile.ageBands));
    setServices(new Set(profile.services));
    setYearsExperience(profile.yearsChildcareExperience != null ? String(profile.yearsChildcareExperience) : '');
    setHourlyRate(profile.hourlyRate != null ? String(profile.hourlyRate) : '');
    setOffersTransport(profile.transport?.offersTransport === true);
    if (profile.jurisdictionState) setJurisdictionState(profile.jurisdictionState);
    setAdultAgeAttested(profile.adultAgeAttested === true);
  }, []);

  const refresh = useCallback(async () => {
    if (!functions) { setLoadState('error'); return; }
    try {
      const resp = await childcareCallable('getMyChildcareProviderState')({});
      const data = resp.data as ChildcareProviderStateResponse;
      setState(data);
      seedForm(data);
      setLoadState('ready');
    } catch (err) {
      setLoadState(isChildcareDisabledError(err) ? 'unavailable' : 'error');
    }
  }, [seedForm]);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  const mapError = (err: unknown, fallback: string): string => {
    const code = callableErrorCode(err);
    if (code === 'childcare_disabled') return 'Childcare features are not available right now.';
    if (code === 'policy_version_unavailable') return 'The childcare policy for your state is not ready to accept yet — no action needed until it opens.';
    if (code === 'base_profile_incomplete') return 'Your profile needs a full name and email before a screening can start — update them in Account Settings first.';
    if (code === 'jurisdiction_not_ready') return 'Childcare is not open in your state yet — we will notify you when it is.';
    return fallback;
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!functions || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await childcareCallable('upsertChildcareVerticalProfile')({
        jurisdictionState,
        ageBands: [...ageBands],
        services: [...services],
        yearsChildcareExperience: yearsExperience === '' ? null : Number(yearsExperience),
        hourlyRate: hourlyRate === '' ? null : Number(hourlyRate),
        offersTransport,
        adultAgeAttested,
      });
      const data = resp.data as { reusedBaseFields?: string[]; missingChildcareFields?: string[] };
      const reused = data?.reusedBaseFields ?? [];
      setNotice(
        reused.length > 0
          ? `Childcare profile saved. We reused ${reused.length} detail${reused.length === 1 ? '' : 's'} from your existing profile (${reused.map(categoryLabel).join(', ')}) — no need to re-enter them.`
          : 'Childcare profile saved.',
      );
      await refresh();
    } catch (err) {
      setError(mapError(err, 'Could not save the childcare profile. Please check the fields and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const acceptPolicy = async () => {
    if (!functions || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await childcareCallable('acceptChildcarePolicy')({});
      const data = resp.data as { acceptedPolicyVersion?: string };
      setNotice(`Childcare policy accepted${data?.acceptedPolicyVersion ? ` (version ${data.acceptedPolicyVersion})` : ''}.`);
      await refresh();
    } catch (err) {
      setError(mapError(err, 'Could not record the policy acceptance. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const startScreening = async () => {
    if (!functions || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await childcareCallable('startChildcareScreening')({});
      const data = resp.data as { mode?: string; invitationUrl?: string };
      if (data?.mode === 'invitation_sent' && data.invitationUrl) {
        setInvitationUrl(data.invitationUrl);
        setNotice('Background check started — complete it with the secure link below.');
      } else if (data?.mode === 'already_current') {
        setNotice('Your background check is already current — nothing to do.');
      } else if (data?.mode === 'invitation_outstanding') {
        setNotice('A screening invitation is already outstanding — check your email for the link from our screening provider.');
      } else if (data?.mode === 'base_evidence_adopted') {
        setNotice('Your existing background check covers childcare too — it has been adopted for this profile.');
      } else {
        setNotice('Background check request submitted.');
      }
      await refresh();
    } catch (err) {
      setError(mapError(err, 'Could not start the background check. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50">
        <CaregiverTopNav />
        <div className="flex justify-center py-24" role="status" aria-label="Loading childcare profile">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <div className="min-h-screen bg-slate-50">
        <CaregiverTopNav />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-2">
          <h1 className="text-xl font-semibold text-slate-900">Childcare is coming soon</h1>
          <p className="text-slate-500 text-sm">
            Childcare work is not open in your area yet. Your senior care profile, approval, and bookings are
            completely unaffected — we will let you know when childcare opens.
          </p>
        </div>
      </div>
    );
  }

  if (loadState === 'error' || !state) {
    return (
      <div className="min-h-screen bg-slate-50">
        <CaregiverTopNav />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4" role="alert">
          <p className="text-slate-600 text-sm">We could not load your childcare profile.</p>
          <button
            type="button"
            onClick={() => { setLoadState('loading'); void refresh(); }}
            className="px-5 py-2.5 rounded-full bg-slate-900 text-white text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const eligible = state.eligibility?.eligible === true;
  const issues = state.eligibility?.issues ?? [];
  const screening = state.screening;
  const profile = state.verticalProfile;
  const policyAccepted = !!profile?.acceptedPolicyVersion;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <header>
          <h1 className="text-2xl font-bold text-slate-900">Childcare profile</h1>
          <p className="text-sm text-slate-500 mt-1">
            Your childcare qualifications are separate from senior care — nothing here changes your senior
            services, rates, approval, or reviews.
          </p>
        </header>

        {notice && (
          <div role="status" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* ── Visibility / approval state + exact remediation ── */}
        <section className={`rounded-2xl border p-5 space-y-3 ${eligible ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'}`}>
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary-600" aria-hidden="true" /> Childcare visibility
          </h2>
          {eligible ? (
            <p className="text-sm text-emerald-800 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" aria-hidden="true" />
              You are visible to families for childcare. Everything required is current.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                You are <span className="font-semibold">not visible for childcare yet</span>. Here is exactly what
                is missing and what to do:
              </p>
              <ul className="space-y-2" data-testid="remediation-list">
                {issues.map((issue, idx) => {
                  const r = remediationFor(issue.code, issue.field);
                  return (
                    <li key={`${issue.code}-${issue.field}-${idx}`} className="flex items-start gap-2 text-sm">
                      <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
                      <span>
                        <span className="font-medium text-slate-800">{r.missing}</span>{' '}
                        <span className="text-slate-600">{r.action}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {/* ── Vertical profile form ── */}
        <form onSubmit={saveProfile} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
          <h2 className="font-semibold text-slate-900">Childcare details</h2>

          <fieldset>
            <legend className="text-xs font-medium text-slate-500 mb-1">Age groups you care for</legend>
            <div className="flex flex-wrap gap-2">
              {AGE_BAND_OPTIONS.map((band) => (
                <label key={band} className="inline-flex items-center gap-1.5 text-sm text-slate-700 border border-slate-200 rounded-full px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={ageBands.has(band)}
                    onChange={() => toggle(ageBands, band, setAgeBands)}
                    aria-label={`Age group ${ageBandLabel(band)}`}
                  />
                  {ageBandLabel(band)}
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">Infant care is not available yet.</p>
          </fieldset>

          <fieldset>
            <legend className="text-xs font-medium text-slate-500 mb-1">Childcare services</legend>
            <div className="flex flex-wrap gap-2">
              {SERVICE_OPTIONS.map((service) => (
                <label key={service} className="inline-flex items-center gap-1.5 text-sm text-slate-700 border border-slate-200 rounded-full px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={services.has(service)}
                    onChange={() => toggle(services, service, setServices)}
                    aria-label={`Service ${categoryLabel(service)}`}
                  />
                  {categoryLabel(service)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs font-medium text-slate-500">
              Years of childcare experience
              <input
                type="number"
                min={0}
                max={80}
                value={yearsExperience}
                onChange={(e) => setYearsExperience(e.target.value)}
                aria-label="Years of childcare experience"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800"
              />
            </label>
            <label className="text-xs font-medium text-slate-500">
              Childcare hourly rate ($15–200)
              <input
                type="number"
                min={15}
                max={200}
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                aria-label="Childcare hourly rate"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800"
              />
            </label>
            <label className="text-xs font-medium text-slate-500">
              State
              <input
                value={jurisdictionState}
                maxLength={2}
                onChange={(e) => setJurisdictionState(e.target.value.toUpperCase())}
                aria-label="Jurisdiction state"
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={offersTransport}
              onChange={() => setOffersTransport((v) => !v)}
              aria-label="I can drive children"
            />
            I can drive children (requires current driving verification before families see it)
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={adultAgeAttested}
              onChange={() => setAdultAgeAttested((v) => !v)}
              aria-label="I confirm I am 18 or older"
            />
            I confirm I am 18 or older
          </label>

          <button
            type="submit"
            disabled={busy}
            className="px-5 py-2.5 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold disabled:opacity-40"
          >
            {profile ? 'Save childcare profile' : 'Create childcare profile'}
          </button>
        </form>

        {/* ── Policy acceptance ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold text-slate-900">Childcare policy</h2>
          {policyAccepted ? (
            <p className="text-sm text-emerald-700 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" aria-hidden="true" />
              Policy accepted (version {profile?.acceptedPolicyVersion}).
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              You must accept your state&apos;s childcare policy before your profile can be reviewed.
            </p>
          )}
          <button
            type="button"
            onClick={() => void acceptPolicy()}
            disabled={busy || !profile}
            className="px-4 py-2 rounded-full border border-slate-200 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          >
            {policyAccepted ? 'Re-accept current policy' : 'Accept childcare policy'}
          </button>
          {!profile && (
            <p className="text-xs text-slate-400">Save your childcare details first — the policy is state-specific.</p>
          )}
        </section>

        {/* ── Screening ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold text-slate-900">Background check</h2>
          {screening ? (
            <div className="text-sm text-slate-600 space-y-1">
              <p>Status: <span className="font-medium text-slate-800">{categoryLabel(screening.evidenceStatus)}</span></p>
              {screening.invitationStatus && screening.invitationStatus !== 'none' && (
                <p>Invitation: {categoryLabel(screening.invitationStatus)}</p>
              )}
              {screening.expiresAt && <p>Valid until: {screening.expiresAt.slice(0, 10)}</p>}
              {screening.adverseActionState && screening.adverseActionState !== 'none' && (
                <p className="text-amber-700">
                  A review process is underway ({categoryLabel(screening.adverseActionState)}) — our team will
                  contact you with next steps.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-600">No childcare background check on file yet.</p>
          )}
          {state.eligibility?.renewalDue && (
            <p className="text-sm text-amber-700">Your background check is due for renewal.</p>
          )}
          <button
            type="button"
            onClick={() => void startScreening()}
            disabled={busy || !profile}
            className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-40"
          >
            {screening && screening.evidenceStatus !== 'none' ? 'Renew background check' : 'Start background check'}
          </button>
          {!profile && (
            <p className="text-xs text-slate-400">Save your childcare details first — screening is state-specific.</p>
          )}
          {invitationUrl && (
            <a
              href={invitationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-600 hover:text-primary-700"
            >
              Complete your background check <ExternalLink className="w-4 h-4" aria-hidden="true" />
            </a>
          )}
          <p className="text-xs text-slate-400">
            A completed check is one requirement among several — it is reviewed with the rest of your profile and
            is never an automatic approval.
          </p>
        </section>
      </main>
    </div>
  );
};

export default ChildcareVerticalProfile;
