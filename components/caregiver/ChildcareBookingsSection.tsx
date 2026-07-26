// ── ChildcareBookingsSection (plan 2026-07-22-002, U11) ──────────────────────
//
// ADDITIVE childcare section for CaregiverBookingsPage. Renders NOTHING when
// childcare is unavailable (flags off / not a childcare provider / probe
// failure) so the senior bookings page stays byte-identical for senior-only
// caregivers (parity pin in CaregiverBookingsPage-adjacent tests).
//
// Callable-only (R11):
//   • availability: fetchCaregiverChildcareAccess (session-cached probe)
//   • list:        v1-listMyChildcareBookings — DOCUMENTED U11 SEAM (not yet
//     exported by functions/src; explicit "can't load" + retry until it lands)
//   • accept/decline: v1-acceptChildcareBooking / v1-declineChildcareBooking
//   • check-in/out:   v1-checkInChildcareShift / v1-checkOutChildcareShift
//   • coordination:   v1-getChildcareBookingCoordination — THE only surface
//     that may show the exact address (assigned caregiver, current access
//     version); rendered clearly marked confidential (R38/AE6).
//   • safety:         v1-getChildcareBookingSafety — the minimum versioned
//     safety projection for the CURRENT booking only.

import React, { useCallback, useEffect, useState } from 'react';
import { Baby, CheckCircle, Loader2, Lock, MapPin, ShieldCheck, XCircle } from 'lucide-react';
import { auth, functions } from '../../lib/firebase';
import {
  childcareCallable,
  type ChildcareCallableWireName,
} from '../../lib/childcareCallable';
import {
  callableErrorCode,
  categoryLabel,
  fetchCaregiverChildcareAccess,
  isChildcareDisabledError,
  type ChildcareBookingSummary,
} from '../shared/childcareAccess';

type Availability = 'pending' | 'available' | 'unavailable';

interface CoordinationEntry {
  childId: string;
  addressDetail?: string | null;
  arrivalNotes?: string | null;
}

interface SafetyChildEntry {
  childId?: string;
  displayLabel?: string;
  ageBand?: string;
  emergencyContacts?: Array<{ name?: string; relationship?: string; phone?: string }>;
  healthNotes?: string | null;
  allergiesNote?: string | null;
  pickupNotes?: string | null;
}

function describeWhen(booking: ChildcareBookingSummary): string {
  const first = booking.schedule?.dates?.[0];
  if (first) return `${first.date} · ${first.startTime}–${first.endTime}`;
  const rec = booking.schedule?.recurring;
  if (rec) return `${rec.days.map(categoryLabel).join(', ')} · ${rec.startTime}–${rec.endTime}`;
  return 'Schedule pending';
}

