import React from 'react';

export const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type DayOfWeek = typeof DAYS_OF_WEEK[number];

interface DayOfWeekPickerProps {
  value: string[];
  onChange: (days: string[]) => void;
  disabled?: boolean;
}

export const DayOfWeekPicker: React.FC<DayOfWeekPickerProps> = ({ value, onChange, disabled }) => {
  const toggle = (day: string) => {
    if (disabled) return;
    if (value.includes(day)) {
      onChange(value.filter(d => d !== day));
    } else {
      onChange([...value, day]);
    }
  };

  return (
    <div className={`flex flex-wrap gap-2 transition-opacity ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {DAYS_OF_WEEK.map(day => {
        const selected = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            onClick={() => toggle(day)}
            aria-pressed={selected}
            disabled={disabled}
            className={`min-w-[48px] px-3 py-2 rounded-lg text-sm font-semibold transition-all border-2 ${
              selected
                ? 'bg-primary-600 border-primary-600 text-white shadow-sm'
                : 'bg-white border-slate-300 text-slate-700 hover:border-primary-400'
            }`}
          >
            {day}
          </button>
        );
      })}
    </div>
  );
};
