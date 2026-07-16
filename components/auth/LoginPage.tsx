import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { auth, getOrCreateRecaptchaVerifier, clearRecaptchaVerifier } from '../../lib/firebase';
import { dbService } from '../../services/api';
import type firebase from 'firebase/compat/app';
import { BloomMark } from '../ui/BloomMark';

type Step = 'phone' | 'otp';

const RECAPTCHA_CONTAINER = 'login-recaptcha';

function formatDisplay(val: string): string {
  const d = val.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// Raw Firebase codes leak implementation detail ("auth/too-many-requests");
// map the ones users actually hit to plain language.
function friendlyAuthError(err: any): string {
  switch (err?.code) {
    case 'auth/too-many-requests':        return 'Too many attempts — wait a few minutes and try again.';
    case 'auth/invalid-phone-number':     return "That phone number doesn't look right. Check it and try again.";
    case 'auth/network-request-failed':   return 'Network hiccup — check your connection and try again.';
    case 'auth/code-expired':             return 'That code expired. Tap "Resend code" to get a new one.';
    case 'auth/invalid-verification-code': return 'Incorrect code. Please try again.';
    default: return 'Something went wrong. Please try again.';
  }
}

export const AuthLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('phone');
  const [countryCode, setCountryCode] = useState('+1');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [confirmation, setConfirmation] = useState<firebase.auth.ConfirmationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendCountdown, setResendCountdown] = useState(0);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  const digits = phone.replace(/\D/g, '');
  const isValid = digits.length >= 10;

  // The verifier is created lazily per send and cleared afterwards — a
  // consumed invisible-reCAPTCHA token can't be reused, so each send (and
  // each resend) gets a fresh one.
  useEffect(() => () => clearRecaptchaVerifier(RECAPTCHA_CONTAINER), []);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCountdown]);

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isValid || !auth) return;
    setError('');
    setLoading(true);
    try {
      const verifier = getOrCreateRecaptchaVerifier(RECAPTCHA_CONTAINER, { size: 'invisible' });
      const result = await auth.signInWithPhoneNumber(
        `${countryCode}${digits}`,
        verifier
      );
      setConfirmation(result);
      setStep('otp');
      setResendCountdown(60);
      otpRefs.current[0]?.focus();
    } catch (err: any) {
      setError(friendlyAuthError(err));
    } finally {
      // Fresh verifier next time either way — the token is single-use.
      clearRecaptchaVerifier(RECAPTCHA_CONTAINER);
      setLoading(false);
    }
  };

  const handleOtpChange = (idx: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...otp];
    next[idx] = val.slice(-1);
    setOtp(next);
    if (val && idx < 5) otpRefs.current[idx + 1]?.focus();
    if (next.every(d => d) && next.join('').length === 6) confirmOtp(next.join(''));
  };

  const handleOtpKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) otpRefs.current[idx - 1]?.focus();
  };

  const confirmOtp = async (code: string) => {
    if (!confirmation) return;
    setError('');
    setLoading(true);
    try {
      const cred = await confirmation.confirm(code);
      // Role-aware landing on the Chat tab — chat is the home surface
      // (tomo-style). A brand-new account with no profile also lands on chat,
      // which renders the "Meet Evia" get-set-up state instead of bouncing
      // straight into the signup wizard.
      const uid = cred?.user?.uid ?? auth?.currentUser?.uid;
      let dest = '/client/chat';
      if (uid) {
        const profile = await dbService.getUser(uid).catch(() => null);
        // AdminUser types userType as client|caregiver; admin lives in the raw doc.
        const userType = profile?.userType as string | undefined;
        if (userType === 'caregiver') dest = '/caregiver/chat';
        else if (userType === 'admin') dest = '/admin';
      }
      navigate(dest, { replace: true });
    } catch (err: any) {
      setError(friendlyAuthError(err));
      setOtp(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper-50 text-ink-900 flex flex-col items-center justify-center px-6">
      {/* RecaptchaVerifier needs a stable DOM target; created per send. */}
      <div id={RECAPTCHA_CONTAINER} />
      <div className="w-full max-w-sm space-y-8">

        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-paper-100 border hairline flex items-center justify-center mx-auto">
            <BloomMark className="w-6 h-6 text-ink-900" />
          </div>
          <div className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</div>
          <p className="text-ink-600 text-sm">Welcome back</p>
        </div>

        {/* Step: phone */}
        {step === 'phone' && (
          <form onSubmit={sendCode} className="space-y-5">
            <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">What's your mobile number?</h2>

            <div className="flex gap-2">
              <select
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                className="bg-white border hairline rounded-xl px-3 py-3.5 text-base text-ink-900 focus:outline-none focus:border-ink-400 flex-shrink-0"
              >
                <option value="+1">🇺🇸 +1</option>
                <option value="+44">🇬🇧 +44</option>
                <option value="+52">🇲🇽 +52</option>
              </select>
              <input
                type="tel"
                inputMode="numeric"
                autoFocus
                placeholder="(555) 555-5555"
                value={phone}
                onChange={e => setPhone(formatDisplay(e.target.value))}
                className="flex-1 bg-white border hairline rounded-xl px-4 py-3.5 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-base"
              />
            </div>

            {error && <p className="text-red-600 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={!isValid || loading}
              className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
            >
              {loading ? 'Sending…' : 'Send code →'}
            </button>

            <p className="text-ink-400 text-xs text-center">
              New to Evia?{' '}
              <Link to="/start" className="text-ink-600 hover:text-ink-900 font-medium">Get started →</Link>
            </p>
          </form>
        )}

        {/* Step: OTP */}
        {step === 'otp' && (
          <div className="space-y-6">
            <div className="text-center space-y-1">
              <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Enter your code</h2>
              <p className="text-ink-600 text-sm">Sent to {countryCode} {phone}</p>
            </div>

            <div className="flex gap-2 justify-center">
              {otp.map((digit, idx) => (
                <input
                  key={idx}
                  ref={el => { otpRefs.current[idx] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={e => handleOtpChange(idx, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(idx, e)}
                  autoFocus={idx === 0}
                  className="w-12 h-14 text-center text-xl font-semibold bg-white border hairline rounded-xl text-ink-900 focus:outline-none focus:border-ink-400"
                />
              ))}
            </div>

            {error && <p className="text-red-600 text-sm text-center">{error}</p>}

            {loading && (
              <p className="text-ink-600 text-sm text-center">Verifying…</p>
            )}

            <button
              type="button"
              disabled={resendCountdown > 0 || loading}
              onClick={() => { setOtp(['', '', '', '', '', '']); sendCode(); }}
              className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium disabled:cursor-not-allowed transition"
            >
              {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AuthLoginPage;
