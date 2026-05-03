import { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { dbService } from '../services/api';
import { chatService } from '../services/chatService';
import type { CarePlan, ClientIntakeData, Appointment } from '../types';

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
  'identity-check',
  'pay-membership',
  'post-job',
  'care-plan',
  'meet-matches',
  'book-care',
];

function computeCarePlanProgress(
  intake: ClientIntakeData | null,
  plan: CarePlan | null
): { percent: number; hint: string } {
  const checks: { ok: boolean; missingHint: string }[] = [
    {
      ok: !!intake?.careTypes && intake.careTypes.length > 0,
      missingHint: 'Pick the types of care needed',
    },
    {
      ok:
        (!!intake?.weeklySchedule &&
          Object.values(intake.weeklySchedule).some(
            (slots) => Array.isArray(slots) && slots.length > 0
          )) ||
        !!intake?.schedule,
      missingHint: 'Set a weekly schedule',
    },
    {
      ok: !!intake?.streetAddress && !!intake?.zipCode,
      missingHint: 'Add the care address',
    },
    {
      ok: !!intake?.startDate,
      missingHint: 'Choose a start date',
    },
    {
      ok:
        (plan?.medications?.length ?? 0) > 0 ||
        (plan?.emergencyContacts?.length ?? 0) > 0,
      missingHint: 'Add medications or an emergency contact',
    },
  ];

  const satisfied = checks.filter((c) => c.ok).length;
  const percent = Math.round((satisfied / checks.length) * 100);
  const nextMissing = checks.find((c) => !c.ok);
  const hint = nextMissing ? nextMissing.missingHint : 'Care plan complete';
  return { percent, hint };
}

export function useOnboardingProgress(uid: string | undefined): OnboardingProgress {
  const [intake, setIntake] = useState<ClientIntakeData | null>(null);
  const [plan, setPlan] = useState<CarePlan | null>(null);
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
      const intakeUnsub = db
        .collection('clientIntakes')
        .doc(uid)
        .onSnapshot(
          (doc) => {
            setIntake(doc.exists ? (doc.data() as ClientIntakeData) : null);
          },
          () => setIntake(null)
        );
      unsubs.push(intakeUnsub);

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

    const planUnsub = dbService.subscribeToCarePlan(uid, (p) => setPlan(p));
    if (planUnsub) unsubs.push(planUnsub);

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
    intake,
    plan
  );

  const stepDone: Record<OnboardingStepId, boolean> = {
    'identity-check': identityVerified,
    'pay-membership': membershipActive,
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
