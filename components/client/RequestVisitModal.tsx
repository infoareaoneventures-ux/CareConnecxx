// Request Visit — the ONE "+ Request Visit" modal (2026-10-07), lifted out of
// components/Schedule.tsx so My Calendar and My Bookings open the same form and
// make the same booking_amendments write (type add_recurring_days, the caregiver
// accepts). Reads/writes go through services/visitRequestService.ts. Evia's twin
// is functions/src/agents/visitRequestFlow.ts + visitRequest.ts, which port this
// file step for step — change both together.
//
// Who can be asked: accepted booking_requests that still have at least one
// scheduled shift (fetchRequestVisitTargets) — the Calendar's header button and
// the My Bookings card button both read this list, so a card shows the button
// exactly when the modal can preselect that booking.
import { useState, useEffect } from 'react';
import { auth } from '../../lib/firebase';
import { useCareConnex } from '../../context/CareConnexContext';
import { availabilityService } from '../../services/availabilityService';
import { fetchRequestVisitAvailability, sendVisitRequest, type RequestVisitTargets } from '../../services/visitRequestService';
import type { useAccessGates } from '../../hooks/useAccessGates';

export { fetchRequestVisitTargets, type RequestVisitTargets, type RequestVisitBooking } from '../../services/visitRequestService';

interface RequestVisitModalProps {
  targets: RequestVisitTargets;
  /** Opened from a booking card: that caregiver and booking are already selected. */
  preselect?: { caregiverId: string; bookingId?: string };
  gate: ReturnType<typeof useAccessGates>['gate'];
  onClose: () => void;
  /** After the request is written (the Calendar reloads its shifts). */
  onSent?: () => void;
}

