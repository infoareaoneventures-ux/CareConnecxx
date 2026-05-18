import React from 'react';
import { Shield, CheckCircle, Clock } from 'lucide-react';

interface Props {
  verified?: boolean;
  backgroundCheckStatus?: string;
  className?: string;
}

export const CaregiverVerificationBadges: React.FC<Props> = ({ verified, backgroundCheckStatus, className = '' }) => {
  const idvVerified = verified === true;
  const bgcClear = backgroundCheckStatus === 'clear';
  const bgcPending = backgroundCheckStatus === 'processing' || backgroundCheckStatus === 'pending' || backgroundCheckStatus === 'consider';

  if (!idvVerified && !bgcClear && !bgcPending) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {idvVerified && (
        <div className="w-9 h-9 rounded-full bg-teal-500 flex flex-col items-center justify-center text-white pt-1" title="Identity Verified">
          <Shield className="w-4 h-4 mb-0.5" />
          <span className="text-[7px] font-bold leading-none tracking-wider uppercase">IDV</span>
        </div>
      )}
      {bgcClear && (
        <div className="w-9 h-9 rounded-full bg-blue-500 flex flex-col items-center justify-center text-white pt-1" title="Background Check Cleared">
          <CheckCircle className="w-4 h-4 mb-0.5" />
          <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC+</span>
        </div>
      )}
      {bgcPending && !bgcClear && (
        <div className="w-9 h-9 rounded-full bg-yellow-400 flex flex-col items-center justify-center text-white pt-1" title="Background Check Pending">
          <Clock className="w-4 h-4 mb-0.5" />
          <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC</span>
        </div>
      )}
    </div>
  );
};