export const ChildcareBookingsSection: React.FC = () => {
  const [availability, setAvailability] = useState<Availability>('pending');
  const [bookings, setBookings] = useState<ChildcareBookingSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [coordination, setCoordination] = useState<CoordinationEntry[] | null>(null);
  const [safetyChildren, setSafetyChildren] = useState<SafetyChildEntry[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadBookings = useCallback(async () => {
    if (!functions) { setListError(true); return; }
    setListError(false);
    try {
      // U11 seam — see module header.
      const resp = await childcareCallable('listMyChildcareBookings')({ role: 'provider' });
      setBookings(((resp.data as { bookings?: ChildcareBookingSummary[] })?.bookings) ?? []);
    } catch (err) {
      if (isChildcareDisabledError(err)) setAvailability('unavailable');
      else { setBookings(null); setListError(true); }
    }
  }, []);

  useEffect(() => {
    let active = true;
    const uid = auth?.currentUser?.uid;
    setAvailability('pending');
    setBookings(null);
    void fetchCaregiverChildcareAccess(uid).then((access) => {
      if (!active) return;
      if (access.status !== 'available') { setAvailability('unavailable'); return; }
      setAvailability('available');
      void loadBookings();
    });
    return () => { active = false; };
  }, [loadBookings, auth?.currentUser?.uid]);

  // Flags off / not a childcare provider / probe failure → render NOTHING.
  if (availability !== 'available') return null;

  const mapError = (err: unknown, fallback: string): string => {
    const code = callableErrorCode(err);
    if (code === 'childcare_disabled') return 'Childcare features are paused right now.';
    if (code === 'provider_not_eligible') return 'Your childcare eligibility lapsed — open your Childcare profile in Account Settings for exactly what to fix.';
    if (code === 'stale_state') return 'This booking changed since it was loaded — refresh the list and try again.';
    if (code === 'access_revoked' || code === 'functions/permission-denied' || code === 'permission-denied') {
      return 'Your access to this booking was withdrawn (it may have been canceled or reassigned).';
    }
    return fallback;
  };

  const act = async (
    bookingId: string,
    callable: ChildcareCallableWireName,
    success: string,
  ) => {
    if (!functions || busyId) return;
    setBusyId(bookingId);
    setError(null);
    setNotice(null);
    try {
      await childcareCallable(callable)({ bookingId });
      setNotice(success);
      void loadBookings();
    } catch (err) {
      setError(mapError(err, 'That did not go through. Please try again.'));
    } finally {
      setBusyId(null);
    }
  };

  const toggleDetail = async (bookingId: string) => {
    if (openDetail === bookingId) { setOpenDetail(null); return; }
    setOpenDetail(bookingId);
    setCoordination(null);
    setSafetyChildren(null);
    setDetailError(null);
    if (!functions) { setDetailError('Connection unavailable.'); return; }
    setDetailLoading(true);
    try {
      const [coordResp, safetyResp] = await Promise.all([
        childcareCallable('getChildcareBookingCoordination')({ bookingId }),
        childcareCallable('getChildcareBookingSafety')({ bookingId }),
      ]);
      setCoordination(((coordResp.data as { coordination?: CoordinationEntry[] })?.coordination) ?? []);
      setSafetyChildren(((safetyResp.data as { children?: SafetyChildEntry[] })?.children) ?? []);
    } catch (err) {
      setDetailError(mapError(err, 'Care details could not be loaded — they are shared only while you are the confirmed caregiver for this booking.'));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <section aria-labelledby="childcare-bookings-heading" className="mb-6" data-testid="childcare-bookings-section">
      <h2 id="childcare-bookings-heading" className="font-semibold text-slate-900 flex items-center gap-2 mb-3">
        <Baby className="w-4 h-4 text-primary-600" aria-hidden="true" /> Childcare bookings
      </h2>

      {notice && (
        <div role="status" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 mb-3">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-3">
          {error}
        </div>
      )}

      {listError ? (
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
        <div className="flex justify-center py-6" role="status" aria-label="Loading childcare bookings">
          <Loader2 className="w-5 h-5 animate-spin text-primary-500" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 text-center">
          <p className="text-sm text-slate-600">No childcare bookings yet.</p>
          <p className="text-xs text-slate-500 mt-1">Childcare booking requests from families will appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => {
            const requested = booking.status === 'requested';
            const confirmed = booking.status === 'confirmed';
            const inProgress = booking.status === 'in_progress';
            const showDetail = confirmed || inProgress;
            return (
              <div key={booking.bookingId} className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">
                      {booking.recipientLabel || 'Childcare booking'}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{describeWhen(booking)}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {categoryLabel(booking.status)}
                      {typeof booking.hourlyRate === 'number' && booking.hourlyRate > 0 ? ` · $${booking.hourlyRate}/hr` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 flex-shrink-0">
                    {requested && (
                      <>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(booking.bookingId, 'v1-acceptChildcareBooking', 'Booking accepted — it confirms once the family’s payment authorization completes.')}
                          aria-label={`Accept childcare booking ${booking.recipientLabel || booking.bookingId}`}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold disabled:opacity-40"
                        >
                          {busyId === booking.bookingId
                            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                            : <CheckCircle className="w-4 h-4" aria-hidden="true" />} Accept
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(booking.bookingId, 'v1-declineChildcareBooking', 'Booking declined.')}
                          aria-label={`Decline childcare booking ${booking.recipientLabel || booking.bookingId}`}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
                        >
                          <XCircle className="w-4 h-4" aria-hidden="true" /> Decline
                        </button>
                      </>
                    )}
                    {confirmed && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void act(booking.bookingId, 'v1-checkInChildcareShift', 'Checked in — have a great visit.')}
                        aria-label={`Check in for ${booking.recipientLabel || booking.bookingId}`}
                        className="px-4 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-40"
                      >
                        Check in
                      </button>
                    )}
                    {inProgress && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void act(booking.bookingId, 'v1-checkOutChildcareShift', 'Checked out — thanks for the visit.')}
                        aria-label={`Check out for ${booking.recipientLabel || booking.bookingId}`}
                        className="px-4 py-2 rounded-full bg-slate-900 text-white text-sm font-semibold disabled:opacity-40"
                      >
                        Check out
                      </button>
                    )}
                    {showDetail && (
                      <button
                        type="button"
                        onClick={() => void toggleDetail(booking.bookingId)}
                        aria-expanded={openDetail === booking.bookingId}
                        aria-label={`View care details for ${booking.recipientLabel || booking.bookingId}`}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50"
                      >
                        <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                        {openDetail === booking.bookingId ? 'Hide care details' : 'View care details'}
                      </button>
                    )}
                  </div>
                </div>

                {openDetail === booking.bookingId && (
                  <div className="border-t border-slate-100 pt-3 space-y-3">
                    <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-1">
                      <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                      Confidential — for this booking only. Never share or copy these details.
                    </p>
                    {detailLoading ? (
                      <div className="flex justify-center py-4" role="status" aria-label="Loading care details">
                        <Loader2 className="w-5 h-5 animate-spin text-primary-500" />
                      </div>
                    ) : detailError ? (
                      <p className="text-sm text-amber-800" role="alert">{detailError}</p>
                    ) : (
                      <>
                        {coordination && coordination.length > 0 && (
                          <div className="space-y-1">
                            {coordination.map((entry) => (
                              <div key={entry.childId} className="text-sm text-slate-700">
                                {entry.addressDetail && (
                                  <p className="flex items-start gap-1.5">
                                    <MapPin className="w-4 h-4 mt-0.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
                                    <span className="break-words">{entry.addressDetail}</span>
                                  </p>
                                )}
                                {entry.arrivalNotes && (
                                  <p className="text-xs text-slate-500 ml-5 break-words">{entry.arrivalNotes}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {safetyChildren && safetyChildren.length > 0 && (
                          <div className="space-y-2">
                            {safetyChildren.map((child, idx) => (
                              <div key={child.childId ?? idx} className="text-sm text-slate-700 border border-slate-100 rounded-xl p-3">
                                <p className="font-medium text-slate-800 truncate">
                                  {child.displayLabel || 'Child'}
                                </p>
                                {(child.emergencyContacts ?? []).map((contact, cIdx) => (
                                  <p key={cIdx} className="text-xs text-slate-600 break-words">
                                    Emergency: {contact.name}
                                    {contact.relationship ? ` (${contact.relationship})` : ''}
                                    {contact.phone ? ` · ${contact.phone}` : ''}
                                  </p>
                                ))}
                                {child.allergiesNote && (
                                  <p className="text-xs text-red-700 break-words">Allergies: {child.allergiesNote}</p>
                                )}
                                {child.healthNotes && (
                                  <p className="text-xs text-slate-600 break-words">Health: {child.healthNotes}</p>
                                )}
                                {child.pickupNotes && (
                                  <p className="text-xs text-slate-600 break-words">Pickup: {child.pickupNotes}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {coordination && coordination.length === 0 && safetyChildren && safetyChildren.length === 0 && (
                          <p className="text-sm text-slate-500">No care details have been shared for this booking yet.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default ChildcareBookingsSection;
