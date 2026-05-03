import React from 'react';

interface StepIndicatorProps {
  steps: number;
  current: number;
  onStepClick?: (index: number) => void;
}

export const StepIndicator: React.FC<StepIndicatorProps> = ({ steps, current, onStepClick }) => {
  return (
    <div className="flex items-center justify-center gap-2" role="progressbar" aria-valuenow={current + 1} aria-valuemin={1} aria-valuemax={steps}>
      {Array.from({ length: steps }).map((_, i) => {
        const active = i === current;
        const completed = i < current;
        const clickable = onStepClick && i <= current;
        return (
          <button
            key={i}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onStepClick?.(i)}
            aria-label={`Step ${i + 1} of ${steps}`}
            className={`transition-all rounded-full ${
              active
                ? 'w-3 h-3 bg-primary-600'
                : completed
                  ? 'w-2.5 h-2.5 bg-primary-500'
                  : 'w-2.5 h-2.5 bg-slate-300'
            } ${clickable ? 'cursor-pointer hover:scale-110' : 'cursor-default'}`}
          />
        );
      })}
    </div>
  );
};
