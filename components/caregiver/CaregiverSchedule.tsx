import React, { useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Clock, MapPin } from 'lucide-react';
import { Appointment } from '../../types';

interface CaregiverScheduleProps {
   appointments: Appointment[];
   weeklyAvailability?: Record<string, string[]>;
}

const HOURS_START = 6;   // 6am
const HOURS_END   = 22;  // 10pm
const CELL_H      = 56;  // px per hour row
const TOTAL_H     = (HOURS_END - HOURS_START) * CELL_H;

const DAY_KEYS   = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS      = Array.from({ length: HOURS_END - HOURS_START }, (_, i) => i + HOURS_START);

const SLOT_RANGES: Record<string, { start: number; end: number }> = {
   morning:   { start: 6,  end: 12 },
   afternoon: { start: 12, end: 18 },
   evening:   { start: 18, end: 22 },
   // legacy aliases from older caregiver signups
   am:        { start: 6,  end: 12 },
   pm:        { start: 12, end: 18 },
};

function formatHourLabel(h: number): string {
   if (h === 0 || h === 24) return '12am';
   if (h === 12) return '12pm';
   return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function formatTimeRange(start: number, end: number): string {
   return `${formatHourLabel(start)} – ${formatHourLabel(end)}`;
}

// Parse "9:00 AM", "3:30 PM" etc. → fractional hour
function parseApptHour(time?: string): number {
   if (!time) return 9;
   const m = time.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
   if (!m) {
      // try 24h format like "09:00"
      const parts = time.split(':').map(Number);
      return parts[0] + (parts[1] || 0) / 60;
   }
   let h = parseInt(m[1]);
   const mins = parseInt(m[2] || '0');
   if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
   if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
   return h + mins / 60;
}

const MONTH_NAMES = [
   'January', 'February', 'March', 'April', 'May', 'June',
   'July', 'August', 'September', 'October', 'November', 'December',
];

export const CaregiverSchedule: React.FC<CaregiverScheduleProps> = ({
   appointments,
   weeklyAvailability,
}) => {
   const [view, setView]               = useState<'week' | 'month'>('week');
   const [weekOffset, setWeekOffset]   = useState(0);
   const [monthDate, setMonthDate]     = useState(new Date());
   const [selectedDay, setSelectedDay] = useState(new Date().toISOString().split('T')[0]);

   const today = new Date();

   // ── Week helpers ─────────────────────────────────────────────────────────
   const startOfWeek = new Date(today);
   startOfWeek.setDate(today.getDate() - today.getDay() + weekOffset * 7);

   const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + i);
      return d;
   });

   const relevantAppts = appointments.filter(
      a => a.status === 'confirmed' || a.status === 'completed' || a.status === 'in-progress',
   );

   const apptsByDay: Record<number, Appointment[]> = {};
   relevantAppts.forEach(appt => {
      const apptDate = new Date(appt.isoDate || appt.date);
      weekDates.forEach((wd, idx) => {
         if (
            wd.getFullYear() === apptDate.getFullYear() &&
            wd.getMonth()    === apptDate.getMonth()    &&
            wd.getDate()     === apptDate.getDate()
         ) {
            if (!apptsByDay[idx]) apptsByDay[idx] = [];
            apptsByDay[idx].push(appt);
         }
      });
   });

   const isToday = (d: Date) => d.toDateString() === today.toDateString();

   const weekLabel = (() => {
      const first = weekDates[0];
      const last  = weekDates[6];
      if (first.getMonth() === last.getMonth()) {
         return `${MONTH_NAMES[first.getMonth()]} ${first.getDate()} – ${last.getDate()}, ${first.getFullYear()}`;
      }
      return `${MONTH_NAMES[first.getMonth()]} ${first.getDate()} – ${MONTH_NAMES[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
   })();

   // ── Month helpers ─────────────────────────────────────────────────────────
   const daysInMonth    = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
   const firstDayOfWeek = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getDay();
   const monthBlanks    = Array.from({ length: firstDayOfWeek });
   const monthDays      = Array.from({ length: daysInMonth }, (_, i) => i + 1);

   const selectedDateAppts = relevantAppts.filter(a => a.isoDate === selectedDay);

   return (
      <div className="animate-slide-in">

         {/* ── Toolbar ─────────────────────────────────────────────────── */}
         <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            {/* Navigation */}
            <div className="flex items-center gap-2">
               {view === 'week' && (
                  <>
                     <button
                        onClick={() => setWeekOffset(w => w - 1)}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
                     >
                        <ChevronLeft className="w-4 h-4" />
                     </button>
                     <button
                        onClick={() => setWeekOffset(0)}
                        className="px-3 py-1.5 text-xs font-semibold bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition-colors"
                     >
                        Today
                     </button>
                     <button
                        onClick={() => setWeekOffset(w => w + 1)}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
                     >
                        <ChevronRight className="w-4 h-4" />
                     </button>
                     <span className="text-sm font-medium text-slate-600 ml-1">{weekLabel}</span>
                  </>
               )}
               {view === 'month' && (
                  <>
                     <button
                        onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
                     >
                        <ChevronLeft className="w-4 h-4" />
                     </button>
                     <span className="text-sm font-semibold text-slate-700 px-1">
                        {MONTH_NAMES[monthDate.getMonth()]} {monthDate.getFullYear()}
                     </span>
                     <button
                        onClick={() => setMonthDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
                     >
                        <ChevronRight className="w-4 h-4" />
                     </button>
                  </>
               )}
            </div>

            {/* View toggle */}
            <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
               {(['week', 'month'] as const).map(v => (
                  <button
                     key={v}
                     onClick={() => setView(v)}
                     className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors capitalize ${
                        view === v
                           ? 'bg-white shadow-sm text-slate-900'
                           : 'text-slate-500 hover:text-slate-700'
                     }`}
                  >
                     {v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
               ))}
            </div>
         </div>

         {/* ── Week view ────────────────────────────────────────────────── */}
         {view === 'week' && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
               {/* Legend */}
               <div className="flex items-center gap-5 px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5">
                     <span className="w-3 h-3 rounded-sm bg-primary-100 border border-primary-300 inline-block" />
                     Available
                  </span>
                  <span className="flex items-center gap-1.5">
                     <span className="w-3 h-3 rounded-sm bg-primary-500 inline-block" />
                     Booked
                  </span>
                  <span className="flex items-center gap-1.5">
                     <span className="w-3 h-3 rounded-sm bg-green-500 inline-block" />
                     In Progress
                  </span>
                  <span className="flex items-center gap-1.5">
                     <span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" />
                     Completed
                  </span>
               </div>

               <div className="overflow-x-auto">
                  <div style={{ minWidth: 540 }}>

                     {/* Day headers */}
                     <div
                        className="grid border-b border-slate-200 bg-slate-50 sticky top-0 z-20"
                        style={{ gridTemplateColumns: '52px repeat(7, 1fr)' }}
                     >
                        <div className="border-r border-slate-200" />
                        {weekDates.map((d, i) => (
                           <div
                              key={i}
                              className={`py-2.5 text-center border-r border-slate-200 last:border-r-0 ${
                                 isToday(d) ? 'bg-primary-50' : ''
                              }`}
                           >
                              <div className={`text-xs font-bold uppercase tracking-wide ${
                                 isToday(d) ? 'text-primary-500' : 'text-slate-500'
                              }`}>
                                 {DAY_LABELS[d.getDay()]}
                              </div>
                              <div className={`mx-auto mt-1 w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold transition-colors ${
                                 isToday(d)
                                    ? 'bg-primary-500 text-white'
                                    : 'text-slate-700'
                              }`}>
                                 {d.getDate()}
                              </div>
                           </div>
                        ))}
                     </div>

                     {/* Grid body — time gutter + 7 day columns */}
                     <div className="overflow-y-auto" style={{ maxHeight: 520 }}>
                        <div className="relative" style={{ height: TOTAL_H }}>

                           {/* Background grid lines (pointer-events-none) */}
                           <div
                              className="absolute inset-0 pointer-events-none"
                              style={{ display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)' }}
                           >
                              {/* Time gutter */}
                              <div className="border-r border-slate-200">
                                 {HOURS.map(h => (
                                    <div
                                       key={h}
                                       className="border-b border-slate-100 flex items-start justify-end pr-2"
                                       style={{ height: CELL_H, paddingTop: 4 }}
                                    >
                                       <span className="text-xs text-slate-400">{formatHourLabel(h)}</span>
                                    </div>
                                 ))}
                              </div>
                              {/* Column lines */}
                              {Array.from({ length: 7 }).map((_, ci) => (
                                 <div key={ci} className="border-r border-slate-200 last:border-r-0">
                                    {HOURS.map(h => (
                                       <div key={h} className="border-b border-slate-100" style={{ height: CELL_H }} />
                                    ))}
                                 </div>
                              ))}
                           </div>

                           {/* Content columns */}
                           <div
                              className="absolute inset-0"
                              style={{ display: 'grid', gridTemplateColumns: '52px repeat(7, 1fr)' }}
                           >
                              <div /> {/* time gutter spacer */}

                              {weekDates.map((wd, colIdx) => {
                                 const dayKey  = DAY_KEYS[wd.getDay()];
                                 const slots   = weeklyAvailability?.[dayKey] || [];
                                 const dayAppts = apptsByDay[colIdx] || [];

                                 // Merge consecutive slots into contiguous ranges
                                 const mergedRanges: Array<{ start: number; end: number; labels: string[] }> = [];
                                 slots.forEach(slot => {
                                    const range = SLOT_RANGES[slot.toLowerCase()];
                                    if (!range) return;
                                    const last = mergedRanges[mergedRanges.length - 1];
                                    if (last && last.end === range.start) {
                                       last.end = range.end;
                                       last.labels.push(slot);
                                    } else {
                                       mergedRanges.push({ ...range, labels: [slot] });
                                    }
                                 });

                                 return (
                                    <div key={colIdx} className="relative border-r border-slate-200 last:border-r-0">
                                       {/* Availability blocks */}
                                       {mergedRanges.map((r, ri) => {
                                          const clampedStart = Math.max(r.start, HOURS_START);
                                          const clampedEnd   = Math.min(r.end, HOURS_END);
                                          if (clampedEnd <= clampedStart) return null;
                                          const top    = (clampedStart - HOURS_START) * CELL_H;
                                          const height = (clampedEnd   - clampedStart) * CELL_H;
                                          return (
                                             <div
                                                key={ri}
                                                className="absolute inset-x-0.5 rounded-md bg-primary-50 border border-primary-200 overflow-hidden"
                                                style={{ top: top + 1, height: height - 2 }}
                                             >
                                                <p className="px-1.5 pt-1 text-xs font-semibold text-primary-700 leading-tight">
                                                   Available
                                                </p>
                                                <p className="px-1.5 text-xs text-primary-500 leading-tight">
                                                   {formatTimeRange(clampedStart, clampedEnd)}
                                                </p>
                                             </div>
                                          );
                                       })}

                                       {/* Appointment blocks */}
                                       {dayAppts.map((appt, ai) => {
                                          const startH       = parseApptHour(appt.time);
                                          const dur          = appt.duration || 2;
                                          const clampedStart = Math.max(startH, HOURS_START);
                                          const clampedEnd   = Math.min(startH + dur, HOURS_END);
                                          if (clampedEnd <= clampedStart) return null;
                                          const top    = (clampedStart - HOURS_START) * CELL_H;
                                          const height = (clampedEnd   - clampedStart) * CELL_H;

                                          const isCompleted = appt.status === 'completed';
                                          const isActive    = appt.status === 'in-progress';
                                          const colorCls    = isActive
                                             ? 'bg-green-500 border-green-600'
                                             : isCompleted
                                             ? 'bg-slate-400 border-slate-500'
                                             : 'bg-primary-500 border-primary-600';

                                          return (
                                             <div
                                                key={ai}
                                                className={`absolute inset-x-0.5 rounded-md border overflow-hidden z-10 ${colorCls}`}
                                                style={{ top: top + 1, height: height - 2 }}
                                             >
                                                <p className="px-1.5 pt-1 text-xs font-bold text-white leading-tight">
                                                   {isActive ? 'In Progress' : isCompleted ? 'Completed' : 'Booked'}
                                                </p>
                                                <p className="px-1.5 text-xs text-white/80 leading-tight truncate">
                                                   {appt.time}
                                                   {appt.clientName ? ` · ${appt.clientName}` : ''}
                                                </p>
                                             </div>
                                          );
                                       })}
                                    </div>
                                 );
                              })}
                           </div>

                        </div>
                     </div>
                  </div>
               </div>
            </div>
         )}

         {/* ── Month view ───────────────────────────────────────────────── */}
         {view === 'month' && (
            <div className="grid md:grid-cols-3 gap-6">
               {/* Month grid */}
               <div className="md:col-span-2 bg-white p-6 rounded-2xl border border-slate-200">
                  <div className="grid grid-cols-7 gap-1 mb-2">
                     {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                        <div key={d} className="text-center text-xs font-bold text-slate-400 py-1">{d}</div>
                     ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                     {monthBlanks.map((_, i) => <div key={`b-${i}`} className="h-10" />)}
                     {monthDays.map(d => {
                        const dateStr    = new Date(monthDate.getFullYear(), monthDate.getMonth(), d)
                           .toISOString().split('T')[0];
                        const hasAppt    = relevantAppts.some(a => a.isoDate === dateStr);
                        const isSelected = selectedDay === dateStr;
                        const isTodayDay = today.toDateString() ===
                           new Date(monthDate.getFullYear(), monthDate.getMonth(), d).toDateString();
                        return (
                           <button
                              key={d}
                              onClick={() => setSelectedDay(dateStr)}
                              className={`h-10 rounded-xl flex items-center justify-center text-sm font-medium relative transition-all ${
                                 isSelected
                                    ? 'bg-primary-500 text-white shadow-sm'
                                    : isTodayDay
                                    ? 'ring-2 ring-primary-300 text-primary-600'
                                    : 'hover:bg-slate-50 text-slate-700'
                              }`}
                           >
                              {d}
                              {hasAppt && (
                                 <span className={`absolute bottom-1 w-1.5 h-1.5 rounded-full ${
                                    isSelected ? 'bg-white' : 'bg-primary-500'
                                 }`} />
                              )}
                           </button>
                        );
                     })}
                  </div>
               </div>

               {/* Day detail */}
               <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 h-fit">
                  <h4 className="font-bold text-slate-900 mb-4 text-sm">
                     {new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-US', {
                        weekday: 'long', month: 'long', day: 'numeric',
                     })}
                  </h4>
                  {selectedDateAppts.length > 0 ? (
                     <div className="space-y-3">
                        {selectedDateAppts.map(appt => (
                           <div key={appt.id} className="bg-white p-3 rounded-xl border border-slate-100 shadow-sm">
                              <div className="flex justify-between items-start mb-1">
                                 <span className="font-bold text-slate-900 text-sm">{appt.time}</span>
                                 <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                    appt.status === 'completed'
                                       ? 'bg-slate-100 text-slate-600'
                                       : appt.status === 'in-progress'
                                       ? 'bg-green-100 text-green-700'
                                       : 'bg-primary-100 text-primary-700'
                                 }`}>
                                    {appt.status}
                                 </span>
                              </div>
                              <p className="text-sm font-medium text-slate-800">{appt.clientName}</p>
                              <div className="flex items-center gap-3 text-xs text-slate-400 mt-1.5">
                                 <span className="flex items-center gap-1">
                                    <Clock className="w-3 h-3" />{appt.duration || 2} hrs
                                 </span>
                                 <span className="flex items-center gap-1">
                                    <MapPin className="w-3 h-3" />2.5 mi
                                 </span>
                              </div>
                           </div>
                        ))}
                     </div>
                  ) : (
                     <div className="text-center py-12 text-slate-400">
                        <Calendar className="w-8 h-8 mx-auto mb-2 opacity-40" />
                        <p className="text-sm">No shifts this day</p>
                     </div>
                  )}
               </div>
            </div>
         )}
      </div>
   );
};
