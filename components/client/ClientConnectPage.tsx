import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { functions } from '../../lib/firebase';
import { useCareConnex } from '../../context/CareConnexContext';
import { useOnboardingSession } from '../../hooks/useOnboardingSession';
import { BloomMark } from '../ui/BloomMark';
import { MobileHandoff } from '../auth/onboarding/MobileHandoff';
import { QRHandoff } from '../auth/onboarding/QRHandoff';

function useDevice(): 'mobile' | 'desktop' {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

export const ClientConnectPage: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser } = useCareConnex();
  const device = useDevice();

  const [linqPhone, setLinqPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const phone = currentUser?.phone ?? null;
  const sessionState = useOnboardingSession(linqPhone ? phone : null);

  // Already connected (e.g. eviaConnected just flipped via onSnapshot) — let them in
  useEffect(() => {
    if (currentUser?.eviaConnected) navigate('/client/dashboard', { replace: true });
  }, [currentUser?.eviaConnected, navigate]);

  // Session became connected via the onSnapshot listener — navigate in
  useEffect(() => {
    if (sessionState.status === 'connected') navigate('/client/dashboard', { replace: true });
  }, [sessionState.status, navigate]);

  // Create a fresh web onboarding session to get the LINQ phone number
  useEffect(() => {
    if (!functions || !currentUser?.phone) {
      setError('Could not load your account. Please sign out and sign back in.');
      setLoading(false);
      return;
    }
    const create = functions.httpsCallable('v1-createWebOnboardingSession');
    create({ phone: currentUser.phone, role: 'client' })
      .then((resp: any) => {
        const data = resp.data as { linqPhone?: string };
        if (!data?.linqPhone) throw new Error('No LINQ number');
        setLinqPhone(data.linqPhone);
      })
      .catch(() => setError('Something went wrong. Please refresh and try again.'))
      .finally(() => setLoading(false));
  }, [currentUser?.phone]);

  if (loading) {
    return (
      <div className="min-h-screen bg-paper-50 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !linqPhone) {
    return (
      <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center px-6 gap-4 text-center">
        <BloomMark className="w-8 h-8 text-ink-400" />
        <p className="text-ink-600 text-sm">{error ?? 'Something went wrong.'}</p>
        <button onClick={() => window.location.reload()} className="text-sm font-medium text-primary-600 hover:underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper-50 text-ink-900 flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-paper-100 border hairline flex items-center justify-center mx-auto">
            <BloomMark className="w-6 h-6 text-ink-900" />
          </div>
          <div className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">One last step</div>
          <p className="text-ink-600 text-sm">Connect with Evia to get started</p>
        </div>

        {device === 'mobile' ? (
          <MobileHandoff
            linqPhone={linqPhone}
            tone="light"
            caption={<>Tap below to open Messages. We&rsquo;ve filled in a quick &ldquo;Hey Evia&rdquo; — just hit send.</>}
            ctaLabel="Send to Evia"
            helper={<>Evia will reply on this number. You can keep texting her here whenever you need.</>}
          />
        ) : (
          <QRHandoff
            linqPhone={linqPhone}
            tone="light"
            caption={
              <>
                <p className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-1">Scan to start your conversation</p>
                <p>Point your phone&rsquo;s camera at the code. Your Messages app will open with a note to Evia — just press send.</p>
              </>
            }
            helper={<>Don&rsquo;t have a camera handy? Text the number above with the words <span className="font-semibold">Hey Evia</span>.</>}
          />
        )}

        <p className="text-ink-400 text-xs text-center">
          You&rsquo;ll be able to access the site as soon as Evia receives your message.
        </p>
      </div>
    </div>
  );
};
