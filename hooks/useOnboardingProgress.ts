import { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { dbService } from '../services/api';
import { chatService } from '../services/chatService';
import type { Appointment } from '../types';

export type OnboardingStepId =
  | 'identity-check'
  | 'pay-membership'
  | 'post-job'
  | 'care-plan'
  | 'meet-matches'
  | 'book-care';
export type OnboardingState = OnboardingStepId | 'all-done';

export interface OnboardingProgress {
  carePlanPercent: number;
  carePlanHint: string;
  steps: { id: OnboardingStepId; done: boolean }[];
  currentStep: OnboardingState;
  completedCount: number;
  identityVerified: boolean;
  membershipActive: boolean;
  loading: boolean;
}

const STEP_ORDER: OnboardingStepId[] = [
  'care-plan',
  'identity-check',
  'pay-membership',
  'post-job',
  'meet-matches',
  'book-care',
];

function computeCarePlanProgress(
  jobPostingsData: any | null,
  carePlanData: any | null
): { percent: number; hint: string } {
  const recipientPlans: Record<string, any> = carePlanData?.recipientPlans ?? {};
  const anyHasCareNeeds = Object.values(recipientPlans).some(
    (p: any) => Array.isArray(p?.careNeeds) && p.careNeeds.length > 0
  );
  const hasEmergencyContact =
    (Array.isArray(carePlanData?.emergencyContacts) && carePlanData.emergencyContacts.length > 0) ||
    !!jobPostingsData?.emergencyFirstName;

  const checks: { ok: boolean; missingHint: string }[] = [
    {
      ok: !!jobPostingsData?.careRecipientFirstName,
      missingHint: 'Add a care recipient',
    },
    {
      ok: anyHasCareNeeds,
      missingHint: 'Select the types of care needed',
    },
    {
      ok: !!jobPostingsData?.city,
      missingHint: 'Add a care location',
    },
    {
      ok: hasEmergencyContact,
      missingHint: 'Add an emergency contact',
    },
    {
      ok: !!carePlanData?.carePlanReviewedAt,
      missingHint: 'Review your care plan',
    },
  ];

  const satisfied = checks.filter((c) => c.ok).length;
  const percent = Math.round((satisfied / checks.length) * 100);
  const nextMissing = checks.find((c) => !c.ok);
  const hint = nextMissing ? nextMissing.missingHint : 'Care plan complete';
  return { percent, hint };
}

export function useOnboardingProgress(uid: string | undefined): OnboardingProgress {
  const [jobPostingsData, setJobPostingsData] = useState<any | null>(null);
  const [carePlanData, setCarePlanData] = useState<any | null>(null);
  const [hasPostedJob, setHasPostedJob] = useState(false);
  const [hasRealMessage, setHasRealMessage] = useState(false);
  const [hasAppointment, setHasAppointment] = useState(false);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [membershipActive, setMembershipActive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubs: Array<() => void> = [];

    if (db) {
      const jobPostingsUnsub = db
        .collection('job_postings')
        .doc(uid)
        .onSnapshot(
          (doc) => setJobPostingsData(doc.exists ? doc.data() : null),
          () => setJobPostingsData(null)
        );
      unsubs.push(jobPostingsUnsub);

      const carePlanUnsub = db
        .collection('carePlans')
        .doc(uid)
        .onSnapshot(
          (doc) => setCarePlanData(doc.exists ? doc.data() : null),
          () => setCarePlanData(null)
        );
      unsubs.push(carePlanUnsub);

      const userUnsub = db
        .collection('users')
        .doc(uid)
        .onSnapshot(
          (doc) => {
            const data = (doc.data() as any) || {};
            setIdentityVerified(data.identityCheckStatus === 'verified');
            setMembershipActive(
              !!data.subscriptionActive ||
                data.membershipStatus === 'active' ||
                data.membershipStatus === 'trialing'
            );
          },
          () => {
            setIdentityVerified(false);
            setMembershipActive(false);
          }
        );
      unsubs.push(userUnsub);
    }

    if (db) {
      const jobUnsub = db
        .collection('job_posts')
        .where('clientId', '==', uid)
        .onSnapshot(
          (snap) => setHasPostedJob(!snap.empty),
          () => setHasPostedJob(false)
        );
      unsubs.push(jobUnsub);
    }

    const chatUnsub = chatService.subscribeToChatRooms(
      uid,
      (rooms) => {
        const engaged = rooms.some(
          (r) =>
            Array.isArray(r.participants) &&
            r.participants.includes(uid) &&
            !!r.lastMessage &&
            r.lastMessage.trim().length > 0 &&
            !!r.lastMessageTimestamp
        );
        setHasRealMessage(engaged);
      },
      () => setHasRealMessage(false)
    );
    if (chatUnsub) unsubs.push(chatUnsub as () => void);

    const apptUnsub = dbService.subscribeToAppointments(
      uid,
      'client',
      (appts: Appointment[]) => setHasAppointment(appts.length > 0)
    );
    if (apptUnsub) unsubs.push(apptUnsub);

    setLoading(false);

    return () => {
      unsubs.forEach((u) => {
        try {
          u();
        } catch {
          /* no-op */
        }
      });
    };
  }, [uid]);

  const { percent: carePlanPercent, hint: carePlanHint } = computeCarePlanProgress(
    jobPostingsData,
    carePlanData
  );

  const bypass = import.meta.env.VITE_BYPASS_ONBOARDING === 'true';

  const stepDone: Record<OnboardingStepId, boolean> = {
    'identity-check': bypass || identityVerified,
    'pay-membership': bypass || membershipActive,
    'post-job': hasPostedJob,
    'care-plan': carePlanPercent === 100,
    'meet-matches': hasRealMessage,
    'book-care': hasAppointment,
  };

  const steps = STEP_ORDER.map((id) => ({ id, done: stepDone[id] }));
  const completedCount = steps.filter((s) => s.done).length;
  const firstIncomplete = steps.find((s) => !s.done);
  const currentStep: OnboardingState = firstIncomplete ? firstIncomplete.id : 'all-done';

  return {
    carePlanPercent,
    carePlanHint,
    steps,
    currentStep,
    completedCount,
    identityVerified,
    membershipActive,
    loading,
  };
}
