// ── ChildcareDashboard (plan 2026-07-22-002, U11) ────────────────────────────
//
// The family's childcare hub: children cards, active childcare jobs, upcoming
// bookings, and the action entry points (add child, post a job, authority &
// privacy). Callable-only data (R11/KTD6):
//   • v1-getMyHouseholdState + v1-listMyChildren (fresh — not the session cache)
//   • v1-listMyChildcareJobs
//   • v1-listMyChildcareBookings — DOCUMENTED U11 SEAM: not yet exported by
//     functions/src (see report); until it lands the bookings panel shows an
//     explicit "can't load" state with retry, never a silent omission.
//
// Flags-off (childcare_disabled) renders the friendly unavailable state — a
// direct URL while dark never errors (U11 test scenario). Loading, error, and
// empty states are explicit.

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Baby, Briefcase, CalendarCheck, ShieldCheck, Loader2, Plus } from 'lucide-react';
import { functions } from '../../../lib/firebase';
import { childcareCallable } from '../../../lib/childcareCallable';
import { ClientNavigation } from '../ClientNavigation';
import { ChildProfileCard } from './ChildProfileCard';
import {
  ageBandLabel,
  categoryLabel,
  isChildcareDisabledError,
  type ChildSummary,
  type ChildcareBookingSummary,
  type ChildcareJobSummary,
  type HouseholdSummary,
} from '../../shared/childcareAccess';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

function describeBookingWhen(booking: ChildcareBookingSummary): string {
  const first = booking.schedule?.dates?.[0];
  if (first) return `${first.date} · ${first.startTime}–${first.endTime}`;
  const rec = booking.schedule?.recurring;
  if (rec) return `${rec.days.map(categoryLabel).join(', ')} · ${rec.startTime}–${rec.endTime}`;
  return 'Schedule pending';
}

