import React from 'react';
import { CheckCircle, Baby } from 'lucide-react';
import { CHILDCARE_EVIDENCE_LABEL_TEXT } from './childcareAccess';

interface Props {
  verified?: boolean;
  backgroundCheckStatus?: string;
  className?: string;
  /**
   * Childcare U11 (plan 2026-07-22-002, R30): OPTIONAL per-vertical evidence
   * labels from the public projection (publicCaregiverProfiles →
   * childcareEvidenceLabels). Rendered ONLY when provided AND non-empty —
   * senior callers that pass nothing get byte-identical output (parity pinned
   * by PublicCaregiverProfile.childcare.test.tsx). Display-only: labels are
   * the server's allowlisted evidence claims, never new claims or safety
   * guarantees.
   */
  childcareEvidenceLabels?: string[];
}

export const CaregiverVerificationBadges: React.FC<Props> = ({
  verified: _verified,
  backgroundCheckStatus,
  className = '',
  childcareEvidenceLabels,
}) => {
  const bgcClear = backgroundCheckStatus === 'clear';
  const childcareLabels = (childcareEvidenceLabels ?? []).filter(
    (label) => CHILDCARE_EVIDENCE_LABEL_TEXT[label],
  );

  if (!bgcClear && childcareLabels.length === 0) return null;

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className}`}>
      {bgcClear && (
        <div className="w-9 h-9 rounded-full bg-blue-500 flex flex-col items-center justify-center text-white pt-1" title="Background Check Cleared">
          <CheckCircle className="w-4 h-4 mb-0.5" />
          <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC+</span>
        </div>
      )}
      {childcareLabels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full"
          data-testid={`childcare-evidence-${label}`}
        >
          <Baby className="w-3.5 h-3.5" aria-hidden="true" />
          {CHILDCARE_EVIDENCE_LABEL_TEXT[label]}
        </span>
      ))}
    </div>
  );
};
