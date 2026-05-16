import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { auth } from '../../lib/firebase';
import firebase from 'firebase/compat/app';

type Step = 'phone' | 'otp';

function formatDisplay(val: string): string {
  const d = val.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
  const recaptchaRef = useRef<HTMLDivElement>(null);
  const recaptchaVerifier = useRef<firebase.auth.RecaptchaVerifier | null>(null);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  const digits = phone.replace(/\D/g, '');
  const isValid = digits.length >= 10;

  useEffect(() => {
    if (!auth) return;
    recaptchaVerifier.current = new firebase.auth.RecaptchaVerifier(
      recaptchaRef.current!,
      { size: 'invisible', callback: () => {} },
      auth.app
    );
    return () => { recaptchaVerifier.current?.clear(); };
  }, []);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCountdown]);

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isValid || !auth || !recaptchaVerifier.current) return;
    setError('');
    setLoading(true);
    try {
      const result = await auth.signInWithPhoneNumber(
        `${countryCode}${digits}`,
        recaptchaVerifier.current
      );
      setConfirmation(result);
      setStep('otp');
      setResendCountdown(60);
      otpRefs.current[0]?.focus();
    } catch (err: any) {
      setError(err.message ?? 'Failed to send code. Try again.');
      recaptchaVerifier.current?.clear();
    } finally {
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
      await confirmation.confirm(code);
      navigate('/dashboard');
    } catch {
      setError('Incorrect code. Please try again.');
      setOtp(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      <div ref={recaptchaRef} />
      <div className="w-full max-w-sm space-y-8">

        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto">
            <span className="text-white font-bold text-lg">C</span>
          </div>
          <div className="text-2xl font-bold tracking-tight">Cara</div>
          <p className="text-white/40 text-sm">Welcome back</p>
        </div>

        {/* Step: phone */}
        {step === 'phone' && (
          <form onSubmit={sendCode} className="space-y-5">
            <h2 className="text-xl font-semibold text-center">What's your mobile number?</h2>

            <div className="flex gap-2">
              <select
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-3.5 text-sm text-white focus:outline-none focus:border-blue-500 flex-shrink-0"
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
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3.5 text-white placeholder-white/20 focus:outline-none focus:border-blue-500 text-sm"
              />
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={!isValid || loading}
              className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
            >
              {loading ? 'Sending…' : 'Send code →'}
            </button>

            <p className="text-white/25 text-xs text-center">
              New to Cara?{' '}
              <Link to="/start" className="text-blue-400 hover:text-blue-300">Get started →</Link>
            </p>
          </form>
        )}

        {/* Step: OTP */}
        {step === 'otp' && (
          <div className="space-y-6">
            <div className="text-center space-y-1">
              <h2 className="text-xl font-semibold">Enter your code</h2>
              <p className="text-white/40 text-sm">Sent to {countryCode} {phone}</p>
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
                  className="w-12 h-14 text-center text-xl font-semibold bg-white/5 border border-white/10 rounded-xl text-white focus:outline-none focus:border-blue-500"
                />
              ))}
            </div>

            {error && <p className="text-red-400 text-sm text-center">{error}</p>}

            {loading && (
              <p className="text-white/40 text-sm text-center">Verifying…</p>
            )}

            <button
              type="button"
              disabled={resendCountdown > 0 || loading}
              onClick={() => { setOtp(['', '', '', '', '', '']); setStep('phone'); sendCode(); }}
              className="w-full text-sm text-white/30 hover:text-white/50 disabled:cursor-not-allowed transition"
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
