import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { submitAccountAction } from '../../services/accountActionQueue';
import { BloomMark } from '../ui/BloomMark';

// Destination of the link emailed to the CURRENT (confirmed) recovery email
// when a change is requested. Clicking it is the old address approving the
// change; the new address then gets its own confirmation link. Mirrors
// VerifyEmailChangePage (the second step) in shape and copy.
type Status = 'approving' | 'done' | 'expired';

export default function ApproveEmailChangePage() {
  const [status, setStatus] = useState<Status>('approving');
  const [sentTo, setSentTo] = useState<string>('');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) { setStatus('expired'); return; }
    submitAccountAction<{ sentTo?: string }>('approve_email_change', { token })
      .then((r) => { setSentTo(r?.sentTo ?? ''); setStatus('done'); })
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

        {status === 'approving' && (
          <p className="text-ink-600 text-sm">Approving the change…</p>
        )}

        {status === 'done' && (
          <div className="space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Change approved</h2>
            <p className="text-ink-600 text-sm">
              We've sent a confirmation link to {sentTo ? <span className="font-medium text-ink-900">{sentTo}</span> : 'the new address'}.
              Your recovery email updates the moment that link is opened. Nothing changes until then.
            </p>
            <Link to="/login" className="inline-block text-ink-600 hover:text-ink-900 text-sm font-medium underline underline-offset-2">
              Sign in
            </Link>
          </div>
        )}

        {status === 'expired' && (
          <div className="space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">This link has expired</h2>
            <p className="text-ink-600 text-sm">
              For your security these links expire after 30 minutes, and each one works once. Go back to Account Settings and start the change again.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
