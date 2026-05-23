import React, { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';

type Role = 'client' | 'caregiver';
type Step = 'role' | 'consent' | 'phone' | 'sent';

function normalizeE164(countryCode: string, digits: string): string {
  return `${countryCode}${digits}`;
}

function formatDisplay(val: string): string {
  const d = val.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export const PhoneSignupPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const roleParam = searchParams.get('role') as Role | null;

  const [role, setRole] = useState<Role | null>(roleParam);
  // If role came in via URL, jump straight to consent; otherwise show role picker first
  const [step, setStep] = useState<Step>(roleParam ? 'consent' : 'role');
  const [agreed, setAgreed] = useState(false);
  const [countryCode, setCountryCode] = useState('+1');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, '');
  const isValid = digits.length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || loading) return;
    setLoading(true);
    setError(null);
    try {
      const e164 = normalizeE164(countryCode, digits);
      const initiateCara = httpsCallable(getFunctions(), 'v1-initiateCara');
      await initiateCara({ phone: e164, role: role ?? 'client' });
      setStep('sent');
    } catch {
      setError("Couldn't reach Cara right now — please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm space-y-8">

        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto">
            <span className="text-white font-bold text-lg">C</span>
          </div>
          <div className="text-2xl font-bold tracking-tight">Cara</div>
          <p className="text-white/40 text-sm">Your AI care assistant</p>
        </div>

        {/* Step: role picker */}
        {step === 'role' && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-center">What brings you here?</h2>
            <button
              onClick={() => { setRole('client'); setStep('consent'); }}
              className="w-full py-4 px-5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 active:bg-white/[0.15] transition text-left"
            >
              <div className="font-semibold text-sm">I need care for someone</div>
              <div className="text-white/40 text-xs mt-0.5">Find caregivers for a loved one</div>
            </button>
            <button
              onClick={() => { setRole('caregiver'); setStep('consent'); }}
              className="w-full py-4 px-5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 active:bg-white/[0.15] transition text-left"
            >
              <div className="font-semibold text-sm">I'm a caregiver</div>
              <div className="text-white/40 text-xs mt-0.5">Find families in your area</div>
            </button>
          </div>
        )}

        {/* Step: consent / messaging disclosure */}
        {step === 'consent' && (
          <div className="space-y-5">
            <div className="space-y-1 text-center">
              <h2 className="text-xl font-semibold">Welcome to Cara</h2>
              <p className="text-white/40 text-sm">
                {role === 'caregiver'
                  ? 'Cara communicates with you over iMessage, RCS, or SMS.'
                  : 'On non-Apple devices, Cara communicates with you over RCS or SMS.'}
              </p>
            </div>

            {/* Scrollable disclosure */}
            <div className="h-52 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 px-4 py-4 space-y-4 text-sm leading-relaxed scrollbar-thin scrollbar-thumb-white/10">
              <div>
                <span className="font-semibold text-white">What will you receive?</span>{' '}
                <span className="text-white/60">
                  Care updates, caregiver matches, appointment reminders, visit summaries, and check-ins from your care team.
                </span>
              </div>
              <div>
                <span className="font-semibold text-white">How often?</span>{' '}
                <span className="text-white/60">
                  Only when something relevant happens. We never send unsolicited messages.
                </span>
              </div>
              <div>
                <span className="font-semibold text-white/50">Any costs?</span>{' '}
                <span className="text-white/40">
                  Standard message and data rates from your carrier may apply.
                </span>
              </div>
              <div>
                <span className="font-semibold text-white">Need help?</span>{' '}
                <span className="text-white/60">
                  Reply HELP to any message, or email{' '}
                  <span className="text-blue-400">support@careconnex.com</span>.
                </span>
              </div>
              <div>
                <span className="font-semibold text-white">Want to stop?</span>{' '}
                <span className="text-white/60">
                  Reply STOP anytime. You can change your mind later too.
                </span>
              </div>
              <div className="pt-1 border-t border-white/10 text-white/30 text-xs">
                <Link to="/terms" className="underline underline-offset-2 hover:text-white/50">Terms</Link>
                {' · '}
                <Link to="/privacy" className="underline underline-offset-2 hover:text-white/50">Privacy</Link>
              </div>
            </div>

            {/* Checkbox */}
            <label className="flex items-center gap-3 cursor-pointer select-none rounded-2xl border border-white/10 bg-white/5 px-4 py-3.5 hover:bg-white/[0.08] transition">
              <input
                type="checkbox"
                checked={agreed}
                onChange={e => setAgreed(e.target.checked)}
                className="w-4 h-4 rounded accent-blue-500 flex-shrink-0"
              />
              <span className="text-sm text-white/80">I agree to the terms above</span>
            </label>

            <button
              onClick={() => setStep('phone')}
              disabled={!agreed}
              className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
            >
              Continue
            </button>

            {!roleParam && (
              <button
                type="button"
                onClick={() => setStep('role')}
                className="w-full text-sm text-white/30 hover:text-white/50 transition"
              >
                ← Back
              </button>
            )}
          </div>
        )}

        {/* Step: phone entry */}
        {step === 'phone' && (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-center">What's your mobile number?</h2>
              <p className="text-white/40 text-sm text-center">
                {role === 'caregiver' ? "We'll connect you with local families." : "We'll find caregivers near you."}
              </p>
            </div>

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

            <button
              type="submit"
              disabled={!isValid || loading}
              className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
            >
              {loading ? 'Connecting…' : 'Continue with Phone →'}
            </button>

            {error && (
              <p className="text-red-400 text-xs text-center">{error}</p>
            )}

            <button
              type="button"
              onClick={() => setStep('consent')}
              className="w-full text-sm text-white/30 hover:text-white/50 transition"
            >
              ← Back
            </button>
          </form>
        )}

        {/* Step: sent */}
        {step === 'sent' && (
          <div className="text-center space-y-4">
            <div className="text-5xl">💬</div>
            <h2 className="text-xl font-semibold">Cara is on her way ✓</h2>
            <p className="text-white/50 text-sm leading-relaxed">
              You'll receive a text from Cara in the next few seconds. Reply to start your conversation.
            </p>
            <p className="text-white/25 text-xs">
              Already have an account?{' '}
              <Link to="/login" className="text-blue-400 hover:text-blue-300">Log in →</Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PhoneSignupPage;
