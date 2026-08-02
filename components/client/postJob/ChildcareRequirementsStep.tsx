// Childcare requirements step (plan 2026-07-22-002 U6 — plan-named component).
//
// FUNCTIONAL BUT UNWIRED: PostJobFlow integration is deliberately deferred to
// U11 (UI unit). This component is a pure controlled step with callable-shaped
// props — no Firestore access, no services/api import, no side effects:
//   • `childProfiles` comes from v1-listMyChildren (operational summaries:
//     display label + age band + care categories — never DOB, R10),
//   • `approvedServiceCategories` comes from the jurisdiction policy
//     projection (enableable categories only — deferred categories never
//     reach this list, and infant-band children render disabled),
//   • the produced value is exactly the v1-createChildcareJobPost input
//     surface (childIds + serviceCategories + transportRequired) — the
//     privacy-safe requirement projection itself is computed SERVER-SIDE.
//
// There is deliberately NO free-text field on this step (R33/AE19): nothing a
// parent types here can reach the public childcare listing.

import React from 'react';

export interface ChildcareChildSummary {
  childId: string;
  /** Preferred display label (first name / nickname) — adult-authorized view only. */
  displayLabel: string;
  /** Derived age band — never an exact DOB (R10). */
  ageBand: string;
  careCategories: string[];
}

export interface ChildcareRequirementsValue {
  childIds: string[];
  serviceCategories: string[];
  transportRequired: boolean;
}

export interface ChildcareRequirementsStepProps {
  childProfiles: ChildcareChildSummary[];
  /** Jurisdiction-approved (enableable) categories only. */
  approvedServiceCategories: string[];
  value: ChildcareRequirementsValue;
  onChange: (next: ChildcareRequirementsValue) => void;
  onNext?: () => void;
  onBack?: () => void;
}

const AGE_BAND_LABELS: Record<string, string> = {
  infant: 'Under 1',
  toddler: '1–2 yrs',
  preschool: '3–4 yrs',
  school_age: '5–9 yrs',
  preteen: '10–12 yrs',
  teen: '13–17 yrs',
};

function categoryLabel(category: string): string {
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Infant care is a deferred category (no approved credential/policy package). */
export function isSelectableChild(child: ChildcareChildSummary): boolean {
  return child.ageBand !== 'infant' && child.ageBand !== 'aged_out';
}

export function canContinue(value: ChildcareRequirementsValue): boolean {
  return value.childIds.length > 0 && value.serviceCategories.length > 0;
}

const ChildcareRequirementsStep: React.FC<ChildcareRequirementsStepProps> = ({
  childProfiles,
  approvedServiceCategories,
  value,
  onChange,
  onNext,
  onBack,
}) => {
  const toggleChild = (childId: string) => {
    const next = value.childIds.includes(childId)
      ? value.childIds.filter((id) => id !== childId)
      : [...value.childIds, childId];
    onChange({ ...value, childIds: next });
  };

  const toggleCategory = (category: string) => {
    // Only jurisdiction-approved categories are toggleable; anything else is
    // ignored defensively (the server hard-blocks regardless).
    if (!approvedServiceCategories.includes(category)) return;
    const next = value.serviceCategories.includes(category)
      ? value.serviceCategories.filter((c) => c !== category)
      : [...value.serviceCategories, category];
    onChange({ ...value, serviceCategories: next });
  };

  const selectedBands = Array.from(
    new Set(
      childProfiles
        .filter((c) => value.childIds.includes(c.childId))
        .map((c) => AGE_BAND_LABELS[c.ageBand] ?? c.ageBand),
    ),
  );

  return (
    <div className="space-y-6" data-testid="childcare-requirements-step">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Who needs care?</h2>
        <p className="mt-1 text-sm text-gray-500">
          Caregivers see age groups and your approximate area only — never
          names, addresses, or personal details.
        </p>
        <div className="mt-3 space-y-2" role="group" aria-label="Select children">
          {childProfiles.length === 0 && (
            <p className="text-sm text-gray-500" data-testid="no-children-note">
              Add a child profile first to post a childcare job.
            </p>
          )}
          {childProfiles.map((child) => {
            const selectable = isSelectableChild(child);
            const checked = value.childIds.includes(child.childId);
            return (
              <label
                key={child.childId}
                className={`flex items-center gap-3 rounded-lg border p-3 ${
                  selectable ? 'cursor-pointer border-gray-200' : 'cursor-not-allowed border-gray-100 opacity-60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!selectable}
                  onChange={() => toggleChild(child.childId)}
                  aria-label={`Select ${child.displayLabel}`}
                />
                <span className="font-medium text-gray-900">{child.displayLabel}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {AGE_BAND_LABELS[child.ageBand] ?? child.ageBand}
                </span>
                {!selectable && (
                  <span className="text-xs text-gray-500" data-testid={`deferred-${child.childId}`}>
                    Care for this age group isn&apos;t available yet
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold text-gray-900">What kind of care?</h3>
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Care types">
          {approvedServiceCategories.map((category) => (
            <button
              key={category}
              type="button"
              onClick={() => toggleCategory(category)}
              aria-pressed={value.serviceCategories.includes(category)}
              className={`rounded-full border px-3 py-1 text-sm ${
                value.serviceCategories.includes(category)
                  ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                  : 'border-gray-300 text-gray-700'
              }`}
            >
              {categoryLabel(category)}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={value.transportRequired}
          onChange={() => onChange({ ...value, transportRequired: !value.transportRequired })}
          aria-label="Transport required"
        />
        <span className="text-sm text-gray-700">
          I need a caregiver who can drive (only caregivers with current driving
          verification will see this job)
        </span>
      </label>

      {selectedBands.length > 0 && (
        <p className="text-sm text-gray-500" data-testid="public-preview">
          Caregivers will see: {selectedBands.join(', ')} · your approximate area
        </p>
      )}

      <div className="flex justify-between">
        {onBack && (
          <button type="button" onClick={onBack} className="rounded-lg border px-4 py-2 text-gray-700">
            Back
          </button>
        )}
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            disabled={!canContinue(value)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50"
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
};

export default ChildcareRequirementsStep;
