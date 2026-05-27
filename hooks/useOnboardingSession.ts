import { useEffect, useState } from 'react';
import { db } from '../lib/firebase';

export type OnboardingSessionStatus = 'awaiting_inbound' | 'connected' | 'expired' | 'unknown';

export interface OnboardingSessionState {
  status: OnboardingSessionStatus;
  chatId?: string;
  role?: 'client' | 'caregiver';
}

export function useOnboardingSession(phone: string | null): OnboardingSessionState {
  const [state, setState] = useState<OnboardingSessionState>({ status: 'unknown' });

  useEffect(() => {
    if (!phone || !db) {
      setState({ status: 'unknown' });
      return;
    }
    const unsub = db
      .collection('web_onboarding_sessions')
      .doc(phone)
      .onSnapshot(
        (snap) => {
          if (!snap.exists) {
            setState({ status: 'unknown' });
            return;
          }
          const data = snap.data() as Record<string, unknown> | undefined;
          setState({
            status: (data?.status as OnboardingSessionStatus) ?? 'unknown',
            chatId: data?.chatId as string | undefined,
            role: data?.role as 'client' | 'caregiver' | undefined,
          });
        },
        () => setState({ status: 'unknown' }),
      );
    return () => unsub();
  }, [phone]);

  return state;
}