export const ChildcareDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [children, setChildren] = useState<ChildSummary[]>([]);
  const [households, setHouseholds] = useState<HouseholdSummary[]>([]);
  const [jobs, setJobs] = useState<ChildcareJobSummary[]>([]);
  const [bookings, setBookings] = useState<ChildcareBookingSummary[] | null>(null);
  const [bookingsError, setBookingsError] = useState(false);

  const loadBookings = useCallback(async () => {
    if (!functions) { setBookingsError(true); return; }
    setBookingsError(false);
    try {
      // U11 seam — see module header. role narrows to the family's own bookings.
      const resp = await childcareCallable('listMyChildcareBookings')({ role: 'family' });
      setBookings(((resp.data as { bookings?: ChildcareBookingSummary[] })?.bookings) ?? []);
    } catch (err) {
      if (isChildcareDisabledError(err)) setLoadState('unavailable');
      else { setBookings(null); setBookingsError(true); }
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!functions) { setLoadState('error'); return; }
    try {
      const [householdResp, childrenResp, jobsResp] = await Promise.all([
        childcareCallable('getMyHouseholdState')({}),
        childcareCallable('listMyChildren')({}),
        childcareCallable('listMyChildcareJobs')({}),
      ]);
      setHouseholds(((householdResp.data as { households?: HouseholdSummary[] })?.households) ?? []);
      setChildren(((childrenResp.data as { children?: ChildSummary[] })?.children) ?? []);
      setJobs(((jobsResp.data as { jobs?: ChildcareJobSummary[] })?.jobs) ?? []);
      setLoadState('ready');
      void loadBookings();
    } catch (err) {
      setLoadState(isChildcareDisabledError(err) ? 'unavailable' : 'error');
    }
  }, [loadBookings]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex justify-center py-24" role="status" aria-label="Loading childcare dashboard">
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
          <p className="text-slate-500 text-sm">
            Childcare features are not available in your area yet. Your senior care tools are unaffected — we will
            let you know the moment childcare opens up.
          </p>
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4" role="alert">
          <p className="text-slate-600 text-sm">We could not load your childcare dashboard. Please check your connection and try again.</p>
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

  const hasChildren = children.length > 0;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Childcare</h1>
            <p className="text-sm text-slate-500">
              Your household&apos;s childcare — profiles, jobs, and bookings in one place.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/childcare/authority')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-slate-200 bg-white text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Authority &amp; privacy
          </button>
        </header>

        {/* ── Children ── */}
        <section aria-labelledby="childcare-children-heading" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="childcare-children-heading" className="font-semibold text-slate-900 flex items-center gap-2">
              <Baby className="w-4 h-4 text-primary-600" aria-hidden="true" /> Children
            </h2>
            <button
              type="button"
              onClick={() => navigate('/childcare/children')}
              className="inline-flex items-center gap-1 text-sm font-semibold text-primary-600 hover:text-primary-700"
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> Add a child
            </button>
          </div>
          {!hasChildren ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
              <p className="text-sm text-slate-600">No child profiles yet.</p>
              <p className="text-xs text-slate-500 mt-1">
                Add a child profile first — it only takes a minute, and details stay in your secure account.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {children.map((child) => (
                <ChildProfileCard
                  key={child.childId}
                  child={child}
                  onManage={() => navigate('/childcare/children')}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Active jobs ── */}
        <section aria-labelledby="childcare-jobs-heading" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="childcare-jobs-heading" className="font-semibold text-slate-900 flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-primary-600" aria-hidden="true" /> Childcare jobs
            </h2>
            <button
              type="button"
              onClick={() => (hasChildren ? navigate('/client/post-job?vertical=child') : navigate('/childcare/children'))}
              className="inline-flex items-center gap-1 text-sm font-semibold text-primary-600 hover:text-primary-700"
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> Post a childcare job
            </button>
          </div>
          {!hasChildren && (
            <p className="text-xs text-slate-500">Add a child profile before posting a childcare job.</p>
          )}
          {jobs.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
              <p className="text-sm text-slate-600">No childcare jobs yet.</p>
              <p className="text-xs text-slate-500 mt-1">
                Post a job to reach verified caregivers — they only ever see age groups and your approximate area.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.jobId} className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">{job.title || 'Childcare'}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {(job.ageBands ?? []).map(ageBandLabel).join(', ') || 'Age groups pending'}
                      {' · '}
                      {(job.serviceCategories ?? []).map(categoryLabel).join(', ')}
                      {job.status ? ` · ${categoryLabel(String(job.status))}` : ''}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {(job.applicantCount ?? 0)} applicant{(job.applicantCount ?? 0) === 1 ? '' : 's'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/childcare/jobs/${job.jobId}/matches`)}
                    className="px-4 py-2 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold flex-shrink-0"
                  >
                    View applicants
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Upcoming bookings ── */}
        <section aria-labelledby="childcare-bookings-heading" className="space-y-3">
          <h2 id="childcare-bookings-heading" className="font-semibold text-slate-900 flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-primary-600" aria-hidden="true" /> Bookings
          </h2>
          {bookingsError ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3" role="alert">
              <p className="text-sm text-amber-800">
                Your childcare bookings could not be loaded right now — they still exist, this list just failed to
                refresh.
              </p>
              <button
                type="button"
                onClick={() => void loadBookings()}
                className="px-4 py-2 rounded-full border border-amber-300 text-amber-800 text-sm font-semibold flex-shrink-0 hover:bg-amber-100"
              >
                Retry
              </button>
            </div>
          ) : bookings === null ? (
            <div className="flex justify-center py-6" role="status" aria-label="Loading bookings">
              <Loader2 className="w-5 h-5 animate-spin text-primary-500" />
            </div>
          ) : bookings.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
              <p className="text-sm text-slate-600">No childcare bookings yet.</p>
              <p className="text-xs text-slate-500 mt-1">
                Accept an applicant on one of your jobs to request a booking.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {bookings.map((booking) => (
                <div key={booking.bookingId} className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">
                      {booking.caregiverName || 'Caregiver'}
                      {booking.recipientLabel ? ` · ${booking.recipientLabel}` : ''}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{describeBookingWhen(booking)}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{categoryLabel(booking.status)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/childcare/bookings/${booking.bookingId}`)}
                    className="px-4 py-2 rounded-full border border-slate-200 text-sm font-medium text-slate-800 hover:bg-slate-50 flex-shrink-0"
                  >
                    View booking
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {households.length === 0 && (
          <p className="text-xs text-slate-400">
            A household is created automatically when you add your first child profile.
          </p>
        )}
      </main>
    </div>
  );
};

export default ChildcareDashboard;
