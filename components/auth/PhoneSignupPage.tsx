import React, { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

type Role = 'client' | 'caregiver';
type Step = 'role' | 'phone' | 'sent';

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
  const [step, setStep] = useState<Step>(roleParam ? 'phone' : 'role');
  const [countryCode, setCountryCode] = useState('+1');
  const [phone, setPhone] = useState('');

  const digits = phone.replace(/\D/g, '');
  const isValid = digits.length >= 10;

  const linqPhone = import.meta.env.VITE_LINQ_PHONE_NUMBER as string | undefined;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || !linqPhone) return;
    const e164 = normalizeE164(countryCode, digits);
    const body = encodeURIComponent('Hey Cara');
    window.location.href = `sms:${linqPhone}&body=${body}`;
    setStep('sent');
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
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
              onClick={() => { setRole('client'); setStep('phone'); }}
              className="w-full py-4 px-5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 active:bg-white/[0.15] transition text-left"
            >
              <div className="font-semibold text-sm">I need care for someone</div>
              <div className="text-white/40 text-xs mt-0.5">Find caregivers for a loved one</div>
            </button>
            <button
              onClick={() => { setRole('caregiver'); setStep('phone'); }}
              className="w-full py-4 px-5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 active:bg-white/[0.15] transition text-left"
            >
              <div className="font-semibold text-sm">I'm a caregiver</div>
              <div className="text-white/40 text-xs mt-0.5">Find families in your area</div>
            </button>
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
              disabled={!isValid}
              className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
            >
              Text Cara →
            </button>

            <p className="text-white/25 text-xs text-center leading-relaxed">
              Message &amp; data rates may apply. Reply STOP anytime.{' '}
              <Link to="/terms" className="underline underline-offset-2">Terms</Link>
              {' · '}
              <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
            </p>

            {!roleParam && (
              <button
                type="button"
                onClick={() => setStep('role')}
                className="w-full text-sm text-white/30 hover:text-white/50 transition"
              >
                ← Back
              </button>
            )}
          </form>
        )}

        {/* Step: sent */}
        {step === 'sent' && (
          <div className="text-center space-y-4">
            <div className="text-5xl">💬</div>
            <h2 className="text-xl font-semibold">Check your texts ✓</h2>
            <p className="text-white/50 text-sm leading-relaxed">
              Cara will reply in seconds. Your conversation is already waiting.
            </p>
            <button
              onClick={() => {
                const e164 = normalizeE164(countryCode, digits);
                const body = encodeURIComponent('Hey Cara');
                window.location.href = `sms:${linqPhone}&body=${body}`;
              }}
              className="w-full py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition text-sm font-medium"
            >
              Open Messages →
            </button>
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
