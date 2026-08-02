// ── ChildcareMatches (plan 2026-07-22-002, U11) ──────────────────────────────
//
// Eligible applications for one of the family's childcare jobs, with
// accept/reject. Callable-only (R11):
//   • job context:      v1-listMyChildcareJobs (own jobs; find by :jobId)
//   • applications:     v1-listChildcareJobApplications — DOCUMENTED U11 SEAM
//     (not yet exported by functions/src; explicit unavailable state + retry
//     until it lands — never silent omission)
//   • applicant card:   v1-publicCaregiverProfile (safe public subset only —
//     the same projection the /p/{id} page uses; R30)
//   • decisions:        v1-acceptChildcareApplication / v1-rejectChildcareApplication
//
// Eligibility itself is SERVER-owned (R29/R34): accept re-checks the provider
// live and this UI only surfaces the server's answer (provider_not_eligible).

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Loader2, UserCheck, UserX } from 'lucide-react';
import { functions } from '../../../lib/firebase';
import {
  childcareCallable,
  type ChildcareCallableWireName,
} from '../../../lib/childcareCallable';
import { ClientNavigation } from '../ClientNavigation';
import { CaregiverVerificationBadges } from '../../shared/CaregiverVerificationBadges';
import {
  ageBandLabel,
  callableErrorCode,
  categoryLabel,
  isChildcareDisabledError,
  type ChildcareApplicationSummary,
  type ChildcareJobSummary,
} from '../../shared/childcareAccess';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

interface ApplicantProfile {
  name?: string;
  photo?: string;
  imageUrl?: string;
  city?: string;
  state?: string;
  verified?: boolean;
  backgroundCheckStatus?: string;
  childcareEvidenceLabels?: string[];
  childcareReputation?: { ratingAvg?: number; ratingCount?: number };
}

