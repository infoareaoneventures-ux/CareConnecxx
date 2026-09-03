import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { submitAccountAction } from '../../services/accountActionQueue';
import { BloomMark } from '../ui/BloomMark';

// Destination of the link emailed by the request_email_change flow. Clicking
// it IS the proof of owning the new inbox — no further input needed here.
type Status = 'confirming' | 'done' | 'expired';

export default function VerifyEmailChangePage() {
  const [status, setStatus] = useState<Status>('confirming');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) { setStatus('expired'); return; }
    submitAccountAction('confirm_email_change', { token })
      .then(() => setStatus('done'))
      .catch(() => setStatus('expired'));
  }, []);

  return (
    <div className="min-h-screen bg-paper-50 text-ink-900 flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-paper-100 border hairline flex items-center justify-center mx-auto">
            <BloomMark className="w-6 h-6 text-ink-900" />
          </div>
          <div className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</div>
        </div>

        {status === 'confirming' && (
          <p className="text-ink-600 text-sm">Confirming your email…</p>
        )}

        {status === 'done' && (
          <div className="space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Email confirmed</h2>
            <p className="text-ink-600 text-sm">Your Evia account's email has been updated.</p>
            <Link to="/login" className="inline-block text-ink-600 hover:text-ink-900 text-sm font-medium underline underline-offset-2">
              Sign in
            </Link>
          </div>
        )}

        {status === 'expired' && (
          <div className="space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">This link has expired</h2>
            <p className="text-ink-600 text-sm">
              For your security these links expire after 30 minutes. Go back to Account Settings and try again.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
