import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { OnboardingFlow, OnboardingRole } from './onboarding/OnboardingFlow';

// The site's signup links say `?role=care-provider` (founder's "care provider"
// wording, 2026-10-12); links Evia texted before that, bookmarks and the
// sitemap's old entry say `?role=caregiver`. Both open the same caregiver
// onboarding, and the server keeps receiving the value it already understands
// (`caregiver` — v1-createWebOnboardingSession, the caregivers/ record).
export const ROLE_PARAM_ALIASES: Record<string, OnboardingRole> = {
  client: 'client',
  caregiver: 'caregiver',
  'care-provider': 'caregiver',
};

export function roleFromParam(roleParam: string | null): OnboardingRole | null {
  return roleParam ? ROLE_PARAM_ALIASES[roleParam] ?? null : null;
}

export const PhoneSignupPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const initialRole = roleFromParam(searchParams.get('role'));
  const referralId = searchParams.get('ref')?.trim() || null;
  return <OnboardingFlow initialRole={initialRole} referralId={referralId} />;
};

export default PhoneSignupPage;
