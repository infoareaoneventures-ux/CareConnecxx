import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle,
  Circle,
  ChevronUp,
  ChevronDown,
  X,
  ClipboardList,
  ArrowRight,
} from 'lucide-react';
import { useCareConnex } from '../../context/CareConnexContext';
import { useOnboardingSteps } from '../../hooks/useOnboardingSteps';

const STORAGE_KEY_PREFIX = 'onboarding_helper_dismissed_';

export const FloatingOnboardingHelper: React.FC = () => {
  const { currentUser } = useCareConnex();
  const navigate = useNavigate();
  const { steps, completedCount, totalCount, allDone, loading } = useOnboardingSteps();

  const storageKey = currentUser ? `${STORAGE_KEY_PREFIX}${currentUser.uid}` : null;

  const [isDismissed, setIsDismissed] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const [showAllDone, setShowAllDone] = useState(false);

  // Read dismissed state from localStorage once uid is known
  useEffect(() => {
    if (storageKey) {
      setIsDismissed(localStorage.getItem(storageKey) === 'true');
    }
  }, [storageKey]);

  // When all steps complete, briefly show celebration then auto-dismiss
  useEffect(() => {
    if (allDone && !loading && totalCount > 0 && !isDismissed) {
      setShowAllDone(true);
      const timer = setTimeout(() => {
        if (storageKey) localStorage.setItem(storageKey, 'true');
        setShowAllDone(false);
        setIsDismissed(true);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [allDone, loading, totalCount, isDismissed, storageKey]);

  const handleDismiss = () => {
    if (storageKey) localStorage.setItem(storageKey, 'true');
    setIsDismissed(true);
  };

  if (
    !currentUser ||
    currentUser.userType === 'admin' ||
    isDismissed ||
    loading ||
    totalCount === 0
  ) {
    return null;
  }

  const currentStep = steps.find((s) => !s.done);
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  if (showAllDone) {
    return (
      <div className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-50">
        <div className="bg-[var(--color-success-50)] border border-green-200 rounded-2xl shadow-lg px-5 py-4 flex items-center gap-3">
          <span className="text-2xl" role="img" aria-label="celebration">🎉</span>
          <div>
            <p className="font-semibold text-green-800 text-sm">All done!</p>
            <p className="text-green-600 text-xs">You're all set up.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="bg-white border border-[var(--color-neutral-200)] rounded-2xl shadow-xl w-72 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-neutral-100)]">
            <div className="flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-[var(--color-primary-600)]" />
              <span className="font-semibold text-sm text-[var(--color-neutral-800)]">
                Your next steps
              </span>
            </div>
            <button
              onClick={handleDismiss}
              className="text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)] transition-colors p-1 rounded-lg"
              aria-label="Dismiss onboarding helper"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Progress bar */}
          <div className="h-1 bg-[var(--color-neutral-100)]">
            <div
              className="h-1 bg-gradient-to-r from-[var(--color-primary-600)] to-[var(--color-primary-400)] transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* Steps list */}
          <ul className="py-2">
            {steps.map((step) => {
              const isCurrent = !step.done && step.id === currentStep?.id;
              return (
                <li key={step.id}>
                  <button
                    onClick={() => isCurrent && navigate(step.path)}
                    disabled={!isCurrent}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isCurrent
                        ? 'bg-[var(--color-primary-50)] hover:bg-[var(--color-primary-100)] cursor-pointer'
                        : 'cursor-default'
                    }`}
                  >
                    {step.done ? (
                      <CheckCircle className="w-4 h-4 flex-shrink-0 text-green-500" />
                    ) : isCurrent ? (
                      <div className="w-4 h-4 flex-shrink-0 rounded-full border-2 border-[var(--color-primary-500)] bg-[var(--color-primary-100)]" />
                    ) : (
                      <Circle className="w-4 h-4 flex-shrink-0 text-[var(--color-neutral-300)]" />
                    )}
                    <span
                      className={`text-sm flex-1 leading-snug ${
                        step.done
                          ? 'text-[var(--color-neutral-400)] line-through'
                          : isCurrent
                          ? 'text-[var(--color-neutral-800)] font-medium'
                          : 'text-[var(--color-neutral-500)]'
                      }`}
                    >
                      {step.label}
                    </span>
                    {isCurrent && (
                      <ArrowRight className="w-3.5 h-3.5 text-[var(--color-primary-500)] flex-shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Footer */}
          <div className="px-4 py-2 bg-[var(--color-neutral-50)] border-t border-[var(--color-neutral-100)]">
            <p className="text-xs text-[var(--color-neutral-500)]">
              {completedCount} of {totalCount} complete
            </p>
          </div>
        </div>
      )}

      {/* Pill toggle */}
      <button
        onClick={() => setIsOpen((o) => !o)}
        className="flex items-center gap-2 bg-white border border-[var(--color-neutral-200)] rounded-full shadow-lg px-4 py-2 hover:shadow-xl transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0"
        aria-label={isOpen ? 'Collapse onboarding steps' : 'Expand onboarding steps'}
      >
        <ClipboardList className="w-4 h-4 text-[var(--color-primary-600)]" />
        <span className="text-sm font-medium text-[var(--color-neutral-700)]">
          {completedCount}/{totalCount} steps
        </span>
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--color-neutral-400)]" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-[var(--color-neutral-400)]" />
        )}
      </button>
    </div>
  );
};
