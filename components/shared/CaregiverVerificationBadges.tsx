import React from 'react';
import { CheckCircle } from 'lucide-react';

interface Props {
  verified?: boolean;
  backgroundCheckStatus?: string;
  className?: string;
}

export const CaregiverVerificationBadges: React.FC<Props> = ({ verified: _verified, backgroundCheckStatus, className = '' }) => {
  const bgcClear = backgroundCheckStatus === 'clear';

  if (!bgcClear) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-200 px-2.5 py-1 text-xs font-semibold text-blue-700" title="Background check complete">
        <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Background checked</span>
      </div>
    </div>
  );
};
