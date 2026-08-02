// ── ChildProfileCard (plan 2026-07-22-002, U11) ─────────────────────────────
//
// Secure child card for authenticated family views. Renders ONLY the
// operational summary the U3 callables project: display label + derived age
// band + broad categories + a safety-details indicator. Never a DOB, address,
// health, custody, or pickup detail (R10/R33) — those fields never reach this
// component's props by contract.

import React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { ageBandLabel, categoryLabel, type ChildSummary } from '../../shared/childcareAccess';

export interface ChildProfileCardProps {
  child: ChildSummary;
  /** Optional action (e.g. manage safety details); rendered as a real button. */
  onManage?: (childId: string) => void;
  manageLabel?: string;
}

export const ChildProfileCard: React.FC<ChildProfileCardProps> = ({ child, onManage, manageLabel }) => {
  const hasSafety = child.safetyCurrentVersion > 0;
  return (
    <div
      className="bg-white border border-slate-200 rounded-2xl p-4 flex items-center justify-between gap-3"
      data-testid={`child-card-${child.childId}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-slate-900 truncate" title={child.displayLabel}>
          {child.displayLabel}
        </p>
        <p className="text-xs text-slate-500 mt-0.5 break-words">
          {ageBandLabel(child.ageBand)}
          {child.careCategories.length > 0 && (
            <> · {child.careCategories.map(categoryLabel).join(', ')}</>
          )}
        </p>
        <p className={`text-xs mt-1 inline-flex items-center gap-1 ${hasSafety ? 'text-emerald-700' : 'text-amber-700'}`}>
          {hasSafety ? (
            <>
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" /> Safety details on file
            </>
          ) : (
            <>
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" /> Safety details needed — add them so a
              confirmed caregiver has what they need
            </>
          )}
        </p>
      </div>
      {onManage && (
        <button
          type="button"
          onClick={() => onManage(child.childId)}
          aria-label={`${manageLabel ?? (hasSafety ? 'Update safety details' : 'Add safety details')} for ${child.displayLabel}`}
          className="px-4 py-2 rounded-full border border-slate-200 text-sm font-medium text-slate-800 hover:bg-slate-50 flex-shrink-0"
        >
          {manageLabel ?? (hasSafety ? 'Update safety details' : 'Add safety details')}
        </button>
      )}
    </div>
  );
};

export default ChildProfileCard;