export function RequestVisitModal({ targets, preselect, gate, onClose, onSent }: RequestVisitModalProps) {
  const { addToast } = useCareConnex();
  const { caregivers, caregiverBookings } = targets;
  const [visitCaregiverId,   setVisitCaregiverId]   = useState(preselect?.caregiverId ?? '');
  const [visitBookingId,     setVisitBookingId]     = useState(preselect?.bookingId ?? '');
  const [selectedDays,       setSelectedDays]       = useState<string[]>([]);
  const [dayTimes,           setDayTimes]           = useState<Record<string, Array<{ start: string; end: string }>>>({});
  const [visitNotes,         setVisitNotes]         = useState('');
  const [visitStartDate,     setVisitStartDate]     = useState('');
  // A request here is a visit outside the regular schedule, so it starts as a one-off (end date = start date), not ongoing.
  const [visitEndOption,     setVisitEndOption]     = useState<'ongoing' | 'end_date'>('end_date');
  const [visitEndDate,       setVisitEndDate]       = useState('');
  // Day-of-week → time blocks from actual scheduled shifts for the selected caregiver
  const [cgShiftBlocks, setCgShiftBlocks] = useState<Record<string, Array<{ start: string; end: string }>>>({});
  const [cgWeeklyAvail, setCgWeeklyAvail] = useState<Record<string, any[]>>({});
  const [cgBookedSlots, setCgBookedSlots] = useState<Record<string, Array<{s:number;e:number}>>>({});

  // When the caregiver selection changes, load the modal's availability picture:
  // their weekly availability, every slot they're booked (any client), and their
  // upcoming scheduled shifts with this family as day-of-week → blocks.
  useEffect(() => {
    const user = auth?.currentUser;
    if (!visitCaregiverId || !user) {
      setCgShiftBlocks({});
      setCgWeeklyAvail({});
      setCgBookedSlots({});
      return;
    }
    let live = true;
    fetchRequestVisitAvailability(user.uid, visitCaregiverId).then(a => {
      if (!live) return;
      setCgWeeklyAvail(a.weeklyAvailability);
      setCgBookedSlots(a.bookedSlots);
      setCgShiftBlocks(a.shiftBlocks);
    }).catch(() => { if (live) setCgShiftBlocks({}); });
    return () => { live = false; };
  }, [visitCaregiverId]);

  const handleAddShift = async () => {
    const cgName = caregivers.find(c => c.id === visitCaregiverId)?.name;
    gate('booking', cgName, async () => {
    try {
      const user = auth?.currentUser;
      if (!user) return;
      const cg = caregivers.find(c => c.id === visitCaregiverId);

      // Build newDays from selectedDays + dayTimes (each day can have multiple blocks)
      const newDays: Record<string, Array<{ start: string; end: string }>> = {};
      for (const day of selectedDays) {
        const blocks = dayTimes[day] || [];
        const validBlocks = blocks.filter(b => b.start && b.end).map(b => ({
          start: b.start.startsWith('~') ? b.start.slice(1) : b.start,
          end: b.end === '~00:00' ? '00:00' : (b.end.startsWith('~') ? b.end.slice(1) : b.end),
        }));
        if (validBlocks.length === 0) continue;
        newDays[day] = validBlocks;
      }

      const _td2 = new Date();
      const todayStr = `${_td2.getFullYear()}-${String(_td2.getMonth()+1).padStart(2,'0')}-${String(_td2.getDate()).padStart(2,'0')}`;
      const isOngoing = visitEndOption === 'ongoing';

      await sendVisitRequest({
        bookingRequestId: visitBookingId || null,
        clientId: user.uid,
        clientName: user.displayName || '',
        caregiverId: visitCaregiverId,
        caregiverName: cg?.name || 'Unknown',
        newDays,
        notes: visitNotes,
        startDate: visitStartDate || todayStr,
        endDate: isOngoing ? null : (visitEndDate || null),
        ongoing: isOngoing,
      });

      // Notification handled by onBookingAmendmentWrite Cloud Function

      onClose();
      addToast('Visit request sent — waiting for care provider to accept.', 'success');
      onSent?.();
    } catch (e) {
      console.error(e);
      addToast('Failed to send request. Please try again.', 'error');
    }
    }); // end gate callback
  };

  return (() => {
        const selectedCg = caregivers.find(c => c.id === visitCaregiverId);
        const selectedBooking = visitBookingId
          ? (caregiverBookings[visitCaregiverId] || []).find(b => b.bookingId === visitBookingId)
          : null;
        const schedule: Record<string, Array<{ start: string; end: string }>> = selectedBooking?.schedule || {};
        const DAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const VISIT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        // ── Availability helpers ──────────────────────────────────────────
        const DAY_NAME_TO_IDX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const getNextDateForDay = (dayName: string, fromDateStr: string): Date | null => {
          if (!fromDateStr) return null;
          const fromDate = new Date(fromDateStr + 'T12:00:00');
          const targetDow = DAY_NAME_TO_IDX[dayName];
          if (targetDow === undefined) return null;
          const diff = (targetDow - fromDate.getDay() + 7) % 7;
          const result = new Date(fromDate);
          result.setDate(result.getDate() + diff);
          return result;
        };

        // Days whose requested times fall outside the caregiver's weekly availability
        const weeklyUnavailableDays: string[] = selectedCg ? selectedDays.filter(day => {
          const blocks = dayTimes[day] || [];
          return blocks.some(b => {
            if (!b.start || !b.end) return false;
            const checkDate = getNextDateForDay(day, visitStartDate);
            if (!checkDate) return false;
            const [sh, sm] = b.start.split(':').map(Number);
            const end = b.end === '~00:00' ? '00:00' : (b.end.startsWith('~') ? b.end.slice(1) : b.end);
            const [eh, em] = end.split(':').map(Number);
            const durationHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
            if (durationHours <= 0) return false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return !availabilityService.checkWeeklyAvailability(selectedCg as any, checkDate, b.start, durationHours);
          });
        }) : [];
        const scheduledDays = DAY_ORDER.filter(d => schedule[d]?.some(b => b.start && b.end));
        // Merge regular schedule blocks + actual shift blocks for overlap checking
        const allBlocksForDay = (day: string) => {
          const schedBlocks = (schedule[day] || []).filter(b => b.start && b.end);
          const shiftBlocks = (cgShiftBlocks[day] || []).filter(b => b.start && b.end);
          // Deduplicate
          const seen = new Set<string>();
          return [...schedBlocks, ...shiftBlocks].filter(b => {
            const key = `${b.start}-${b.end}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };

        // Check if a proposed [newStart, newEnd) overlaps any existing block for that day
        const hasOverlap = (day: string, newStart: string, newEnd: string) => {
          const [nsh, nsm] = newStart.split(':').map(Number);
          const [neh, nem] = newEnd.split(':').map(Number);
          const ns = nsh * 60 + nsm, ne = neh * 60 + nem;
          return allBlocksForDay(day).some(b => {
            const [bsh, bsm] = b.start.split(':').map(Number);
            const [beh, bem] = b.end.split(':').map(Number);
            const bs = bsh * 60 + bsm, be = beh * 60 + bem;
            return ns < be && ne > bs;
          });
        };

        const overlappingDays = selectedDays.filter(day => {
          const blocks = dayTimes[day] || [];
          return blocks.some(b => b.start && b.end && hasOverlap(day, b.start.startsWith('~') ? b.start.slice(1) : b.start, b.end === '~00:00' ? '00:00' : (b.end.startsWith('~') ? b.end.slice(1) : b.end)));
        });

        const canSubmit =
          !!visitCaregiverId &&
          !!visitBookingId &&
          selectedDays.length > 0 &&
          selectedDays.every(day => (dayTimes[day] || []).some(b => b.start && b.end)) &&
          !!visitStartDate &&
          (visitEndOption === 'ongoing' || !!visitEndDate) &&
          overlappingDays.length === 0 &&
          weeklyUnavailableDays.length === 0;

        // ── Availability helpers (same as booking modal) ──────────────────────
        const ABBR_TO_FULL: Record<string,string> = { Sun:'sunday', Mon:'monday', Tue:'tuesday', Wed:'wednesday', Thu:'thursday', Fri:'friday', Sat:'saturday' };
        const BLOCK_MINS: Record<string, {s:number;e:number}> = { morning:{s:360,e:720}, afternoon:{s:720,e:1080}, evening:{s:1080,e:1380}, overnight:{s:1380,e:360} };
        const TIME_OPTS = Array.from({ length: 96 }, (_, i) => { const h = Math.floor(i / 4), m = (i % 4) * 15; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; });
        const toMin = (t: string) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
        const stripNextDay = (t: string) => t.startsWith('~') ? t.slice(1) : t;
        const blockEndMin = (end: string) => end === '~00:00' ? 1440 : toMin(stripNextDay(end));
        const fmtTimeOpt = (t: string) => {
          if (!t) return '';
          const raw = t.startsWith('~') ? t.slice(1) : t;
          const [hh, mm] = raw.split(':').map(Number);
          const ap = hh < 12 ? 'AM' : 'PM';
          const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
          return `${h12}:${String(mm).padStart(2,'0')} ${ap}`;
        };
        const hasWeeklyAvail = Object.keys(cgWeeklyAvail).length > 0;
        const hasShiftBlocks = Object.keys(cgShiftBlocks).length > 0;
        const hasCgAvail = hasWeeklyAvail || hasShiftBlocks;
        const getDaySlots = (abbr: string): Array<{s:number;e:number}> => {
          // Prefer caregiver's self-reported weeklyAvailability; fall back to their existing shift schedule
          if (hasWeeklyAvail) {
            const full = ABBR_TO_FULL[abbr] || abbr.toLowerCase();
            const raw: any[] = cgWeeklyAvail[full] || [];
            const result: {s:number;e:number}[] = [];
            for (const sl of raw) {
              let s: number, e: number;
              if (typeof sl === 'string') {
                const bm = BLOCK_MINS[sl]; if (!bm) continue;
                s = bm.s; e = bm.e;
              } else {
                if (!sl?.start) continue;
                s = toMin(sl.start); e = toMin(sl.end);
              }
              if (e > 0 && e <= s) {
                result.push({s, e: 1440});
                result.push({s: 0, e});
              } else {
                result.push({s, e: e > 0 ? e : 1440});
              }
            }
            return result;
          }
          // Fall back to cgShiftBlocks (the caregiver's regular recurring schedule with this client)
          return (cgShiftBlocks[abbr] || []).map(b => ({ s: toMin(b.start), e: toMin(b.end) }));
        };
        const isDayAvailable = (abbr: string) => !hasCgAvail || getDaySlots(abbr).length > 0;
        const availTimeOpts = (abbr: string, extraBusy: Array<{s:number;e:number}> = []) => {
          const allBusy = [...(cgBookedSlots[abbr] || []), ...extraBusy];
          return TIME_OPTS.filter(t => !allBusy.some(b => toMin(t) >= b.s && toMin(t) < b.e));
        };
        const availEndOpts = (abbr: string, startT: string, extraBusy: Array<{s:number;e:number}> = []) => {
          const startM = startT ? toMin(startT) : 0;
          const allBusy = [...(cgBookedSlots[abbr] || []), ...extraBusy];
          const sameDayOpts = TIME_OPTS.filter(t => {
            if (startT && t <= startT) return false;
            const eM = toMin(t);
            if (allBusy.some(b => b.s < eM && b.e > startM)) return false;
            return true;
          });
          const nextDayOpts = allBusy.some(b => b.s < 1440 && b.e > startM) ? [] : ['~00:00'];
          return [...sameDayOpts, ...nextDayOpts];
        };
        const otherBlocksBusy = (abbr: string, excludeIdx: number): Array<{s:number;e:number}> =>
          (dayTimes[abbr] || [])
            .filter((b, i) => i !== excludeIdx && b.start && b.end)
            .map(b => ({ s: toMin(stripNextDay(b.start)), e: blockEndMin(b.end) }));
        const isBlockOutsidePreferred = (abbr: string, start: string, end: string) => {
          if (!hasCgAvail) return false;
          const slots = getDaySlots(abbr);
          if (slots.length === 0) return true; // day not in preferred schedule at all
          const inSlot = (m: number) => slots.some(sl => m >= sl.s && m <= sl.e);
          if (start && !inSlot(toMin(start))) return true;
          if (end && !inSlot(end === '~00:00' ? 1440 : toMin(stripNextDay(end)))) return true;
          return false;
        };
        const calcDayHours = (blocks: Array<{start:string;end:string}>) =>
          blocks.filter(b => b.start && b.end).reduce((sum, b) => {
            const s = toMin(stripNextDay(b.start));
            const e = blockEndMin(b.end);
            return sum + Math.max(0, e - s) / 60;
          }, 0);
        const fmtHours = (h: number) => h === 0 ? '' : `${h % 1 === 0 ? h : h.toFixed(2)}h`;
        const mergeIvs = (ivs: Array<{s:number;e:number}>) => {
          if (!ivs.length) return [];
          const sorted = [...ivs].sort((a,b) => a.s - b.s);
          const out = [{ ...sorted[0] }];
          for (let i = 1; i < sorted.length; i++) {
            const last = out[out.length - 1];
            if (sorted[i].s <= last.e) last.e = Math.max(last.e, sorted[i].e);
            else out.push({ ...sorted[i] });
          }
          return out;
        };
        const fmtM = (m: number) => {
          const h = Math.floor(m / 60) % 24;
          const mn = m % 60;
          const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
          const p = h >= 12 ? 'pm' : 'am';
          return mn === 0 ? `${dh}${p}` : `${dh}:${String(mn).padStart(2,'0')}${p}`;
        };
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col">

              {/* Header */}
              <div className="px-6 pt-6 pb-4 border-b border-slate-100 shrink-0">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">Request Visit</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Add a visit outside your regular schedule</p>
                  </div>
                  <button onClick={onClose}
                    className="text-slate-400 hover:text-slate-600 p-1 -mr-1 -mt-1 text-xl font-bold leading-none">×</button>
                </div>
              </div>

              {/* Scrollable body */}
              <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">

                {/* Caregiver */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Care Provider</label>
                  <select value={visitCaregiverId} onChange={e => { setVisitCaregiverId(e.target.value); setVisitBookingId(''); }}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white">
                    <option value="">Select care provider</option>
                    {caregivers.map(cg => <option key={cg.id} value={cg.id}>{cg.name}</option>)}
                  </select>
                </div>

                {/* Booking — only shown once a caregiver is selected */}
                {visitCaregiverId && (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Booking</label>
                    <select value={visitBookingId} onChange={e => setVisitBookingId(e.target.value)}
                      className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white">
                      <option value="">Select booking</option>
                      {(caregiverBookings[visitCaregiverId] || []).map(b => (
                        <option key={b.bookingId} value={b.bookingId}>{b.jobTitle}</option>
                      ))}
                    </select>
                  </div>
                )}

                {visitCaregiverId && visitBookingId && <>

                {/* Schedule dates */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Schedule</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Start date</label>
                      <input
                        type="date"
                        value={visitStartDate}
                        onChange={e => {
                          // Kept as typed. (It used to snap to today on every change, so typing "15" turned into today's
                          // date the moment "1" made the day "01" — found in the 2026-11-14 live test.) The min is
                          // applied when the field is left; a one-off visit's end date follows its start date.
                          const v = e.target.value;
                          setVisitStartDate(v);
                          if (v && visitEndOption === 'end_date' && (!visitEndDate || visitEndDate < v)) setVisitEndDate(v);
                        }}
                        onBlur={() => { const _n = new Date(); const _min = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`; if (visitStartDate && visitStartDate < _min) setVisitStartDate(_min); }}
                        min={(() => { const _n = new Date(); return `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`; })()}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">End date</label>
                      <input
                        type="date"
                        value={visitEndDate}
                        onChange={e => {
                          setVisitEndDate(e.target.value);
                          if (e.target.value) setVisitEndOption('end_date');
                        }}
                        min={visitStartDate || (() => { const _n = new Date(); return `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`; })()}
                        disabled={visitEndOption === 'ongoing'}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 bg-white disabled:bg-slate-50 disabled:text-slate-400"
                      />
                      <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={visitEndOption === 'ongoing'}
                          onChange={e => {
                            setVisitEndOption(e.target.checked ? 'ongoing' : 'end_date');
                            if (e.target.checked) setVisitEndDate('');
                            else if (visitStartDate && !visitEndDate) setVisitEndDate(visitStartDate);
                          }}
                          className="w-3.5 h-3.5 accent-primary-600"
                        />
                        <span className="text-xs text-slate-500">Ongoing</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Shift times per day */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Shift times per day</p>

                  {selectedDays.length === 0 ? (
                    <p className="text-xs text-slate-400 italic mb-2">No days added yet.</p>
                  ) : (
                    <div className="space-y-2 mb-3">
                      {selectedDays.map(day => {
                        const blocks = dayTimes[day] || [];
                        return (
                          <div key={day} className="space-y-1">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                                <span>{day}</span>
                                {fmtHours(calcDayHours(blocks)) && <span className="text-primary-600">{fmtHours(calcDayHours(blocks))}</span>}
                                {overlappingDays.includes(day) && (
                                  <span className="text-[10px] font-semibold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full flex items-center gap-0.5"><span>⚠</span> Overlaps existing shift</span>
                                )}
                                {!overlappingDays.includes(day) && !isDayAvailable(day) && (
                                  <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-full">Outside available hours</span>
                                )}
                              </div>
                              <button type="button" onClick={() => { setSelectedDays(prev => prev.filter(d => d !== day)); setDayTimes(prev => { const next = { ...prev }; delete next[day]; return next; }); }} className="text-xs text-slate-400 hover:text-red-500 transition-colors">Remove</button>
                            </div>
                            <div className="space-y-1.5">
                              {blocks.map((block, bi) => (
                                <div key={bi} className="flex flex-col gap-1">
                                  {isDayAvailable(day) && isBlockOutsidePreferred(day, stripNextDay(block.start), block.end) && (
                                    <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-full self-start">Outside available hours</span>
                                  )}
                                  <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                                    <select value={stripNextDay(block.start)}
                                      onChange={e => { const nb = [...blocks]; nb[bi] = { ...block, start: e.target.value }; setDayTimes(prev => ({ ...prev, [day]: nb })); }}
                                      className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white">
                                      <option value="">Start</option>
                                      {availTimeOpts(day, otherBlocksBusy(day, bi)).map(t => <option key={t} value={t}>{fmtTimeOpt(t)}</option>)}
                                    </select>
                                    <span className="text-xs text-slate-400 shrink-0">to</span>
                                    <select value={block.end}
                                      onChange={e => { const nb = [...blocks]; nb[bi] = { ...block, end: e.target.value }; setDayTimes(prev => ({ ...prev, [day]: nb })); }}
                                      className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white">
                                      <option value="">End</option>
                                      {availEndOpts(day, stripNextDay(block.start), otherBlocksBusy(day, bi)).map(t => <option key={t} value={t}>{fmtTimeOpt(t)}</option>)}
                                    </select>
                                    {blocks.length > 1 && (
                                      <button type="button" onClick={() => { const nb = blocks.filter((_, i) => i !== bi); setDayTimes(prev => ({ ...prev, [day]: nb })); }} className="text-slate-300 hover:text-red-400 transition-colors ml-1 shrink-0">✕</button>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {blocks.every(b => b.start && b.end) && availTimeOpts(day, blocks.filter(b => b.start && b.end).map(b => ({ s: toMin(stripNextDay(b.start)), e: blockEndMin(b.end) }))).length > 0 && (
                                <button type="button" onClick={() => setDayTimes(prev => ({ ...prev, [day]: [...blocks, { start: '', end: '' }] }))} className="text-xs text-primary-600 hover:text-primary-800 font-medium mt-1 self-start">
                                  + Add time
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Add a day pills */}
                  {VISIT_DAYS.some(d => !selectedDays.includes(d)) && (
                    <div className="flex flex-nowrap gap-1">
                      {VISIT_DAYS.filter(d => !selectedDays.includes(d)).map(day => {
                        const isUnavail = !isDayAvailable(day);
                        const dayBookings = (cgBookedSlots[day] || []).sort((a, b) => a.s - b.s);
                        // Split bookings: client's own schedule vs other clients
                        const mySlots = (cgShiftBlocks[day] || []).map(b => ({ s: toMin(b.start), e: toMin(b.end) }));
                        const isMySlot = (b: {s:number;e:number}) => mySlots.some(m => m.s === b.s && m.e === b.e);
                        const scheduledStr = mergeIvs(dayBookings.filter(isMySlot)).map(b => `${fmtM(b.s)}–${fmtM(b.e)}`).join(', ');
                        const busyStr = mergeIvs(dayBookings.filter(b => !isMySlot(b))).map(b => `${fmtM(b.s)}–${fmtM(b.e)}`).join(', ');
                        const slots = hasCgAvail ? getDaySlots(day).filter(sl => sl.s < 1440) : [];
                        const freeIntervals = slots.flatMap(sl => {
                          const slE = sl.e || 1440;
                          let free = [{ s: sl.s, e: slE }];
                          for (const bk of dayBookings.filter(b => b.s < slE && b.e > sl.s)) {
                            free = free.flatMap(iv => {
                              if (bk.e <= iv.s || bk.s >= iv.e) return [iv];
                              const parts: Array<{s:number;e:number}> = [];
                              if (bk.s > iv.s) parts.push({ s: iv.s, e: bk.s });
                              if (bk.e < iv.e) parts.push({ s: bk.e, e: iv.e });
                              return parts;
                            });
                          }
                          return free.filter(iv => iv.e > iv.s);
                        });
                        const freeStr = mergeIvs(freeIntervals).map(iv => `${fmtM(iv.s)}–${fmtM(iv.e)}`).join(', ');
                        const fullyBooked = slots.length > 0 && freeIntervals.length === 0;
                        const isUnavailable = isUnavail || fullyBooked;
                        const hasTooltip = slots.length > 0 || isUnavail || busyStr.length > 0 || scheduledStr.length > 0;
                        return (
                          <div key={day} className="relative group">
                            <button type="button"
                              onClick={() => { setSelectedDays(prev => [...prev, day]); setDayTimes(prev => ({ ...prev, [day]: [{ start: '', end: '' }] })); }}
                              className={`text-xs font-semibold px-2 py-1 rounded-full border transition-colors ${isUnavailable ? 'border-orange-200 bg-orange-50 text-orange-600 hover:bg-orange-100 hover:border-orange-300' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-primary-50 hover:border-primary-300 hover:text-primary-700'}`}>
                              + {day}
                            </button>
                            {hasTooltip && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 pointer-events-none hidden group-hover:block">
                                <div className="bg-slate-800 text-white rounded-lg px-3 py-2 shadow-xl text-[11px] whitespace-nowrap">
                                  {fullyBooked && <div className="text-orange-300 font-medium">Not available — fully booked</div>}
                                  {!fullyBooked && !isUnavail && freeStr && <div className="text-emerald-300 font-medium">Available: {freeStr}</div>}
                                  {isUnavail && <div className="text-orange-300">Outside available hours</div>}
                                  {scheduledStr && <div className="text-blue-300 font-medium">Scheduled: {scheduledStr}</div>}
                                  {busyStr && <div className="text-orange-300 font-medium">Busy: {busyStr}</div>}
                                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Notes (optional)</label>
                  <textarea value={visitNotes} onChange={e => setVisitNotes(e.target.value)}
                    placeholder="Any special instructions…"
                    rows={2}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 resize-none" />
                </div>

                </>}
              </div>

              {/* Footer */}
              <div className="px-6 pb-6 pt-4 border-t border-slate-100 shrink-0">
<div className="flex gap-3">
                  <button onClick={onClose}
                    className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                    Cancel
                  </button>
                  <button onClick={handleAddShift} disabled={!canSubmit}
                    className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    Send Request
                  </button>
                </div>
                <p className="text-xs text-slate-400 text-center mt-2">
                  Your care provider will need to accept before these visits are added to the schedule.
                </p>
              </div>

            </div>
          </div>
        );
  })();
}
