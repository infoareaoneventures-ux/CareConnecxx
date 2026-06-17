import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { OnboardingFlow, OnboardingRole } from './onboarding/OnboardingFlow';

export const PhoneSignupPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const roleParam = searchParams.get('role');
  const referralId = searchParams.get('ref')?.trim() || null;
  const initialRole: OnboardingRole | null =
    roleParam === 'client' || roleParam === 'caregiver' ? roleParam : null;
  return <OnboardingFlow initialRole={initialRole} referralId={referralId} />;
};

export default PhoneSignupPage;
