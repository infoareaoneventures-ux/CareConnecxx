import React from 'react';
import { Calendar, CalendarDays, Clock, Briefcase } from 'lucide-react';
import { DayOfWeekPicker } from '../../ui/DayOfWeekPicker';
import { StepProps, TIME_OF_DAY_OPTIONS } from './types';

const todayIso = () => new Date().toISOString().split('T')[0];

const FREQUENCY_OPTIONS = [
  {
    value: 'one-time' as const,
    label: 'Specific date',
    description: 'Date night, backup care, one-time needs',
    icon: CalendarDays,
    iconBg: 'bg-violet-100',
    iconColor: 'text-violet-600',
  },
  {
    value: 'part-time' as const,
    label: 'Part-time',
    description: '25 hours or less per week',
    icon: Clock,
    iconBg: 'bg-sky-100',
    iconColor: 'text-sky-600',
  },
  {
    value: 'full-time' as const,
    label: 'Full-time',
    description: 'More than 25 hours per week',
    icon: Briefcase,
    iconBg: 'bg-teal-100',
    iconColor: 'text-teal-600',
  },
];

export const Step1Schedule: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const handleContinue = () => {
    if (!data.jobFrequency) {
      onShowToast('Choose how often you need care', 'error');
      return;
    }
    if (!data.startDate) {
      onShowToast('Please choose a start date', 'error');
      return;
    }
    if (data.startDate < todayIso()) {
      onShowToast('Start date must be today or later', 'error');
      return;
    }
    if (!data.ongoing && data.endDate && data.endDate < data.startDate) {
      onShowToast('End date must be after the start date', 'error');
      return;
    }
    if (!data.daysFlexible && data.daysOfWeek.length === 0) {
      onShowToast('Pick at least one day or mark your days as flexible', 'error');
      return;
    }
    if (data.timeOfDay.length === 0) {
      onShowToast('Choose at least one time of day', 'error');
      return;
    }
    onContinue();
  };

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">When do you need care?</h2>
      <p className="text-center text-slate-500 mb-8">Tell caregivers when the job starts and how often.</p>

      <div className="space-y-6">
        {/* Job frequency — large vertical cards */}
        <div>
          <label className="block text-base font-semibold text-slate-800 mb-3">How often do you need this care?</label>
          <div className="flex flex-col gap-3">
            {FREQUENCY_OPTIONS.map(opt => {
              const Icon = opt.icon;
              const selected = data.jobFrequency === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ jobFrequency: opt.value })}
                  className={`w-full flex items-center gap-4 px-5 py-4 rounded-2xl border-2 transition-all text-left ${
                    selected
                      ? 'border-primary-600 bg-primary-50 shadow-sm'
                      : 'border-slate-200 bg-white hover:border-primary-300 hover:shadow-sm'
                  }`}
                >
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${opt.iconBg}`}>
                    <Icon className={`w-5 h-5 ${opt.iconColor}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 text-base leading-tight">{opt.label}</p>
                    <p className="text-sm text-slate-500 mt-0.5">{opt.description}</p>
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                    selected ? 'border-primary-600 bg-primary-600' : 'border-slate-300'
                  }`}>
                    {selected && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Dates */}
        <div>
          <label className="block text-base font-semibold text-slate-800 mb-3">When would you like to start?</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Starting</label>
            <div className="relative">
              <input
                type="date"
                value={data.startDate}
                min={todayIso()}
                onChange={e => onChange({ startDate: e.target.value })}
                className="w-full px-4 py-3 pr-10 rounded-xl border-2 border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 focus:outline-none"
              />
              <Calendar className="w-4 h-4 text-primary-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Ending</label>
            <div className="relative">
              <input
                type="date"
                value={data.ongoing ? '' : data.endDate}
                min={data.startDate || todayIso()}
                disabled={data.ongoing}
                onChange={e => onChange({ endDate: e.target.value })}
                placeholder="End date (optional)"
                className="w-full px-4 py-3 pr-10 rounded-xl border-2 border-slate-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-100 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
              />
              <Calendar className="w-4 h-4 text-primary-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
            <label className="inline-flex items-center gap-2 mt-2 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={data.ongoing}
                onChange={e => onChange({ ongoing: e.target.checked, endDate: e.target.checked ? '' : data.endDate })}
                className="w-4 h-4 accent-teal-600"
              />
              Ongoing / no end date
            </label>
          </div>
        </div>
        </div>

        {/* Days */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Which days? <span className="font-normal text-slate-400">(select all that apply)</span></label>
          <DayOfWeekPicker
            value={data.daysOfWeek}
            onChange={days => onChange({ daysOfWeek: days })}
          />
          <label className="inline-flex items-center gap-3 mt-3 cursor-pointer select-none">
            <div
              role="switch"
              aria-checked={data.daysFlexible}
              onClick={() => onChange({ daysFlexible: !data.daysFlexible })}
              className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${data.daysFlexible ? 'bg-primary-600' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${data.daysFlexible ? 'translate-x-5' : 'translate-x-1'}`} />
            </div>
            <span className="text-sm text-slate-600 font-medium">My days are flexible</span>
          </label>
        </div>

        {/* Time of day */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">What time of day? <span className="font-normal text-slate-400">(select all that apply)</span></label>
          <div className="grid grid-cols-2 gap-2">
            {TIME_OF_DAY_OPTIONS.map(opt => {
              const selected = data.timeOfDay.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({
                    timeOfDay: selected
                      ? data.timeOfDay.filter(v => v !== opt.value)
                      : [...data.timeOfDay, opt.value],
                  })}
                  className={`text-center px-4 py-3 rounded-xl border-2 transition-all font-semibold text-sm ${
                    selected
                      ? 'bg-primary-50 border-primary-600 text-primary-700'
                      : 'bg-white border-slate-200 hover:border-primary-300 text-slate-800'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-slate-500 hover:text-slate-700 font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleContinue}
          className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-10 py-3 rounded-xl shadow-md transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
};
