import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, CalendarDays, Clock, MapPin } from 'lucide-react';
import { useCaregiverBookings } from '../../hooks/useCaregiverBookings';
import { paymentMethodLabel } from '../../types';

function fmtTime(t?: string): string {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

interface Props { caregiverId: string; pendingOnly?: boolean; }

export const CaregiverBookingsCard: React.FC<Props> = ({ caregiverId, pendingOnly = false }) => {
  const navigate = useNavigate();
  const { bookingRequests, pendingAmendments, allShifts } = useCaregiverBookings(caregiverId);
  const [bookingTab, setBookingTab] = useState<'pending' | 'upcoming'>('pending');

  const todayStr = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  })();

  const pendingBookings = bookingRequests.filter(b => b.status === 'pending');
  const upcomingShifts = allShifts
    .filter(s => s.date > todayStr && (s.status === 'scheduled' || s.status === 'in-progress'))
    .sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-primary-500" />
          <h2 className="font-semibold text-slate-900">Bookings</h2>
        </div>
      </div>

      {!pendingOnly && (
        <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
          <button
            onClick={() => setBookingTab('pending')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${bookingTab === 'pending' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <Clock className="w-3.5 h-3.5" /> Pending
          </button>
          <button
            onClick={() => setBookingTab('upcoming')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${bookingTab === 'upcoming' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <CalendarDays className="w-3.5 h-3.5" /> Upcoming
          </button>
        </div>
      )}

      {bookingTab === 'pending' && (() => {
        const totalPending = pendingBookings.length + pendingAmendments.length;
        if (totalPending === 0) return (
          <div className="text-center py-5">
            <p className="text-sm text-slate-400">No pending requests</p>
          </div>
        );
        return (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-700">Pending</p>
              <button onClick={() => navigate('/caregiver/bookings?tab=requests')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
            </div>
            <div className="space-y-3 max-h-72 overflow-y-auto">
              {pendingBookings.slice(0, 2).map((b: any) => {
                const dst = b.schedule?.dayShiftTimes;
                const schedLine = dst ? Object.entries(dst).slice(0, 2).map(([day, slots]: [string, any]) => { const slot = slots?.[0]; return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day; }).join(' · ') : null;
                return (
                  <div key={b.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                        {b.clientPhotoURL ? <img src={b.clientPhotoURL} alt={b.clientName} className="w-full h-full object-cover" /> : <span className="text-xs font-bold text-primary-600">{(b.clientName || 'F')[0].toUpperCase()}</span>}
                      </div>
                      <p className="text-sm font-semibold text-slate-900 truncate flex-1">{b.clientName || 'Family'}</p>
                      <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Awaiting response</span>
                    </div>
                    <div className="space-y-1 mb-1">
                      {b.jobTitle && <p className="text-xs text-slate-500 truncate">{b.jobTitle}</p>}
                      {schedLine && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Calendar className="w-3 h-3 flex-shrink-0" /><span className="truncate">{schedLine}</span></div>}
                      {b.address && <div className="flex items-center gap-1.5 text-xs text-slate-500"><MapPin className="w-3 h-3 flex-shrink-0" /><span className="truncate">{b.address}</span></div>}
                    </div>
                    {b.rate != null && <p className="text-sm font-bold text-primary-600">${b.rate}/hr · {paymentMethodLabel(b.paymentMethod)}</p>}
                  </div>
                );
              })}
              {pendingAmendments.slice(0, 2).map((a: any) => {
                const schedLine = a.newDays ? Object.entries(a.newDays as Record<string, Array<{ start: string; end: string }>>).slice(0, 2).map(([day, slots]) => { const slot = slots?.[0]; return slot ? `${day} ${fmtTime(slot.start)}–${fmtTime(slot.end)}` : day; }).join(' · ') : null;
                return (
                  <div key={a.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-bold text-primary-600">{(a.clientName || 'F')[0].toUpperCase()}</span>
                      </div>
                      <p className="text-sm font-semibold text-slate-900 truncate flex-1">{a.clientName || 'Family'}</p>
                      <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Awaiting response</span>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-slate-500">Schedule change request</p>
                      {schedLine && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Calendar className="w-3 h-3 flex-shrink-0" /><span className="truncate">{schedLine}{a.ongoing ? ' · Ongoing' : ''}</span></div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {bookingTab === 'upcoming' && (() => {
        // upcomingShifts (above) already excludes today via safe local-date-string
        // math — no need to recompute "tomorrow" here.
        const upcoming = upcomingShifts;
        if (upcoming.length === 0) return (
          <div className="text-center py-5">
            <p className="text-sm text-slate-400 mb-2">No upcoming shifts</p>
            <button onClick={() => navigate('/caregiver/bookings')} className="text-xs text-primary-600 font-medium hover:underline">View bookings →</button>
          </div>
        );
        return (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-700">Upcoming Shifts</p>
              <button onClick={() => navigate('/caregiver/bookings?tab=active')} className="text-xs text-primary-600 font-medium hover:underline">View all</button>
            </div>
            <div className="space-y-3 max-h-72 overflow-y-auto">
              {upcoming.slice(0, 2).map((shift: any) => {
                const parts = (shift.date || '').split('-');
                const d = parts.length === 3 ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) : null;
                return (
                  <div key={shift.id} className="border border-slate-200 rounded-xl p-3 flex items-start gap-3">
                    <div className="text-center w-10 flex-shrink-0 pt-0.5">
                      <p className="text-xl font-bold text-slate-900 leading-none">{d ? d.getDate() : '–'}</p>
                      <p className="text-xs font-semibold text-slate-400 uppercase mt-0.5">{d ? d.toLocaleDateString('en-US', { month: 'short' }) : ''}</p>
                      <p className="text-xs text-slate-400">{d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : ''}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                          {shift.clientPhotoURL ? <img src={shift.clientPhotoURL} alt={shift.clientName} className="w-full h-full object-cover" /> : <span className="text-xs font-bold text-primary-600">{(shift.clientName || 'F')[0].toUpperCase()}</span>}
                        </div>
                        <p className="text-sm font-semibold text-slate-900 truncate flex-1">{shift.clientName || 'Family'}</p>
                      </div>
                      {(shift.startTime || shift.endTime) && <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-0.5"><Clock className="w-3 h-3 flex-shrink-0" /><span>{fmtTime(shift.startTime)}{shift.endTime ? ` – ${fmtTime(shift.endTime)}` : ''}</span></div>}
                      {shift.address && <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-0.5"><MapPin className="w-3 h-3 flex-shrink-0" /><span className="truncate">{shift.address}</span></div>}
                      {shift.rate != null && <p className="text-xs font-semibold text-primary-600 mt-1">${shift.rate}/hr · {paymentMethodLabel(shift.paymentMethod)}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}
    </div>
  );
};
