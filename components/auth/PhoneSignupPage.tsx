import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { OnboardingFlow, OnboardingRole } from './onboarding/OnboardingFlow';

export const PhoneSignupPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const roleParam = searchParams.get('role');
  const referralId = searchParams.get('ref')?.trim() || null;
  const initialRole: OnboardingRole | null =
    roleParam === 'client' || roleParam === 'caregiver' ? roleParam : null;
  // Childcare U4: the childcare deep link. Front door Stage 1 treats it as an
  // ANSWER — it pre-selects childcare and SKIPS the care-type question, so every
  // existing /start?vertical=child link keeps working exactly as it did.
  const childcareEntry = searchParams.get('vertical') === 'child';
  // Front door Stage 1: organic arrivals (no vertical in the URL) are asked
  // which kind of care they need. `?vertical=senior` is an explicit senior
  // answer and skips the question too — the senior flow it lands on is
  // byte-identical to the pre-childcare flow.
  const askCareType = !searchParams.get('vertical');
  return (
    <OnboardingFlow
      initialRole={initialRole}
      referralId={referralId}
      childcareEntry={childcareEntry}
      askCareType={askCareType}
    />
  );
};

export default PhoneSignupPage;
