import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { functions } from '../../lib/firebase';

const LINQ_PHONE = import.meta.env.VITE_LINQ_PHONE_NUMBER || '';

const MESSAGES: Record<string, { title: string; body: string }> = {
  payment:           { title: 'Payment set up!',        body: "Cara is already searching for caregivers. You'll hear from her shortly." },
  identity:          { title: 'Identity verified!',     body: "You're all set. Cara will continue your onboarding." },
  photo_upload:      { title: 'Photo uploaded!',        body: 'Your profile photo is saved. Almost done!' },
  doc_upload:        { title: 'Document uploaded!',     body: 'Certification saved. Moving to your next step.' },
  background_check:  { title: 'Background check started!', body: "Results usually arrive in 1–3 days. Cara will text you." },
  stripe_connect:    { title: 'Payout account ready!', body: "You're all set to get paid. Cara will text you next steps." },
  quick_confirm:     { title: 'Confirmed!',             body: 'Your request has been confirmed.' },
  interview_confirm: { title: 'Interview confirmed!',   body: "Cara will send you the video link 30 minutes before." },
  booking_confirm:   { title: 'Booked!',                body: "Your visits are confirmed. Cara will send details." },
};

export default function GenericSuccessPage() {
  const [params]   = useSearchParams();
  const task        = params.get('task') ?? 'payment';
  const token       = params.get('t')    ?? '';
  const [count, setCount] = useState(3);
  const msg = MESSAGES[task] ?? { title: 'All done!', body: 'Returning to your conversation.' };

  useEffect(() => {
    if (!token || !functions) return;
    const markDone = functions.httpsCallable('v1-markTaskComplete');
    // Best-effort only: for the tasks that land here (payment, identity, membership,
    // stripe_connect) the AUTHORITATIVE advancement is the Stripe/Checkr webhook, so a
    // failure here (e.g. an expired token) does NOT mean the action failed — we must
    // not show a false negative. We log it for observability instead of swallowing.
    markDone({ token, taskId: '' }).catch((err) => {
      console.warn('GenericSuccessPage markTaskComplete fallback failed (webhook is authoritative):', err);
    });
  }, [token]);

  useEffect(() => {
    if (count <= 0) {
      if (LINQ_PHONE) window.location.href = `sms:${LINQ_PHONE}`;
      return;
    }
    const t = setTimeout(() => setCount(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center gap-8">
      {/* Check icon */}
      <div className="relative">
        <div className="w-20 h-20 rounded-full bg-green-500/15 border border-green-500/25 flex items-center justify-center">
          <svg className="w-10 h-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
      </div>

      <div className="space-y-2">
        <h1 className="text-white text-2xl font-bold">{msg.title}</h1>
        <p className="text-white/60 text-base max-w-xs mx-auto leading-relaxed">{msg.body}</p>
      </div>

      <p className="text-white/30 text-sm">
        Returning to Cara in {count}…
      </p>

      <a
        href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
        className="text-blue-400 text-sm underline underline-offset-2"
      >
        Tap here to return to your conversation
      </a>
    </div>
  );
}
