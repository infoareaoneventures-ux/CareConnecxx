import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { functions } from '../../lib/firebase';
import { BloomMark } from '../ui/BloomMark';

// "Trouble signing in?" destination — mounted at both /client/forgot-password
// and /caregiver/forgot-password (login here is phone-OTP only for both
// roles, and the recovery flow behind this page checks users/ and
// caregivers/ by email either way, so one page covers both).
//
// Always shows the same "check your email" outcome regardless of whether the
// email matched an account — v1-requestPhoneChange never reveals that.
export default function RequestAccountRecoveryPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      if (!functions) throw new Error('Not connected');
      const fn = functions.httpsCallable('v1-requestPhoneChange');
      await fn({ email: email.trim() });
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper-50 text-ink-900 flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-paper-100 border hairline flex items-center justify-center mx-auto">
            <BloomMark className="w-6 h-6 text-ink-900" />
          </div>
          <div className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</div>
        </div>

        {sent ? (
          <div className="text-center space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Check your email</h2>
            <p className="text-ink-600 text-sm">
              If that email matches an Evia account, we just sent a link to change the phone number on it. The link
              expires in 30 minutes.
            </p>
            <Link to="/login" className="inline-block text-ink-600 hover:text-ink-900 text-sm font-medium underline underline-offset-2">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="text-center space-y-1">
              <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Trouble signing in?</h2>
              <p className="text-ink-600 text-sm">
                Enter the email on your account and we'll send you a link to change your phone number.
              </p>
            </div>

            <input
              type="email"
              autoFocus
              required
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-white border hairline rounded-xl px-4 py-3.5 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-base"
            />

            {error && <p className="text-red-600 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={!email.trim() || submitting}
              className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
            >
              {submitting ? 'Sending…' : 'Send me a link'}
            </button>

            <p className="text-ink-400 text-xs text-center">
              <Link to="/login" className="text-ink-600 hover:text-ink-900 font-medium">← Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
