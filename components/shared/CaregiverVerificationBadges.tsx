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
      <div className="w-9 h-9 rounded-full bg-blue-500 flex flex-col items-center justify-center text-white pt-1" title="Background Check Cleared">
        <CheckCircle className="w-4 h-4 mb-0.5" />
        <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC+</span>
      </div>
    </div>
  );
};
