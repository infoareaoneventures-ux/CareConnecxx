import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { submitAccountAction } from '../../services/accountActionQueue';
import { BloomMark } from '../ui/BloomMark';

// Destination of the link emailed by v1-requestPhoneChange. The email click
// already proved account ownership — the OTP step here only catches a
// mistyped new number, it is not the security boundary.
type Step = 'phone' | 'otp' | 'done' | 'expired';

function formatDisplay(val: string): string {
  const d = val.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function isExpiredError(err: unknown): boolean {
  const e = err as { message?: string };
  return !!e?.message?.includes('invalid or has expired');
}

export default function VerifyPhoneChangePage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [step, setStep] = useState<Step>(token ? 'phone' : 'expired');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const digits = phone.replace(/\D/g, '');
  const isValidPhone = digits.length === 10;

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidPhone || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await submitAccountAction('start_phone_verification', { token, newPhone: `+1${digits}` });
      setStep('otp');
    } catch (err: unknown) {
      if (isExpiredError(err)) { setStep('expired'); return; }
      const e = err as { message?: string };
      setError(e?.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await submitAccountAction('confirm_phone_change', { token, code: code.trim() });
      setStep('done');
    } catch (err: unknown) {
      if (isExpiredError(err)) { setStep('expired'); return; }
      const e = err as { message?: string };
      setError(e?.message || 'Incorrect code. Please try again.');
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

        {step === 'expired' && (
          <div className="text-center space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">This link has expired</h2>
            <p className="text-ink-600 text-sm">
              For your security these links expire after 30 minutes. Request a new one to continue.
            </p>
            <Link to="/client/forgot-password" className="inline-block text-ink-600 hover:text-ink-900 text-sm font-medium underline underline-offset-2">
              Request a new link
            </Link>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center space-y-4">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Phone number updated</h2>
            <p className="text-ink-600 text-sm">
              You can now sign in with your new number. We've also texted and emailed a confirmation, just in case.
            </p>
            <Link to="/login" className="inline-block text-ink-600 hover:text-ink-900 text-sm font-medium underline underline-offset-2">
              Sign in
            </Link>
          </div>
        )}

        {step === 'phone' && (
          <form onSubmit={handleSendCode} className="space-y-5">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">What's your new number?</h2>
            <input
              type="tel"
              inputMode="numeric"
              autoFocus
              placeholder="(555) 555-5555"
              value={phone}
              onChange={e => setPhone(formatDisplay(e.target.value))}
              className="w-full bg-white border hairline rounded-xl px-4 py-3.5 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-base"
            />
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={!isValidPhone || submitting}
              className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
            >
              {submitting ? 'Sending…' : 'Send code →'}
            </button>
          </form>
        )}

        {step === 'otp' && (
          <form onSubmit={handleConfirm} className="space-y-5">
            <div className="text-center space-y-1">
              <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Enter your code</h2>
              <p className="text-ink-600 text-sm">Sent to +1 {phone}</p>
            </div>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              placeholder="6-digit code"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full bg-white border hairline rounded-xl px-4 py-3.5 text-center text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-base tracking-widest"
            />
            {error && <p className="text-red-600 text-sm text-center">{error}</p>}
            <button
              type="submit"
              disabled={code.length !== 6 || submitting}
              className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
            >
              {submitting ? 'Confirming…' : 'Confirm'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
