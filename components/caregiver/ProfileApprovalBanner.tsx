import React from 'react';
import { AlertCircle, CheckCircle, Clock, Info } from 'lucide-react';
import type { Caregiver } from '../../types';
import { isCaregiverBookable } from '../../utils/caregiverEligibility';

interface ProfileApprovalBannerProps {
  profile: Partial<Caregiver> & {
    verified?: boolean;
    verificationStatus?: Caregiver['verificationStatus'];
    onboardingStatus?: string;
    backgroundCheckData?: { checkrCandidateId?: string };
    backgroundCheckStatus?: string;
    // Payout fields live on the owner-only private/payout subdoc — caller
    // must fetch it separately (dbService.getOwnCaregiverPayoutFields) and
    // merge it in, same as CaregiverPaymentsPage.tsx already does.
    payoutsEnabled?: boolean;
    chargesEnabled?: boolean;
  };
  onViewChecklist?: () => void;
  hasEngagement?: boolean;
}

export const ProfileApprovalBanner: React.FC<ProfileApprovalBannerProps> = ({ profile, hasEngagement }) => {
  // Canonical contract: bookable requires profile_complete + verificationStatus approved.
  // `verified` alone is NOT sufficient (it's a secondary display signal only).
  const isApproved = isCaregiverBookable(profile);

  if (isApproved && hasEngagement) return null;

  if (isApproved) {
    return (
      <div className="bg-primary-50 border border-primary-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <CheckCircle className="w-5 h-5 text-primary-600 flex-shrink-0" />
        <p className="text-sm text-primary-800 flex-1">
          <span className="font-semibold">Approved</span> — Families can find you in search.
        </p>
      </div>
    );
  }

  if (profile.verificationStatus === 'rejected') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
        <p className="text-sm text-red-900 flex-1">
          <span className="font-semibold">Not approved</span> — Contact support for details.
        </p>
      </div>
    );
  }

  if (profile.verificationStatus === 'info_requested') {
    return (
      <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-orange-500 flex-shrink-0" />
        <p className="text-sm text-orange-900 flex-1">
          <span className="font-semibold">Action needed</span> — Additional information required. Check your notifications or contact support.
        </p>
      </div>
    );
  }

  if (profile.verificationStatus === 'submitted') {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <Clock className="w-5 h-5 text-blue-500 flex-shrink-0" />
        <p className="text-sm text-blue-900 flex-1">
          <span className="font-semibold">Step 4 of 4 — Your profile is under review.</span>
        </p>
      </div>
    );
  }

  const checkrInitiated = !!profile.backgroundCheckData?.checkrCandidateId;
  const backgroundCheckCleared = profile.backgroundCheckStatus === 'clear';
  const payoutsSetUp = !!(profile.payoutsEnabled && profile.chargesEnabled);
  const onboardingStatus = profile.onboardingStatus as string | undefined;
  const profileComplete = onboardingStatus === 'profile_complete' || onboardingStatus === 'submitted';

  // Background check clears independently of verificationStatus — that field
  // only reaches 'submitted' once Stripe Connect ALSO finishes (see
  // onboardingConversation.ts's stripe_connect finalize step). Without this
  // check, a caregiver who cleared their background check but hasn't finished
  // payouts would incorrectly still see "Background check underway" below.
  if (backgroundCheckCleared && !payoutsSetUp) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <Clock className="w-5 h-5 text-blue-500 flex-shrink-0" />
        <p className="text-sm text-blue-900 flex-1">
          <span className="font-semibold">Step 3 of 4 — Set up your payout account</span> to finish approval.
        </p>
      </div>
    );
  }

  if (checkrInitiated) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <Clock className="w-5 h-5 text-blue-500 flex-shrink-0" />
        <p className="text-sm text-blue-900 flex-1">
          <span className="font-semibold">Step 2 of 4 — Background check underway.</span> We'll notify you when complete.
        </p>
      </div>
    );
  }

  if (!profileComplete) {
    return (
      <div className="bg-primary-50 border border-primary-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
        <Info className="w-5 h-5 text-primary-600 flex-shrink-0" />
        <p className="text-sm text-primary-900 flex-1">
          <span className="font-semibold">Step 1 of 4 — Complete your profile</span> to continue.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-primary-50 border border-primary-200 rounded-2xl p-4 mb-6 flex items-center gap-3">
      <Info className="w-5 h-5 text-primary-600 flex-shrink-0" />
      <p className="text-sm text-primary-900 flex-1">
        <span className="font-semibold">Step 2 of 4 — Start your background check</span> to get approved.
      </p>
    </div>
  );
};
