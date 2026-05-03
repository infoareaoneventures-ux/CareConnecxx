import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { TIME_BLOCKS, DAYS, JOB_TYPES } from '../constants';

interface Step5Props {
  jobTypes: string[];
  weeklyAvailability: Record<string, string[]>;
  neverAvailable: string[];
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

export const Step5Availability: React.FC<Step5Props> = ({
  jobTypes,
  weeklyAvailability,
  neverAvailable,
  onChange,
  onNext,
  onBack,
  onShowToast,
  isLoading,
}) => {

  const toggleJobType = (id: string) => {
    const updated = jobTypes.includes(id)
      ? jobTypes.filter((t) => t !== id)
      : [...jobTypes, id];
    onChange('jobTypes', updated);
  };

  const toggleSlot = (day: string, block: string) => {
    // If toggling a regular block, remove from never-available
    if (neverAvailable.includes(day)) {
      onChange('neverAvailable', neverAvailable.filter((d) => d !== day));
    }

    const daySlots = weeklyAvailability[day] || [];
    const updated = daySlots.includes(block)
      ? daySlots.filter((s) => s !== block)
      : [...daySlots, block];

    onChange('weeklyAvailability', {
      ...weeklyAvailability,
      [day]: updated,
    });
  };

  const toggleNeverAvailable = (day: string) => {
    if (neverAvailable.includes(day)) {
      onChange('neverAvailable', neverAvailable.filter((d) => d !== day));
    } else {
      onChange('neverAvailable', [...neverAvailable, day]);
      // Clear all time blocks for that day
      onChange('weeklyAvailability', {
        ...weeklyAvailability,
        [day]: [],
      });
    }
  };

  const handleContinue = () => {
    if (jobTypes.length === 0) {
      onShowToast('Please select at least one job type', 'error');
      return;
    }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        What jobs are you looking for?
      </h1>
      <p className="text-slate-500 mb-6">Deselect any that don't apply</p>

      {/* Job Type Checkboxes */}
      <div className="flex flex-wrap gap-3 mb-8">
        {JOB_TYPES.map((jt) => (
          <button
            key={jt.id}
            onClick={() => toggleJobType(jt.id)}
            className={`px-5 py-2.5 rounded-full border-2 text-sm font-medium transition-all ${
              jobTypes.includes(jt.id)
                ? 'bg-primary-600 border-primary-600 text-white'
                : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
            }`}
          >
            {jobTypes.includes(jt.id) && <span className="mr-1.5">&#10003;</span>}
            {jt.label}
            <span className="block text-xs opacity-75 mt-0.5">{jt.subtitle}</span>
          </button>
        ))}
      </div>

      {/* Availability Grid */}
      <h2 className="text-xl font-bold text-slate-800 mb-1">
        When are you generally available?
      </h2>
      <p className="text-sm text-slate-500 mb-4">
        Providing your schedule helps families see if your availability is a match. You can customize your calendar in more detail later.
      </p>

      <div className="overflow-x-auto">
        <div className="min-w-[420px]">
          {TIME_BLOCKS.map((block) => (
            <div key={block.id} className="mb-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-base">{block.icon}</span>
                <span className="text-sm font-semibold text-slate-700">
                  {block.label} <span className="font-normal text-slate-400">({block.time})</span>
                </span>
              </div>
              <div className="flex gap-2">
                {DAYS.map((day, dayIdx) => {
                  const isActive = (weeklyAvailability[day.id] || []).includes(block.id);
                  const isNever = neverAvailable.includes(day.id);
                  return (
                    <button
                      key={`${block.id}-${day.id}-${dayIdx}`}
                      onClick={() => !isNever && toggleSlot(day.id, block.id)}
                      disabled={isNever}
                      className={`w-10 h-10 rounded-full text-sm font-semibold transition-all ${
                        isNever
                          ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                          : isActive
                          ? 'bg-primary-400 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}
                    >
                      {day.short}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Never Available Row */}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-base">&#9201;</span>
              <span className="text-sm font-semibold text-slate-700">Never available</span>
            </div>
            <div className="flex gap-2">
              {DAYS.map((day, dayIdx) => {
                const isNever = neverAvailable.includes(day.id);
                return (
                  <button
                    key={`never-${day.id}-${dayIdx}`}
                    onClick={() => toggleNeverAvailable(day.id)}
                    className={`w-10 h-10 rounded-full text-sm font-semibold transition-all ${
                      isNever
                        ? 'bg-slate-500 text-white'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-3 mt-8">
        <Button variant="secondary" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleContinue}
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Saving...
            </span>
          ) : (
            'Next'
          )}
        </Button>
      </div>
    </div>
  );
};
