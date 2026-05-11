import React from 'react';
import { AlertCircle, CheckCircle } from 'lucide-react';
import type { Caregiver } from '../../types';

interface ProfileApprovalBannerProps {
  profile: Partial<Caregiver> & { verified?: boolean; verificationStatus?: Caregiver['verificationStatus'] };
  onViewChecklist?: () => void;
}

export const ProfileApprovalBanner: React.FC<ProfileApprovalBannerProps> = ({ profile, onViewChecklist }) => {
  const isApproved = (profile.verificationStatus === 'approved' || profile.verified === true)
    && profile.verificationStatus !== 'info_requested'
    && profile.verificationStatus !== 'rejected';

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

  if (profile.verificationStatus === 'info_requested') {
    return (
      <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-orange-500 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-orange-900 font-medium">Additional information needed</p>
          <p className="text-xs text-orange-700">Our team has reviewed your profile and needs more information. Please check your notifications or contact support.</p>
        </div>
      </div>
    );
  }

  if (profile.verificationStatus === 'rejected') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-red-900 font-medium">Profile not approved</p>
          <p className="text-xs text-red-700">Your profile was not approved. Please check your notifications for the reason or contact support.</p>
        </div>
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
