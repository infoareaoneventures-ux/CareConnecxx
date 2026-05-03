import { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { useOnboardingProgress } from './useOnboardingProgress';
import { useCareConnex } from '../context/CareConnexContext';

export interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  done: boolean;
  path: string;
}

export interface OnboardingStepsResult {
  steps: OnboardingStep[];
  completedCount: number;
  totalCount: number;
  allDone: boolean;
  loading: boolean;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const CLIENT_STEP_META: Record<string, { label: string; description: string; path: string }> = {
  'identity-check': {
    label: 'Verify your identity',
    description: 'Complete a quick identity check to unlock all features',
    path: '/client/account',
  },
  'pay-membership': {
    label: 'Activate membership',
    description: 'Subscribe to start connecting with caregivers',
    path: '/client/membership',
  },
  'post-job': {
    label: 'Post a job',
    description: 'Tell caregivers what kind of help you need',
    path: '/client/post-job',
  },
  'care-plan': {
    label: 'Complete care plan',
    description: 'Add medications, schedule, and emergency contacts',
    path: '/client/care-plan',
  },
  'meet-matches': {
    label: 'Message your matches',
    description: 'Say hello to your matched caregivers',
    path: '/client/inbox',
  },
  'book-care': {
    label: 'Book your first visit',
    description: "Schedule a visit and you're all set",
    path: '/client/browse-caregivers',
  },
};

function useClientSteps(uid: string): OnboardingStepsResult {
  const progress = useOnboardingProgress(uid);

  const steps: OnboardingStep[] = progress.steps.map((s) => ({
    id: s.id,
    label: CLIENT_STEP_META[s.id]?.label ?? s.id,
    description: CLIENT_STEP_META[s.id]?.description ?? '',
    done: s.done,
    path: CLIENT_STEP_META[s.id]?.path ?? '/client/dashboard',
  }));

  const completedCount = steps.filter((s) => s.done).length;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    allDone: progress.currentStep === 'all-done',
    loading: progress.loading,
  };
}

// ─── Caregiver ────────────────────────────────────────────────────────────────

interface CaregiverSnapshot {
  membershipStatus?: string;
  backgroundCheckData?: { checkrCandidateId?: string };
  backgroundCheckStatus?: string;
  photo?: string;
  photoURL?: string;
  imageUrl?: string;
  bio?: string;
  hourlyRate?: number;
}

const CAREGIVER_STEP_DEFS: Array<{
  id: string;
  label: string;
  description: string;
  path: string;
  isDone: (p: CaregiverSnapshot) => boolean;
}> = [
  {
    id: 'complete-signup',
    label: 'Complete signup',
    description: "You created your account — great start!",
    path: '/caregiver/dashboard',
    isDone: () => true,
  },
  {
    id: 'purchase-membership',
    label: 'Purchase membership',
    description: 'Activate your annual membership to apply for jobs',
    path: '/caregiver/membership',
    isDone: (p) =>
      !!p.membershipStatus &&
      p.membershipStatus !== 'none' &&
      p.membershipStatus !== 'inactive',
  },
  {
    id: 'background-check',
    label: 'Submit background check',
    description: 'Families trust verified caregivers — start your check',
    path: '/caregiver/dashboard',
    isDone: (p) =>
      !!p.backgroundCheckData?.checkrCandidateId ||
      (!!p.backgroundCheckStatus && p.backgroundCheckStatus !== 'none'),
  },
  {
    id: 'photo-bio',
    label: 'Add photo & bio',
    description: 'A photo and bio help families get to know you',
    path: '/caregiver/profile',
    isDone: (p) =>
      !!(p.photo || p.photoURL || p.imageUrl) && (p.bio?.length ?? 0) >= 50,
  },
  {
    id: 'set-rates',
    label: 'Set your hourly rate',
    description: 'Let families know what you charge per hour',
    path: '/caregiver/profile',
    isDone: (p) => (p.hourlyRate ?? 0) > 0,
  },
];

function useCaregiverSteps(uid: string): OnboardingStepsResult {
  const [profile, setProfile] = useState<CaregiverSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid || !db) {
      setLoading(false);
      return;
    }
    const unsub = db
      .collection('caregivers')
      .doc(uid)
      .onSnapshot(
        (doc) => {
          setProfile(doc.exists ? (doc.data() as CaregiverSnapshot) : {});
          setLoading(false);
        },
        () => {
          setProfile({});
          setLoading(false);
        }
      );
    return unsub;
  }, [uid]);

  if (!profile) {
    return {
      steps: [],
      completedCount: 0,
      totalCount: CAREGIVER_STEP_DEFS.length,
      allDone: false,
      loading,
    };
  }

  const steps: OnboardingStep[] = CAREGIVER_STEP_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    done: def.isDone(profile),
    path: def.path,
  }));

  const completedCount = steps.filter((s) => s.done).length;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    allDone: completedCount === steps.length,
    loading,
  };
}

// ─── Unified export ───────────────────────────────────────────────────────────

export function useOnboardingSteps(): OnboardingStepsResult {
  const { currentUser } = useCareConnex();
  const uid = currentUser?.uid ?? '';
  const userType = currentUser?.userType;

  // Always call both hooks (React rules); only the one with a real uid subscribes.
  const clientUid = userType === 'client' ? uid : '';
  const caregiverUid = userType === 'caregiver' ? uid : '';

  const clientResult = useClientSteps(clientUid);
  const caregiverResult = useCaregiverSteps(caregiverUid);

  if (!currentUser || userType === 'admin') {
    return { steps: [], completedCount: 0, totalCount: 0, allDone: true, loading: false };
  }

  return userType === 'caregiver' ? caregiverResult : clientResult;
}
