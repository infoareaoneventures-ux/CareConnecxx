import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import { auth, functions, getOrCreateRecaptchaVerifier, clearRecaptchaVerifier } from '../../../lib/firebase';
import { useDeviceClass } from '../../../hooks/useDeviceClass';
import { useOnboardingSession } from '../../../hooks/useOnboardingSession';
import { QRHandoff } from './QRHandoff';
import { MobileHandoff } from './MobileHandoff';
import { sanitizeName } from '../../../utils/sanitize';

export type OnboardingRole = 'client' | 'caregiver';
type Step = 'role' | 'consent' | 'name' | 'phone' | 'verify' | 'handoff' | 'connected';

interface Props {
  initialRole?: OnboardingRole | null;
  referralId?: string | null;
}

const RECAPTCHA_CONTAINER = 'careconnex-recaptcha-container';
const SUPPORT_PHONE_DISPLAY = '(800) 555-0199';
const SUPPORT_PHONE_HREF = 'tel:+18005550199';
const CONSENT_VERSION = 'v1.0';
const RESEND_COOLDOWN_SECONDS = 60;

function normalizeE164(countryCode: string, digits: string): string {
  return `${countryCode}${digits}`;
}

function formatDisplay(val: string): string {
  const d = val.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export const OnboardingFlow: React.FC<Props> = ({ initialRole, referralId }) => {
  const device = useDeviceClass();
  const [role, setRole] = useState<OnboardingRole | null>(initialRole ?? null);
  const [step, setStep] = useState<Step>(initialRole ? 'consent' : 'role');
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState('');
  const [countryCode, setCountryCode] = useState('+1');
  const [phoneInput, setPhoneInput] = useState('');
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linqPhone, setLinqPhone] = useState<string | null>(null);
  const confirmationRef = useRef<firebase.auth.ConfirmationResult | null>(null);

  const sessionState = useOnboardingSession(step === 'handoff' || step === 'connected' ? e164 : null);

  // Tone: family/client = warm light; caregiver = sleek dark
  const tone: 'dark' | 'light' = role === 'caregiver' ? 'dark' : 'light';

  // Auto-flip to "connected" the moment the LINQ webhook stamps the bridge doc.
  useEffect(() => {
    if (step === 'handoff' && sessionState.status === 'connected') {
      setStep('connected');
    }
  }, [step, sessionState.status]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // Cleanup recaptcha on unmount so revisiting /start doesn't accumulate verifiers.
  useEffect(() => () => clearRecaptchaVerifier(RECAPTCHA_CONTAINER), []);

  const digits = phoneInput.replace(/\D/g, '');
  const isValidPhone = digits.length === 10;

  // ─── Step actions ───────────────────────────────────────────────────────────

  const sendCode = async (resending = false) => {
    if (!isValidPhone || loading || !auth) return;
    setLoading(true);
    setError(null);
    try {
      const phone = normalizeE164(countryCode, digits);
      const verifier = getOrCreateRecaptchaVerifier(RECAPTCHA_CONTAINER, { size: 'invisible' });
      const result = await auth.signInWithPhoneNumber(phone, verifier);
      confirmationRef.current = result;
      setE164(phone);
      setStep('verify');
      setResendIn(RESEND_COOLDOWN_SECONDS);
      if (resending) setCode('');
    } catch (err: any) {
      const msg = err?.code === 'auth/invalid-phone-number'
        ? "That number doesn't look right — double-check the area code."
        : err?.code === 'auth/too-many-requests'
        ? "Too many tries. Wait a few minutes and try again."
        : "We couldn't send the code. Please try again.";
      setError(msg);
      // Reset recaptcha so a retry doesn't fail with "captcha already solved"
      clearRecaptchaVerifier(RECAPTCHA_CONTAINER);
    } finally {
      setLoading(false);
    }
  };

  const confirmCode = async () => {
    if (!confirmationRef.current || code.length !== 6 || loading || !functions || !role || !e164) return;
    setLoading(true);
    setError(null);
    try {
      await confirmationRef.current.confirm(code);
      // Phone Auth succeeded — caller now has a Firebase token bound to this phone.
      const create = functions.httpsCallable('v1-createWebOnboardingSession');
      const cleanName = sanitizeName(name).slice(0, 80);
      const resp = await create({ phone: e164, role, name: cleanName, consentText: CONSENT_VERSION, referralId });
      const data = resp.data as { linqPhone?: string };
      if (!data?.linqPhone) throw new Error('No LINQ number returned');
      setLinqPhone(data.linqPhone);
      setStep('handoff');
    } catch (err: any) {
      const msg = err?.code === 'auth/invalid-verification-code' || err?.code === 'auth/code-expired'
        ? "That code didn't match. Double-check the digits — or tap Resend."
        : "Something went wrong verifying your code. Try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ─── UI ─────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* RecaptchaVerifier needs a stable DOM target; rendered once and reused. */}
      <div id={RECAPTCHA_CONTAINER} />

      {tone === 'dark' ? (
        <CaregiverShell>
          {renderStep()}
        </CaregiverShell>
      ) : (
        <FamilyShell role={role} step={step}>
          {renderStep()}
        </FamilyShell>
      )}
    </>
  );

  function renderStep(): React.ReactNode {
    if (step === 'role') {
      return (
        <RolePicker
          tone={tone}
          onPick={(r) => { setRole(r); setStep('consent'); }}
        />
      );
    }
    if (step === 'consent') {
      return (
        <ConsentScreen
          role={role!}
          tone={tone}
          agreed={agreed}
          setAgreed={setAgreed}
          onBack={initialRole ? undefined : () => setStep('role')}
          onContinue={() => setStep('name')}
        />
      );
    }
    if (step === 'name') {
      return (
        <NameEntry
          role={role!}
          tone={tone}
          name={name}
          setName={setName}
          onSubmit={() => setStep('phone')}
          onBack={() => setStep('consent')}
        />
      );
    }
    if (step === 'phone') {
      return (
        <PhoneEntry
          role={role!}
          tone={tone}
          countryCode={countryCode}
          setCountryCode={setCountryCode}
          phone={phoneInput}
          setPhone={(v) => setPhoneInput(formatDisplay(v))}
          isValid={isValidPhone}
          loading={loading}
          error={error}
          onSubmit={() => sendCode(false)}
          onBack={() => setStep('name')}
        />
      );
    }
    if (step === 'verify') {
      return (
        <CodeEntry
          tone={tone}
          phone={e164!}
          code={code}
          setCode={setCode}
          loading={loading}
          error={error}
          resendIn={resendIn}
          onConfirm={confirmCode}
          onResend={() => sendCode(true)}
          onChangeNumber={() => { setStep('phone'); setError(null); }}
        />
      );
    }
    if (step === 'handoff') {
      return (
        <HandoffScreen
          role={role!}
          tone={tone}
          device={device}
          linqPhone={linqPhone!}
        />
      );
    }
    // connected
    return <ConnectedScreen role={role!} tone={tone} />;
  }
};

// ============================================================================
// SHELL COMPONENTS — provide the visual frame for each mode
// ============================================================================

const CaregiverShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6 py-10">
    <div className="w-full max-w-sm space-y-8">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto">
          <span className="text-white font-bold text-lg">C</span>
        </div>
        <div className="text-2xl font-bold tracking-tight">Cara</div>
        <p className="text-white/40 text-sm">Your care coordinator</p>
      </div>
      {children}
    </div>
  </div>
);

const FamilyShell: React.FC<{ role: OnboardingRole | null; step: Step; children: React.ReactNode }> = ({ step, children }) => (
  <div className="min-h-screen bg-[#fbfaf5] text-slate-900 flex flex-col">
    <header className="px-6 pt-8 pb-2 flex items-center justify-between max-w-2xl w-full mx-auto">
      <Link to="/" className="flex items-center gap-2 group">
        <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center shadow-sm shadow-emerald-200">
          <span className="text-white font-bold text-base">C</span>
        </div>
        <span className="font-semibold text-slate-900 group-hover:text-emerald-700 transition">CareConnex</span>
      </Link>
      <a
        href={SUPPORT_PHONE_HREF}
        className="text-sm font-medium text-slate-600 hover:text-emerald-700 transition"
      >
        Need help? Call {SUPPORT_PHONE_DISPLAY}
      </a>
    </header>
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-md space-y-7">
        {step !== 'connected' && (
          <div className="text-center">
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900">Meet Cara</h1>
            <p className="text-slate-600 mt-2 text-lg leading-relaxed">
              Your care coordinator. She&rsquo;ll help you find the right caregiver for your family.
            </p>
          </div>
        )}
        {children}
      </div>
    </main>
    <footer className="text-center px-6 pb-6 text-xs text-slate-400">
      <a href={SUPPORT_PHONE_HREF} className="underline-offset-2 hover:underline">
        Prefer to talk to a person? Call us at {SUPPORT_PHONE_DISPLAY}.
      </a>
    </footer>
  </div>
);

// ============================================================================
// STEP COMPONENTS
// ============================================================================

const RolePicker: React.FC<{ tone: 'dark' | 'light'; onPick: (r: OnboardingRole) => void }> = ({ tone, onPick }) => {
  if (tone === 'dark') {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-center">What brings you here?</h2>
        <button
          onClick={() => onPick('client')}
          className="w-full py-4 px-5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 active:bg-white/[0.15] transition text-left"
        >
          <div className="font-semibold text-sm">I need care for someone</div>
          <div className="text-white/40 text-xs mt-0.5">Find caregivers for a loved one</div>
        </button>
        <button
          onClick={() => onPick('caregiver')}
          className="w-full py-4 px-5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 active:bg-white/[0.15] transition text-left"
        >
          <div className="font-semibold text-sm">I'm a caregiver</div>
          <div className="text-white/40 text-xs mt-0.5">Find families in your area</div>
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <button
        onClick={() => onPick('client')}
        className="w-full px-6 py-5 rounded-2xl border border-slate-200 bg-white hover:border-emerald-400 hover:shadow-md transition text-left"
      >
        <div className="font-semibold text-lg text-slate-900">Find a caregiver</div>
        <div className="text-slate-500 mt-1">For a parent, spouse, or loved one</div>
      </button>
      <button
        onClick={() => onPick('caregiver')}
        className="w-full px-6 py-5 rounded-2xl border border-slate-200 bg-white hover:border-emerald-400 hover:shadow-md transition text-left"
      >
        <div className="font-semibold text-lg text-slate-900">I&rsquo;m a caregiver</div>
        <div className="text-slate-500 mt-1">Apply to work with families</div>
      </button>
    </div>
  );
};

const ConsentScreen: React.FC<{
  role: OnboardingRole;
  tone: 'dark' | 'light';
  agreed: boolean;
  setAgreed: (v: boolean) => void;
  onBack?: () => void;
  onContinue: () => void;
}> = ({ role, tone, agreed, setAgreed, onBack, onContinue }) => {
  if (tone === 'dark') {
    return (
      <div className="space-y-5">
        <div className="space-y-1 text-center">
          <h2 className="text-xl font-semibold">Welcome to Cara</h2>
          <p className="text-white/40 text-sm">
            Cara communicates with you over iMessage, RCS, or SMS.
          </p>
        </div>
        <div className="h-52 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 px-4 py-4 space-y-4 text-sm leading-relaxed">
          <div>
            <span className="font-semibold text-white">What will you receive?</span>{' '}
            <span className="text-white/60">Match notifications, family contact requests, and updates about your work.</span>
          </div>
          <div>
            <span className="font-semibold text-white">How often?</span>{' '}
            <span className="text-white/60">Only when something relevant happens.</span>
          </div>
          <div>
            <span className="font-semibold text-white/50">Costs?</span>{' '}
            <span className="text-white/40">Standard message and data rates apply.</span>
          </div>
          <div>
            <span className="font-semibold text-white">Want to stop?</span>{' '}
            <span className="text-white/60">Reply STOP anytime.</span>
          </div>
          <div className="pt-1 border-t border-white/10 text-white/30 text-xs">
            <Link to="/terms" className="underline underline-offset-2 hover:text-white/50">Terms</Link>
            {' · '}
            <Link to="/privacy" className="underline underline-offset-2 hover:text-white/50">Privacy</Link>
          </div>
        </div>
        <label className="flex items-center gap-3 cursor-pointer select-none rounded-2xl border border-white/10 bg-white/5 px-4 py-3.5 hover:bg-white/[0.08] transition">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="w-4 h-4 rounded accent-blue-500 flex-shrink-0"
          />
          <span className="text-sm text-white/80">I agree to the terms above</span>
        </label>
        <button
          onClick={onContinue}
          disabled={!agreed}
          className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
        >
          Continue
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className="w-full text-sm text-white/30 hover:text-white/50 transition">
            ← Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl bg-white border border-slate-200 p-6 space-y-4 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Here&rsquo;s what happens next</h2>
        <ol className="space-y-3 text-slate-700 text-base leading-relaxed">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-sm">1</span>
            <span>We&rsquo;ll text a one-time code to verify your phone.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-sm">2</span>
            <span>You&rsquo;ll send Cara a quick &ldquo;Hey&rdquo; from your Messages app.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-sm">3</span>
            <span>Cara replies, asks a few questions, and finds caregivers near you.</span>
          </li>
        </ol>
      </div>
      <div className="rounded-2xl bg-emerald-50/70 border border-emerald-100 px-5 py-4 text-sm text-slate-700 leading-relaxed">
        <p className="font-semibold text-slate-900 mb-1">Quick note on texts</p>
        <p>
          {role === 'caregiver'
            ? 'Cara will text you about jobs near you and family requests. Standard message and data rates may apply. Reply STOP anytime.'
            : 'Cara will text you about caregiver matches and visit updates — never sales pitches. Standard rates may apply. Reply STOP anytime.'}
          {' '}
          <Link to="/terms" className="underline underline-offset-2">Terms</Link>
          {' · '}
          <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
        </p>
      </div>
      <label className="flex items-center gap-3 cursor-pointer select-none rounded-2xl border border-slate-200 bg-white px-5 py-4 hover:border-emerald-400 transition">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="w-5 h-5 rounded accent-emerald-600 flex-shrink-0"
        />
        <span className="text-base text-slate-800">I agree to the terms above</span>
      </label>
      <button
        onClick={onContinue}
        disabled={!agreed}
        className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition font-semibold text-base text-white shadow-md shadow-emerald-200"
      >
        Continue
      </button>
      {onBack && (
        <button type="button" onClick={onBack} className="w-full text-sm text-slate-500 hover:text-slate-700 transition">
          ← Back
        </button>
      )}
    </div>
  );
};

const NameEntry: React.FC<{
  role: OnboardingRole;
  tone: 'dark' | 'light';
  name: string;
  setName: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}> = ({ role, tone, name, setName, onSubmit, onBack }) => {
  const trimmed = name.trim();
  const isValid = trimmed.length > 0;
  const onSubmitForm = (e: React.FormEvent) => { e.preventDefault(); if (isValid) onSubmit(); };
  if (tone === 'dark') {
    return (
      <form onSubmit={onSubmitForm} className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-center">What&rsquo;s your name?</h2>
          <p className="text-white/40 text-sm text-center">So Cara knows who she&rsquo;s talking to.</p>
        </div>
        <input
          type="text"
          autoFocus
          maxLength={80}
          autoComplete="given-name"
          placeholder="Your first name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3.5 text-white placeholder-white/20 focus:outline-none focus:border-blue-500 text-sm"
        />
        <button
          type="submit"
          disabled={!isValid}
          className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
        >
          Continue
        </button>
        <button type="button" onClick={onBack} className="w-full text-sm text-white/30 hover:text-white/50 transition">← Back</button>
      </form>
    );
  }
  return (
    <form onSubmit={onSubmitForm} className="space-y-5">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-semibold text-slate-900">What&rsquo;s your name?</h2>
        <p className="text-slate-600 text-base">
          {role === 'caregiver'
            ? "So Cara can greet you properly when you text her."
            : "So Cara knows who she’s helping when you text her."}
        </p>
      </div>
      <input
        type="text"
        autoFocus
        maxLength={80}
        autoComplete="given-name"
        placeholder="Your first name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-white border border-slate-300 rounded-2xl px-5 py-4 text-slate-900 placeholder-slate-400 focus:outline-none focus:border-emerald-500 text-lg"
      />
      <button
        type="submit"
        disabled={!isValid}
        className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition font-semibold text-base text-white shadow-md shadow-emerald-200"
      >
        Continue
      </button>
      <button type="button" onClick={onBack} className="w-full text-sm text-slate-500 hover:text-slate-700 transition">← Back</button>
    </form>
  );
};

const PhoneEntry: React.FC<{
  role: OnboardingRole;
  tone: 'dark' | 'light';
  countryCode: string;
  setCountryCode: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  isValid: boolean;
  loading: boolean;
  error: string | null;
  onSubmit: () => void;
  onBack: () => void;
}> = ({ role, tone, countryCode, setCountryCode, phone, setPhone, isValid, loading, error, onSubmit, onBack }) => {
  const onSubmitForm = (e: React.FormEvent) => { e.preventDefault(); onSubmit(); };
  if (tone === 'dark') {
    return (
      <form onSubmit={onSubmitForm} className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-center">What's your mobile number?</h2>
          <p className="text-white/40 text-sm text-center">We'll text you a 6-digit code.</p>
        </div>
        <div className="flex gap-2">
          <select
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-3.5 text-sm text-white focus:outline-none focus:border-blue-500 flex-shrink-0"
          >
            <option value="+1">🇺🇸 +1</option>
          </select>
          <input
            type="tel"
            inputMode="numeric"
            autoFocus
            placeholder="(555) 555-5555"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3.5 text-white placeholder-white/20 focus:outline-none focus:border-blue-500 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={!isValid || loading}
          className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
        >
          {loading ? 'Sending code…' : 'Send code'}
        </button>
        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
        <button type="button" onClick={onBack} className="w-full text-sm text-white/30 hover:text-white/50 transition">← Back</button>
      </form>
    );
  }
  return (
    <form onSubmit={onSubmitForm} className="space-y-5">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-semibold text-slate-900">What&rsquo;s your mobile number?</h2>
        <p className="text-slate-600 text-base">
          {role === 'caregiver'
            ? "We'll text a 6-digit code to confirm it's you."
            : "We'll text a 6-digit code to make sure it really is you."}
        </p>
      </div>
      <div className="flex gap-3">
        <select
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          className="bg-white border border-slate-300 rounded-2xl px-4 py-4 text-base text-slate-900 focus:outline-none focus:border-emerald-500"
        >
          <option value="+1">🇺🇸 +1</option>
        </select>
        <input
          type="tel"
          inputMode="numeric"
          autoFocus
          placeholder="(555) 555-5555"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="flex-1 bg-white border border-slate-300 rounded-2xl px-5 py-4 text-slate-900 placeholder-slate-400 focus:outline-none focus:border-emerald-500 text-lg tracking-wide"
        />
      </div>
      <button
        type="submit"
        disabled={!isValid || loading}
        className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition font-semibold text-base text-white shadow-md shadow-emerald-200"
      >
        {loading ? 'Sending code…' : 'Send code'}
      </button>
      {error && <p className="text-red-600 text-sm text-center">{error}</p>}
      <button type="button" onClick={onBack} className="w-full text-sm text-slate-500 hover:text-slate-700 transition">← Back</button>
    </form>
  );
};

const CodeEntry: React.FC<{
  tone: 'dark' | 'light';
  phone: string;
  code: string;
  setCode: (v: string) => void;
  loading: boolean;
  error: string | null;
  resendIn: number;
  onConfirm: () => void;
  onResend: () => void;
  onChangeNumber: () => void;
}> = ({ tone, phone, code, setCode, loading, error, resendIn, onConfirm, onResend, onChangeNumber }) => {
  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); onConfirm(); };
  const displayPhone = /^\+1\d{10}$/.test(phone) ? `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}` : phone;
  if (tone === 'dark') {
    return (
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-center">Enter the code</h2>
          <p className="text-white/40 text-sm text-center">We texted {displayPhone}</p>
        </div>
        <input
          type="text"
          inputMode="numeric"
          autoFocus
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-4 text-white placeholder-white/20 focus:outline-none focus:border-blue-500 text-2xl tracking-[0.5em] text-center font-mono"
        />
        <button
          type="submit"
          disabled={code.length !== 6 || loading}
          className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-semibold text-sm"
        >
          {loading ? 'Verifying…' : 'Verify'}
        </button>
        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
        <div className="flex items-center justify-between text-xs">
          <button type="button" onClick={onChangeNumber} className="text-white/30 hover:text-white/50 transition">
            ← Change number
          </button>
          <button
            type="button"
            onClick={onResend}
            disabled={resendIn > 0}
            className="text-white/30 hover:text-white/50 disabled:hover:text-white/30 transition"
          >
            {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
          </button>
        </div>
      </form>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-semibold text-slate-900">Enter the code</h2>
        <p className="text-slate-600 text-base">
          We texted a 6-digit code to <span className="font-medium text-slate-900">{displayPhone}</span>. Type it below.
        </p>
      </div>
      <input
        type="text"
        inputMode="numeric"
        autoFocus
        maxLength={6}
        placeholder="123456"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        className="w-full bg-white border border-slate-300 rounded-2xl px-5 py-5 text-slate-900 placeholder-slate-300 focus:outline-none focus:border-emerald-500 text-3xl tracking-[0.5em] text-center font-mono"
      />
      <button
        type="submit"
        disabled={code.length !== 6 || loading}
        className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition font-semibold text-base text-white shadow-md shadow-emerald-200"
      >
        {loading ? 'Verifying…' : 'Verify'}
      </button>
      {error && <p className="text-red-600 text-sm text-center">{error}</p>}
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={onChangeNumber} className="text-slate-500 hover:text-slate-700 transition">
          ← Change number
        </button>
        <button
          type="button"
          onClick={onResend}
          disabled={resendIn > 0}
          className="text-slate-500 hover:text-emerald-700 disabled:hover:text-slate-500 transition"
        >
          {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
        </button>
      </div>
    </form>
  );
};

const HandoffScreen: React.FC<{
  role: OnboardingRole;
  tone: 'dark' | 'light';
  device: 'desktop' | 'mobile';
  linqPhone: string;
}> = ({ role, tone, device, linqPhone }) => {
  const isCaregiver = role === 'caregiver';
  if (device === 'mobile') {
    return (
      <MobileHandoff
        linqPhone={linqPhone}
        tone={tone}
        caption={
          isCaregiver ? (
            <>Tap below to open Messages. We&rsquo;ve filled in a quick &ldquo;Hey Cara&rdquo; — just hit send.</>
          ) : (
            <>One last step: open Messages and send the pre-filled note to Cara. She&rsquo;ll take it from there.</>
          )
        }
        ctaLabel={isCaregiver ? 'Open Messages' : 'Send to Cara'}
        helper={<>Cara will reply on this number. You can keep texting her here whenever you need.</>}
      />
    );
  }
  return (
    <QRHandoff
      linqPhone={linqPhone}
      tone={tone}
      caption={
        isCaregiver ? (
          <>Scan with your phone&rsquo;s camera. We&rsquo;ll open Messages with a quick &ldquo;Hey Cara&rdquo; ready to send.</>
        ) : (
          <>
            <p className="text-xl font-semibold text-slate-900 mb-1">Scan to start your conversation</p>
            <p>Point your phone&rsquo;s camera at the code. Your Messages app will open with a note to Cara — just press send.</p>
          </>
        )
      }
      helper={
        isCaregiver
          ? <>No camera? Text the number above with the words <span className="font-semibold">Hey Cara</span>.</>
          : <>Don&rsquo;t have a camera handy? Text the number above with the words <span className="font-semibold">Hey Cara</span>.</>
      }
    />
  );
};

const ConnectedScreen: React.FC<{ role: OnboardingRole; tone: 'dark' | 'light' }> = ({ role, tone }) => {
  if (tone === 'dark') {
    return (
      <div className="text-center space-y-4">
        <div className="text-5xl">✓</div>
        <h2 className="text-xl font-semibold">You&rsquo;re connected</h2>
        <p className="text-white/50 text-sm leading-relaxed">
          {role === 'caregiver'
            ? "Cara is texting you now. Keep the conversation going in Messages — she'll walk you through your profile in a few minutes."
            : "Cara is texting you. Open Messages to continue."}
        </p>
        <p className="text-white/25 text-xs">You can close this tab.</p>
      </div>
    );
  }
  return (
    <div className="text-center space-y-5 pt-4">
      <div className="w-16 h-16 mx-auto rounded-full bg-emerald-100 flex items-center justify-center">
        <svg viewBox="0 0 24 24" className="w-9 h-9 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 className="text-2xl font-semibold text-slate-900">Cara is texting you now</h2>
      <p className="text-slate-600 text-lg leading-relaxed">
        Open Messages to continue. She&rsquo;ll ask a few quick questions and then show you caregivers in your area.
      </p>
      <p className="text-slate-400 text-sm">You can close this tab — everything happens by text from here.</p>
    </div>
  );
};
