import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { functions } from '../../lib/firebase';

const LINQ_PHONE = import.meta.env.VITE_LINQ_PHONE_NUMBER || '';

const MESSAGES: Record<string, { title: string; body: string }> = {
  payment:           { title: 'Payment set up!',        body: "Evia is already searching for caregivers. You'll hear from her shortly." },
  identity:          { title: 'Identity verified!',     body: "You're all set. Evia will continue your onboarding." },
  photo_upload:      { title: 'Photo uploaded!',        body: 'Your profile photo is saved. Almost done!' },
  doc_upload:        { title: 'Document uploaded!',     body: 'Certification saved. Moving to your next step.' },
  background_check:  { title: 'Background check started!', body: "Results usually arrive in 1–3 days. Evia will text you." },
  stripe_connect:    { title: 'Payout account ready!', body: "You're all set to get paid. Evia will text you next steps." },
  quick_confirm:     { title: 'Confirmed!',             body: 'Your request has been confirmed.' },
  interview_confirm: { title: 'Interview confirmed!',   body: "Evia will send you the video link 30 minutes before." },
  booking_confirm:   { title: 'Booked!',                body: "Your visits are confirmed. Evia will send details." },
};

// stripe_connect is verified server-side before we celebrate: Stripe fires the
// return_url on flow EXIT (completed or abandoned) and bounces dead single-use
// links to the refresh flow, so landing here proves nothing. markTaskComplete
// checks the account's real charges/payouts flags and only advances when true.
type StripeVerifyState = 'checking' | 'ok' | 'incomplete' | 'unverified' | 'expired';

const STRIPE_STATE_COPY: Record<Exclude<StripeVerifyState, 'ok'>, { title: string; body: string }> = {
  checking:   { title: 'Confirming with Stripe…', body: 'One moment — checking that your payout account is fully set up.' },
  incomplete: { title: 'One more step for payouts', body: "Your Stripe payout setup isn't finished yet — tap below to pick up right where you left off." },
  unverified: { title: "We're confirming your setup", body: "We couldn't confirm your payout setup just yet. Evia will text you as soon as Stripe confirms — no action needed." },
  expired:    { title: 'This link has expired', body: "Reply to Evia's text and ask for your payout link — she'll send you a fresh one right away." },
};

export default function GenericSuccessPage() {
  const [params]   = useSearchParams();
  const task        = params.get('task') ?? 'payment';
  const token       = params.get('t')    ?? '';
  const isStripeConnect = task === 'stripe_connect';
  const [count, setCount] = useState(3);
  const [stripeState, setStripeState] = useState<StripeVerifyState>(
    isStripeConnect ? (token ? 'checking' : 'expired') : 'ok'
  );
  const [finishUrl, setFinishUrl] = useState<string | null>(null);
  const msg = MESSAGES[task] ?? { title: 'All done!', body: 'Returning to your conversation.' };

  useEffect(() => {
    if (!token || !functions) return;
    const markDone = functions.httpsCallable('v1-markTaskComplete');
    if (isStripeConnect) {
      // Verified path: the callable checks the Stripe account's real state and
      // returns ok / incomplete (+ a fresh onboarding link) / unverified.
      markDone({ token, taskId: '' })
        .then((res: any) => {
          const status = res?.data?.status;
          if (status === 'ok') {
            setStripeState('ok');
          } else if (status === 'incomplete') {
            setFinishUrl(res?.data?.finishUrl ?? null);
            setStripeState('incomplete');
          } else {
            setStripeState('unverified');
          }
        })
        .catch((err: any) => {
          const code = String(err?.code ?? '');
          setStripeState(code.includes('unauthenticated') ? 'expired' : 'unverified');
          console.warn('GenericSuccessPage stripe_connect verification failed:', err);
        });
      return;
    }
    // Best-effort only: for the other tasks that land here (payment, identity,
    // membership) the AUTHORITATIVE advancement is the Stripe/Checkr webhook, so
    // a failure here (e.g. an expired token) does NOT mean the action failed —
    // we must not show a false negative. We log it for observability instead.
    markDone({ token, taskId: '' }).catch((err) => {
      console.warn('GenericSuccessPage markTaskComplete fallback failed (webhook is authoritative):', err);
    });
  }, [token, isStripeConnect]);

  const showSuccess = stripeState === 'ok';

  useEffect(() => {
    if (!showSuccess) return;
    if (count <= 0) {
      if (LINQ_PHONE) window.location.href = `sms:${LINQ_PHONE}`;
      return;
    }
    const t = setTimeout(() => setCount(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count, showSuccess]);

  const stateCopy = showSuccess ? msg : STRIPE_STATE_COPY[stripeState as Exclude<StripeVerifyState, 'ok'>];
  const isChecking = stripeState === 'checking';

  return (
    <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center px-6 text-center gap-8">
      {/* Status icon */}
      <div className="relative">
        {showSuccess ? (
          <>
            <div className="w-20 h-20 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
              <svg className="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            {/* Countdown ring */}
            <svg className="absolute inset-0 w-20 h-20 -rotate-90" viewBox="0 0 80 80">
              <circle
                cx="40" cy="40" r="37"
                fill="none"
                stroke="#16a34a"
                strokeWidth="3"
                strokeDasharray={`${(count / 3) * 232} 232`}
                className="transition-all duration-1000"
                opacity="0.4"
              />
            </svg>
          </>
        ) : isChecking ? (
          <div className="w-20 h-20 rounded-full bg-paper-100 border border-ink-200 flex items-center justify-center animate-pulse">
            <svg className="w-10 h-10 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </div>
        ) : (
          <div className="w-20 h-20 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center">
            <svg className="w-10 h-10 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-8.02 13.89A1.5 1.5 0 003.57 20h16.86a1.5 1.5 0 001.3-2.25L13.71 3.86a1.5 1.5 0 00-2.42 0z" />
            </svg>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h1 className="font-display text-ink-900 text-2xl font-semibold tracking-[-0.02em]">{stateCopy.title}</h1>
        <p className="text-ink-600 text-base max-w-xs mx-auto leading-relaxed">{stateCopy.body}</p>
      </div>

      {stripeState === 'incomplete' && finishUrl && (
        <a
          href={finishUrl}
          className="bg-ink-900 text-paper-50 font-medium text-base px-6 py-3 rounded-full min-h-[44px] flex items-center"
        >
          Finish payout setup
        </a>
      )}
      {stripeState === 'incomplete' && !finishUrl && (
        <p className="text-ink-600 text-sm max-w-xs mx-auto">
          Reply to Evia's text and she'll send you a fresh setup link.
        </p>
      )}

      {showSuccess && (
        <p className="text-ink-400 text-sm">
          Returning to Evia in {count}…
        </p>
      )}

      <a
        href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
        className="text-ink-600 hover:text-ink-900 font-medium text-sm underline underline-offset-2 min-h-[44px] flex items-center"
      >
        Tap here to return to your conversation
      </a>
    </div>
  );
}