export const ChildcareMatches: React.FC = () => {
  const navigate = useNavigate();
  const { jobId } = useParams<{ jobId: string }>();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [job, setJob] = useState<ChildcareJobSummary | null>(null);
  const [applications, setApplications] = useState<ChildcareApplicationSummary[] | null>(null);
  const [applicationsError, setApplicationsError] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, ApplicantProfile>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadApplications = useCallback(async () => {
    if (!functions || !jobId) { setApplicationsError(true); return; }
    setApplicationsError(false);
    try {
      // U11 seam — see module header.
      const resp = await childcareCallable('listChildcareJobApplications')({ jobId });
      const apps = ((resp.data as { applications?: ChildcareApplicationSummary[] })?.applications) ?? [];
      setApplications(apps);
      // Applicant display data comes from the PUBLIC profile projection only.
      const results = await Promise.all(
        apps
          .filter((a) => a.caregiverId)
          .map(async (a) => {
            try {
              const p = await functions!.httpsCallable('v1-publicCaregiverProfile')({ id: a.caregiverId });
              const data = p.data as { found?: boolean; profile?: ApplicantProfile };
              return [a.caregiverId as string, data?.found && data.profile ? data.profile : {}] as const;
            } catch {
              return [a.caregiverId as string, {}] as const;
            }
          }),
      );
      setProfiles(Object.fromEntries(results));
    } catch (err) {
      if (isChildcareDisabledError(err)) setLoadState('unavailable');
      else { setApplications(null); setApplicationsError(true); }
    }
  }, [jobId]);

  const refresh = useCallback(async () => {
    if (!functions || !jobId) { setLoadState('error'); return; }
    try {
      const resp = await childcareCallable('listMyChildcareJobs')({});
      const jobs = ((resp.data as { jobs?: ChildcareJobSummary[] })?.jobs) ?? [];
      const match = jobs.find((j) => j.jobId === jobId) ?? null;
      setJob(match);
      setLoadState('ready');
      void loadApplications();
    } catch (err) {
      setLoadState(isChildcareDisabledError(err) ? 'unavailable' : 'error');
    }
  }, [jobId, loadApplications]);

  useEffect(() => { void refresh(); }, [refresh]);

  const decide = async (application: ChildcareApplicationSummary, decision: 'accept' | 'reject') => {
    if (!functions || !jobId || !application.caregiverId || busyId) return;
    setBusyId(application.applicationId);
    setError(null);
    setNotice(null);
    try {
      const name: ChildcareCallableWireName =
        decision === 'accept'
          ? 'v1-acceptChildcareApplication'
          : 'v1-rejectChildcareApplication';
      await childcareCallable(name)({ jobId, caregiverId: application.caregiverId });
      setNotice(decision === 'accept'
        ? 'Application accepted — you can now request a booking with this caregiver.'
        : 'Application declined.');
      void loadApplications();
    } catch (err) {
      const code = callableErrorCode(err);
      if (code === 'childcare_disabled') setError('Childcare features are not available right now.');
      else if (code === 'provider_not_eligible') setError('This caregiver is not currently eligible for childcare, so the application cannot be accepted. Choose another applicant.');
      else if (code === 'application_not_pending') setError('This application was already decided — refresh to see the latest state.');
      else if (code === 'recent_auth_required') setError('Please sign in again to decide on applications (security check).');
      else setError('Could not save your decision. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex justify-center py-24" role="status" aria-label="Loading applicants">
          <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-2">
          <h1 className="text-xl font-semibold text-slate-900">Childcare is coming soon</h1>
          <p className="text-slate-500 text-sm">Childcare features are not available in your area yet.</p>
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4" role="alert">
          <p className="text-slate-600 text-sm">We could not load this job&apos;s applicants.</p>
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

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <button
          type="button"
          onClick={() => navigate('/childcare')}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Back to childcare
        </button>

        <header>
          <h1 className="text-2xl font-bold text-slate-900">{job?.title || 'Childcare job'}</h1>
          {job && (
            <p className="text-sm text-slate-500 mt-1">
              {(job.ageBands ?? []).map(ageBandLabel).join(', ')}
              {(job.serviceCategories ?? []).length > 0 && (
                <> · {(job.serviceCategories ?? []).map(categoryLabel).join(', ')}</>
              )}
              {job.status ? ` · ${categoryLabel(String(job.status))}` : ''}
            </p>
          )}
          {!job && (
            <p className="text-sm text-slate-500 mt-1">
              This job was not found in your childcare jobs — it may have been closed or belongs to another account.
            </p>
          )}
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

        {applicationsError ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3" role="alert">
            <p className="text-sm text-amber-800">
              The applicant list could not be loaded right now. Applications are safe — this view just failed to refresh.
            </p>
            <button
              type="button"
              onClick={() => void loadApplications()}
              className="px-4 py-2 rounded-full border border-amber-300 text-amber-800 text-sm font-semibold flex-shrink-0 hover:bg-amber-100"
            >
              Retry
            </button>
          </div>
        ) : applications === null ? (
          <div className="flex justify-center py-8" role="status" aria-label="Loading applications">
            <Loader2 className="w-5 h-5 animate-spin text-primary-500" />
          </div>
        ) : applications.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
            <p className="text-sm font-medium text-slate-700">No applicants yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Eligible caregivers near you have been notified. You&apos;ll see applications here as they come in.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {applications.map((application) => {
              const profile = (application.caregiverId && profiles[application.caregiverId]) || {};
              const photo = profile.photo || profile.imageUrl;
              const pending = application.status === 'pending';
              return (
                <div key={application.applicationId} className="bg-white border border-slate-200 rounded-2xl p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center text-slate-500 font-bold flex-shrink-0">
                      {photo
                        ? <img src={photo} alt={profile.name || 'Caregiver'} className="w-full h-full object-cover" />
                        : (profile.name || 'C').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-slate-900 truncate">{profile.name || 'Caregiver'}</p>
                      <p className="text-xs text-slate-500">
                        {[profile.city, profile.state].filter(Boolean).join(', ') || 'Nearby'}
                        {application.status && application.status !== 'pending'
                          ? ` · ${categoryLabel(String(application.status))}`
                          : ''}
                      </p>
                      <CaregiverVerificationBadges
                        verified={profile.verified}
                        backgroundCheckStatus={profile.backgroundCheckStatus}
                        childcareEvidenceLabels={profile.childcareEvidenceLabels}
                        className="mt-1.5"
                      />
                      {profile.childcareReputation && (profile.childcareReputation.ratingCount ?? 0) > 0 && (
                        <p className="text-xs text-slate-500 mt-1">
                          Childcare rating {Number(profile.childcareReputation.ratingAvg ?? 0).toFixed(1)} (
                          {profile.childcareReputation.ratingCount} childcare review
                          {profile.childcareReputation.ratingCount === 1 ? '' : 's'})
                        </p>
                      )}
                    </div>
                    {pending && (
                      <div className="flex flex-col sm:flex-row gap-2 flex-shrink-0">
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void decide(application, 'accept')}
                          aria-label={`Accept application from ${profile.name || 'caregiver'}`}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold disabled:opacity-40"
                        >
                          {busyId === application.applicationId
                            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                            : <UserCheck className="w-4 h-4" aria-hidden="true" />} Accept
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void decide(application, 'reject')}
                          aria-label={`Decline application from ${profile.name || 'caregiver'}`}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
                        >
                          <UserX className="w-4 h-4" aria-hidden="true" /> Decline
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default ChildcareMatches;
