import React from 'react';
import { Calendar } from 'lucide-react';
import type { Caregiver, WeeklySchedule } from '../../types';

interface LookingForSectionProps {
  profile: Partial<Caregiver>;
}

const DAYS: Array<keyof WeeklySchedule> = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const PERIOD_LABELS = ['AM', 'Mid', 'PM'];

function hasSlotInPeriod(slots: any[] | undefined, period: 'AM' | 'Mid' | 'PM'): boolean {
  if (!slots || slots.length === 0) return false;
  return slots.some((slot: any) => {
    const start = String(slot.start || slot || '').toLowerCase();
    if (period === 'AM') return start.includes('morning') || /0?[6-9]|10|11/.test(start);
    if (period === 'Mid') return start.includes('afternoon') || /12|1[3-6]/.test(start);
    return start.includes('evening') || /1[7-9]|2[0-3]/.test(start);
  });
}

export const LookingForSection: React.FC<LookingForSectionProps> = ({ profile }) => {
  const jobTypes: string[] = (profile.jobTypes as string[]) || [];
  const occasional = jobTypes.includes('occasional');
  const partTime = jobTypes.includes('part-time') || jobTypes.includes('full-time');

  const weekly: any = profile.weeklyAvailability || {};

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <h3 className="font-bold text-slate-900 mb-4">Looking for...</h3>
      <div className="grid md:grid-cols-[1fr_auto] gap-6 items-center">
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${occasional ? 'bg-primary-500' : 'bg-slate-300'}`} />
            <span className={occasional ? 'text-slate-900 font-medium' : 'text-slate-400'}>Occasional jobs</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${partTime ? 'bg-primary-500' : 'bg-slate-300'}`} />
            <span className={partTime ? 'text-slate-900 font-medium' : 'text-slate-400'}>Part-time &amp; Full-time jobs</span>
          </div>
          <a
            href="/caregiver/calendar"
            className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-semibold mt-2"
          >
            <Calendar className="w-3.5 h-3.5" /> See occasional calendar
          </a>
        </div>

        {/* Availability mini-grid (3 periods × 7 days) */}
        <div>
          <div className="grid grid-cols-[auto_repeat(7,1fr)] gap-1 text-[10px] text-slate-500">
            <span />
            {DAY_LABELS.map((d, i) => (
              <span key={i} className="text-center">{d}</span>
            ))}
            {PERIOD_LABELS.map(period => (
              <React.Fragment key={period}>
                <span className="text-right pr-1">{period}</span>
                {DAYS.map(day => (
                  <span
                    key={`${day}-${period}`}
                    className={`h-5 w-5 rounded ${
                      hasSlotInPeriod(weekly[day], period as any) ? 'bg-primary-500' : 'bg-slate-200'
                    }`}
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
