// ── ChildcareBookingDetails (plan 2026-07-22-002, U11) ───────────────────────
//
// The family's view of ONE childcare booking: truthful state (AE14 — pending
// is never "confirmed"), change/cancel, payment-setup status, the family-safe
// safety-projection summary, and the review entry after completion.
//
// Callable-only (R11):
//   • booking:   v1-getChildcareBooking — DOCUMENTED U11 SEAM (not yet
//     exported by functions/src; explicit error + retry until it lands)
//   • payment:   v1-setupChildcareBookingPayment (handles the needsPayer
//     pending-payer state — a guardian without `payment` scope sees exactly
//     why the booking is waiting, AE1/AE14)
//   • change:    v1-requestChildcareBookingChange (idempotency key + schedule)
//   • cancel:    v1-cancelChildcareBooking
//   • review:    v1-submitChildcareReview (verified completion only, R44)
//
// PRIVACY (binding U11 rule): the exact address is NEVER shown here — the
// coordination view with the address is the ASSIGNED CAREGIVER surface
// (v1-getChildcareBookingCoordination). The family-side safety summary shows
// only the projection VERSION + recipient label the booking doc carries.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarCheck, ChevronLeft, CreditCard, Loader2, ShieldCheck, Star } from 'lucide-react';
import { functions } from '../../../lib/firebase';
import { childcareCallable } from '../../../lib/childcareCallable';
import { ClientNavigation } from '../ClientNavigation';
import {
  callableErrorCode,
  categoryLabel,
  isChildcareDisabledError,
  newIdempotencyKey,
  type ChildcareBookingSummary,
} from '../../shared/childcareAccess';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

const CANCELABLE = new Set(['requested', 'accepted', 'confirmed']);
const CHANGEABLE = new Set(['requested', 'accepted', 'confirmed']);
const PAYMENT_SETUP_STATES = new Set(['requested', 'accepted']);

function paymentStateCopy(state: string | undefined): string {
  switch (state) {
    case 'authorized': return 'Payment authorized — funds are set aside until care is confirmed.';
    case 'captured': return 'Payment completed.';
    case 'pending': return 'Payment setup pending.';
    case 'released': return 'Payment authorization released.';
    default: return 'Payment has not been set up yet.';
  }
}

