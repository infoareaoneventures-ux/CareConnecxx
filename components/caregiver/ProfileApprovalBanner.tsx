import React from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';
import type { Caregiver } from '../../types';

interface ProfileApprovalBannerProps {
  profile: Partial<Caregiver> & { verified?: boolean; verificationStatus?: Caregiver['verificationStatus'] };
  onViewChecklist?: () => void;
}

export const ProfileApprovalBanner: React.FC<ProfileApprovalBannerProps> = ({ profile, onViewChecklist }) => {
  const isApproved = profile.verificationStatus === 'approved' || profile.verified === true;

  if (isApproved) {
    return (
      <div className="bg-primary-50 border border-primary-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <CheckCircle className="w-5 h-5 text-primary-600 flex-shrink-0" />
        <p className="text-sm text-primary-800 flex-1">
          Your profile is approved. Families can find you in search.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-primary-50 border border-primary-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
      <AlertCircle className="w-5 h-5 text-primary-600 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm text-primary-900 font-medium">Let's get your profile approved</p>
        <p className="text-xs text-primary-700">Complete the checklist to get approved, then you can apply for jobs.</p>
      </div>
      {onViewChecklist && (
        <button
          onClick={onViewChecklist}
          className="text-sm font-semibold text-primary-700 hover:text-primary-900 underline underline-offset-2 whitespace-nowrap"
        >
          Approval checklist →
        </button>
      )}
    </div>
  );
};