export const ChildcareBookingDetails: React.FC = () => {
  const navigate = useNavigate();
  const { bookingId } = useParams<{ bookingId: string }>();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [booking, setBooking] = useState<ChildcareBookingSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Change-request form (single-date pilot shape).
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeDate, setChangeDate] = useState('');
  const [changeStart, setChangeStart] = useState('');
  const [changeEnd, setChangeEnd] = useState('');
  const changeKeyRef = useRef(newIdempotencyKey());

  // Review form.
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const refresh = useCallback(async () => {
    if (!functions || !bookingId) { setLoadState('error'); return; }
    try {
      // U11 seam — see module header.
      const resp = await childcareCallable('getChildcareBooking')({ bookingId });
      const data = resp.data as { booking?: ChildcareBookingSummary };
      if (!data?.booking) { setLoadState('error'); return; }
      setBooking(data.booking);
      setLoadState('ready');
    } catch (err) {
      setLoadState(isChildcareDisabledError(err) ? 'unavailable' : 'error');
    }
  }, [bookingId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const runAction = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      const code = callableErrorCode(err);
      if (code === 'childcare_disabled') setError('Childcare features are not available right now.');
      else if (code === 'booking_not_payable') setError('This booking is not awaiting payment setup — refresh to see its latest state.');
      else if (code === 'stale_state') setError('This booking changed since you loaded the page. Refresh and try again.');
      else if (code === 'recent_auth_required') setError('Please sign in again to make this change (security check).');
      else if (code === 'booking_not_completed') setError('Reviews open once the booking is completed.');
      else setError('That did not go through. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const setupPayment = () => runAction(async () => {
    const resp = await childcareCallable('setupChildcareBookingPayment')({ bookingId });
    const data = resp.data as { needsPayer?: boolean; statusDescription?: string };
    if (data?.needsPayer) {
      setNotice('You do not hold payment permission for this booking. It is now marked as waiting for an authorized payer in your household to complete payment setup.');
    } else {
      setNotice('Payment setup completed.');
    }
  });

  const cancelBooking = () => runAction(async () => {
    await childcareCallable('cancelChildcareBooking')({
      bookingId,
      idempotencyKey: `cancel:${bookingId}:${changeKeyRef.current}`,
    });
    setNotice('Booking canceled.');
  });

  const submitChange = (e: React.FormEvent) => {
    e.preventDefault();
    if (!changeDate || !changeStart || !changeEnd) {
      setError('Add the new date, start time, and end time to request a change.');
      return;
    }
    void runAction(async () => {
      await childcareCallable('requestChildcareBookingChange')({
        bookingId,
        idempotencyKey: changeKeyRef.current,
        schedule: { dates: [{ date: changeDate, startTime: changeStart, endTime: changeEnd }], recurring: null },
      });
      changeKeyRef.current = newIdempotencyKey();
      setChangeOpen(false);
      setChangeDate(''); setChangeStart(''); setChangeEnd('');
      setNotice('Change requested — the caregiver will confirm the new time.');
    });
  };

  const submitReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (rating < 1) { setError('Pick a star rating first.'); return; }
    void runAction(async () => {
      await childcareCallable('submitChildcareReview')({ bookingId, rating, comment });
      setReviewSubmitted(true);
      setNotice('Thanks — your review was submitted.');
    });
  };

  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="flex justify-center py-24" role="status" aria-label="Loading booking">
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

  if (loadState === 'error' || !booking) {
    return (
      <div className="min-h-screen bg-slate-50">
        <ClientNavigation />
        <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4" role="alert">
          <p className="text-slate-600 text-sm">
            This booking could not be loaded. It may not exist, may belong to another household, or the connection
            failed.
          </p>
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

  const paymentState = booking.paymentAuthorization?.state;
  const completed = booking.status === 'completed';
  const dates = booking.schedule?.dates ?? [];
  const recurring = booking.schedule?.recurring ?? null;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <button
          type="button"
          onClick={() => navigate('/childcare')}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Back to childcare
        </button>

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

        {/* ── Booking state ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-bold text-slate-900 truncate">
              {booking.caregiverName || 'Caregiver'}
              {booking.recipientLabel ? ` · ${booking.recipientLabel}` : ''}
            </h1>
            <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold flex-shrink-0">
              {categoryLabel(booking.status)}
            </span>
          </div>
          <p className="text-sm text-slate-600">
            {booking.statusDescription || paymentStateCopy(paymentState)}
          </p>
          <div className="text-sm text-slate-600 flex items-start gap-2">
            <CalendarCheck className="w-4 h-4 mt-0.5 text-primary-600 flex-shrink-0" aria-hidden="true" />
            <div>
              {dates.map((d) => (
                <p key={`${d.date}-${d.startTime}`}>{d.date} · {d.startTime}–{d.endTime}</p>
              ))}
              {recurring && (
                <p>{recurring.days.map(categoryLabel).join(', ')} · {recurring.startTime}–{recurring.endTime}</p>
              )}
              {dates.length === 0 && !recurring && <p>Schedule pending</p>}
            </div>
          </div>
          {typeof booking.hourlyRate === 'number' && booking.hourlyRate > 0 && (
            <p className="text-sm text-slate-600">${booking.hourlyRate}/hr</p>
          )}
        </section>

        {/* ── Payment setup ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary-600" aria-hidden="true" /> Payment
          </h2>
          <p className="text-sm text-slate-600">{paymentStateCopy(paymentState)}</p>
          {PAYMENT_SETUP_STATES.has(booking.status) && paymentState !== 'authorized' && paymentState !== 'captured' && (
            <button
              type="button"
              onClick={() => void setupPayment()}
              disabled={busy}
              className="px-4 py-2 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold disabled:opacity-40"
            >
              Set up payment
            </button>
          )}
        </section>

        {/* ── Safety projection summary (family-safe) ── */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-2">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary-600" aria-hidden="true" /> Safety details sharing
          </h2>
          {booking.safetyAccessVersion != null ? (
            <p className="text-sm text-slate-600">
              A minimum safety summary (version {booking.safetyAccessVersion}) is shared with your confirmed
              caregiver for this booking only. It is withdrawn automatically if the booking is canceled or the
              caregiver changes.
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              No safety details are shared yet — the caregiver receives the minimum safety summary once the booking
              is confirmed. Make sure each child&apos;s safety details are up to date under Childcare → Children.
            </p>
          )}
        </section>

        {/* ── Change / cancel ── */}
        {(CHANGEABLE.has(booking.status) || CANCELABLE.has(booking.status)) && (
          <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="font-semibold text-slate-900">Change or cancel</h2>
            {booking.pendingChange != null && (
              <p className="text-sm text-amber-700">
                A schedule change is waiting for the caregiver&apos;s confirmation.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {CHANGEABLE.has(booking.status) && (
                <button
                  type="button"
                  onClick={() => setChangeOpen((o) => !o)}
                  className="px-4 py-2 rounded-full border border-slate-200 text-sm font-medium text-slate-800 hover:bg-slate-50"
                >
                  Request a schedule change
                </button>
              )}
              {CANCELABLE.has(booking.status) && (
                <button
                  type="button"
                  onClick={() => void cancelBooking()}
                  disabled={busy}
                  className="px-4 py-2 rounded-full border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                >
                  Cancel booking
                </button>
              )}
            </div>
            {changeOpen && (
              <form onSubmit={submitChange} className="space-y-2 pt-2 border-t border-slate-100">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="text-xs text-slate-600">
                    New date
                    <input
                      type="date"
                      value={changeDate}
                      onChange={(e) => setChangeDate(e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    Start
                    <input
                      type="time"
                      value={changeStart}
                      onChange={(e) => setChangeStart(e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    End
                    <input
                      type="time"
                      value={changeEnd}
                      onChange={(e) => setChangeEnd(e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                    />
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-40"
                >
                  Send change request
                </button>
              </form>
            )}
          </section>
        )}

        {/* ── Review entry (verified completion only, R44) ── */}
        {completed && !reviewSubmitted && (
          <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="font-semibold text-slate-900">Leave a review</h2>
            <form onSubmit={submitReview} className="space-y-3">
              <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={`${n} star${n === 1 ? '' : 's'}`}
                    onClick={() => setRating(n)}
                    className="p-1"
                  >
                    <Star
                      className={`w-6 h-6 ${n <= rating ? 'text-accent-400' : 'text-slate-200'}`}
                      fill="currentColor"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
              <textarea
                aria-label="Review comment"
                placeholder="How did it go? (optional)"
                value={comment}
                maxLength={2000}
                onChange={(e) => setComment(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold disabled:opacity-40"
              >
                Submit review
              </button>
            </form>
          </section>
        )}
      </main>
    </div>
  );
};

export default ChildcareBookingDetails;
