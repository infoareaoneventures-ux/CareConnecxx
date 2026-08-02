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
import { supportPhone } from '../../../utils/launchConfig';
import { BloomMark } from '../../ui/BloomMark';

export type OnboardingRole = 'client' | 'caregiver';
export type CareType = 'senior' | 'child';
type Step =
  | 'role' | 'careType' | 'consent' | 'name' | 'phone' | 'verify' | 'handoff' | 'connected'
  // Front door Stage 2 (deliverable 7): childcare was picked but is not open
  // yet. An EXPLICIT state — the bug this replaces silently dropped the person
  // into senior onboarding, which SMS never did.
  | 'childcareUnavailable';

interface Props {
  initialRole?: OnboardingRole | null;
  referralId?: string | null;
  /**
   * Childcare U4 (plan 2026-07-22-002): true for an explicit childcare entry
   * param (/start?vertical=child). Front door Stage 1 keeps this working
   * exactly as before — the deep link PRE-ANSWERS the care-type question, so
   * the step is skipped entirely and the payload carries careVertical: 'child'.
   */
  childcareEntry?: boolean;
  /**
   * Front door Stage 1 (docs/architecture/childcare-front-door-design.md):
   * render the "what kind of care?" step for ORGANIC arrivals — a person who
   * lands on /start with no vertical in the URL was previously never asked, so
   * childcare was unreachable unless you already knew the deep link existed.
   *
   * Senior stays byte-identical DOWNSTREAM of the answer: picking the older
   * adult sends the exact pre-childcare payload (no careVertical key at all),
   * so every senior consumer — the bridge doc field set, the SMS ingress, the
   * senior funnel — sees precisely what it saw before.
   */
  askCareType?: boolean;
}

const RECAPTCHA_CONTAINER = 'careconnex-recaptcha-container';
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

export const OnboardingFlow: React.FC<Props> = ({ initialRole, referralId, childcareEntry, askCareType }) => {
  const device = useDeviceClass();
  const [role, setRole] = useState<OnboardingRole | null>(initialRole ?? null);
  // The deep link is an ANSWER, not a prompt: ?vertical=child means the person
  // already told us, so the question is skipped (and must keep being skipped).
  const [careType, setCareType] = useState<CareType | null>(childcareEntry ? 'child' : null);
  // Ask organically only when the URL did not already answer it.
  const showCareTypeStep = Boolean(askCareType) && !childcareEntry;
  const [step, setStep] = useState<Step>(
    initialRole
      ? (showCareTypeStep ? 'careType' : 'consent')
      : 'role',
  );
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
      // Childcare U4: careVertical is ADDITIVE — sent only when the childcare
      // entry explicitly selected childcare. Every other flow's payload is
      // byte-identical to the pre-childcare shape.
      const resp = await create({
        phone: e164,
        role,
        name: cleanName,
        consentText: CONSENT_VERSION,
        referralId,
        // careVertical is ADDITIVE and role-agnostic as of front door Stage 1
        // (createWebOnboardingSession dropped its role === 'client' gate, which
        // was the structural reason no caregiver could reach childcare). It is
        // sent ONLY on an explicit childcare answer — deep link or organic
        // pick — so every senior payload stays byte-identical in shape.
        ...(careType === 'child' ? { careVertical: 'child' } : {}),
      });
      const data = resp.data as { linqPhone?: string; childcareAvailable?: boolean };
      // Front door Stage 2 (deliverable 7): the server tells us whether childcare
      // was actually available. `false` is an EXPLICIT unavailable/waitlist
      // state — never a silent fall-through into senior onboarding. The field is
      // additive and only ever present for a childcare request, so a senior
      // signup (undefined) behaves exactly as it always did.
      if (careType === 'child' && data?.childcareAvailable === false) {
        setStep('childcareUnavailable');
        return;
      }
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
          onPick={(r) => {
            setRole(r);
            // Organic arrivals get asked; a ?vertical=child arrival already
            // answered, so it goes straight to consent as it always did.
            setStep(showCareTypeStep ? 'careType' : 'consent');
          }}
        />
      );
    }
    if (step === 'careType') {
      return (
        <CareTypePicker
          role={role}
          onPick={(c) => { setCareType(c); setStep('consent'); }}
          onBack={initialRole ? undefined : () => setStep('role')}
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
          onBack={
            childcareEntry && role === 'client'
              ? () => setStep('careType')
              : initialRole ? undefined : () => setStep('role')
          }
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
    if (step === 'childcareUnavailable') {
      return <ChildcareUnavailableScreen role={role!} tone={tone} />;
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
  <div className="min-h-screen bg-paper-50 text-ink-900 flex flex-col items-center justify-center px-6 py-10">
    <div className="w-full max-w-sm space-y-8">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-2xl bg-paper-100 border hairline flex items-center justify-center mx-auto">
          <BloomMark className="w-6 h-6 text-ink-900" />
        </div>
        <div className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</div>
        <p className="text-ink-600 text-sm">Your care coordinator</p>
        {/* LAUNCH: wording pending counsel review (R15) */}
        <p className="text-ink-400 text-xs">Evia is an automated coordinator backed by our care team.</p>
      </div>
      {children}
    </div>
  </div>
);

const FamilyShell: React.FC<{ role: OnboardingRole | null; step: Step; children: React.ReactNode }> = ({ step, children }) => (
  <div className="min-h-screen bg-paper-50 text-ink-900 flex flex-col">
    <header className="px-6 pt-8 pb-2 flex items-center justify-between max-w-2xl w-full mx-auto">
      <Link to="/" className="flex items-center gap-2 group">
        <div className="w-9 h-9 rounded-xl bg-paper-100 border hairline flex items-center justify-center">
          <BloomMark className="w-5 h-5 text-ink-900" />
        </div>
        <span className="font-semibold text-ink-900 group-hover:text-ink-600 transition">Evia</span>
      </Link>
      {supportPhone && (
        <a href={supportPhone.telHref} className="text-sm font-medium text-ink-600 hover:text-ink-900 transition">
          Need help? Call {supportPhone.display}
        </a>
      )}
    </header>
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-md space-y-7">
        {step !== 'connected' && (
          <div className="text-center">
            <h1 className="text-3xl md:text-4xl font-display font-semibold tracking-[-0.02em] text-ink-900">Meet Evia</h1>
            <p className="text-ink-600 mt-2 text-lg leading-relaxed">
              Your care coordinator. She&rsquo;ll help you find the right caregiver for your family.
            </p>
            {/* LAUNCH: wording pending counsel review (R15) */}
            <p className="text-ink-400 mt-1 text-sm">Evia is an automated coordinator backed by our care team.</p>
          </div>
        )}
        {children}
      </div>
    </main>
    {supportPhone && (
      <footer className="text-center px-6 pb-6 text-xs text-ink-400">
        <a href={supportPhone.telHref} className="underline-offset-2 hover:underline">
          Prefer to talk to a person? Call us at {supportPhone.display}.
        </a>
      </footer>
    )}
  </div>
);

// ============================================================================
// STEP COMPONENTS
// ============================================================================

const RolePicker: React.FC<{ tone: 'dark' | 'light'; onPick: (r: OnboardingRole) => void }> = ({ tone, onPick }) => {
  if (tone === 'dark') {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">What brings you here?</h2>
        <button
          onClick={() => onPick('client')}
          className="w-full py-4 px-5 rounded-2xl border hairline bg-white hover:shadow-md active:shadow-sm transition text-left"
        >
          <div className="font-semibold text-sm text-ink-900">I need care for someone</div>
          <div className="text-ink-600 text-xs mt-0.5">Find caregivers for a loved one</div>
        </button>
        <button
          onClick={() => onPick('caregiver')}
          className="w-full py-4 px-5 rounded-2xl border hairline bg-white hover:shadow-md active:shadow-sm transition text-left"
        >
          <div className="font-semibold text-sm text-ink-900">I'm a caregiver</div>
          <div className="text-ink-600 text-xs mt-0.5">Find families in your area</div>
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <button
        onClick={() => onPick('client')}
        className="w-full px-6 py-5 rounded-2xl border hairline bg-white hover:shadow-md transition text-left"
      >
        <div className="font-semibold text-lg text-ink-900">Find a caregiver</div>
        <div className="text-ink-600 mt-1">For a parent, spouse, or loved one</div>
      </button>
      <button
        onClick={() => onPick('caregiver')}
        className="w-full px-6 py-5 rounded-2xl border hairline bg-white hover:shadow-md transition text-left"
      >
        <div className="font-semibold text-lg text-ink-900">I&rsquo;m a caregiver</div>
        <div className="text-ink-600 mt-1">Apply to work with families</div>
      </button>
    </div>
  );
};

// The care-type question. Front door Stage 1 renders it for ORGANIC arrivals
// (both roles) and skips it when ?vertical=child already answered it.
//
// No child details are asked here — this only sets the typed vertical intent
// (R47/R33); child names, ages, and every other recipient detail are collected
// exclusively in the authenticated ChildProfileFlow.
const CareTypePicker: React.FC<{
  role: OnboardingRole | null;
  onPick: (c: CareType) => void;
  onBack?: () => void;
}> = ({ role, onPick, onBack }) => (
  <div className="space-y-4">
    <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">
      {role === 'caregiver' ? 'What kind of care do you provide?' : 'Who is this care for?'}
    </h2>
    <button
      onClick={() => onPick('senior')}
      className="w-full px-6 py-5 rounded-2xl border hairline bg-white hover:shadow-md transition text-left"
    >
      <div className="font-semibold text-lg text-ink-900">
        {role === 'caregiver' ? 'Older adults' : 'An older adult'}
      </div>
      <div className="text-ink-600 mt-1">
        {role === 'caregiver'
          ? 'Senior care — companionship, personal care, dementia support'
          : 'Care for a parent, spouse, or loved one'}
      </div>
    </button>
    <button
      onClick={() => onPick('child')}
      className="w-full px-6 py-5 rounded-2xl border hairline bg-white hover:shadow-md transition text-left"
    >
      <div className="font-semibold text-lg text-ink-900">
        {role === 'caregiver' ? 'Children' : 'My children'}
      </div>
      <div className="text-ink-600 mt-1">
        {role === 'caregiver'
          ? 'Childcare — babysitting and nanny work'
          : 'Babysitters and nannies for your family'}
      </div>
    </button>
    {onBack && (
      <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">
        ← Back
      </button>
    )}
  </div>
);

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
          <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Welcome to Evia</h2>
          <p className="text-ink-600 text-sm">
            Evia communicates with you over iMessage, RCS, or SMS.
          </p>
        </div>
        <div className="h-52 overflow-y-auto rounded-2xl border hairline bg-white px-4 py-4 space-y-4 text-sm leading-relaxed">
          <div>
            <span className="font-semibold text-ink-900">What will you receive?</span>{' '}
            <span className="text-ink-600">Match notifications, family contact requests, and updates about your work.</span>
          </div>
          <div>
            <span className="font-semibold text-ink-900">How often?</span>{' '}
            <span className="text-ink-600">Only when something relevant happens.</span>
          </div>
          <div>
            <span className="font-semibold text-ink-600">Costs?</span>{' '}
            <span className="text-ink-400">Standard message and data rates apply.</span>
          </div>
          <div>
            <span className="font-semibold text-ink-900">Want to stop?</span>{' '}
            <span className="text-ink-600">Reply STOP anytime.</span>
          </div>
          <div className="pt-1 border-t hairline text-ink-400 text-xs">
            <Link to="/terms" className="underline underline-offset-2 hover:text-ink-600">Terms</Link>
            {' · '}
            <Link to="/privacy" className="underline underline-offset-2 hover:text-ink-600">Privacy</Link>
          </div>
        </div>
        <label className="flex items-center gap-3 cursor-pointer select-none rounded-2xl border hairline bg-white px-4 py-3.5 hover:shadow-sm transition">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="w-4 h-4 rounded accent-ink-900 flex-shrink-0"
          />
          <span className="text-sm text-ink-600">I agree to the terms above</span>
        </label>
        <button
          onClick={onContinue}
          disabled={!agreed}
          className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
        >
          Continue
        </button>
        {onBack && (
          <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">
            ← Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl bg-white border hairline p-6 space-y-4 shadow-sm">
        <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Here&rsquo;s what happens next</h2>
        <ol className="space-y-3 text-ink-600 text-base leading-relaxed">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-paper-100 border hairline text-ink-900 font-semibold flex items-center justify-center text-sm">1</span>
            <span>We&rsquo;ll text a one-time code to verify your phone.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-paper-100 border hairline text-ink-900 font-semibold flex items-center justify-center text-sm">2</span>
            <span>You&rsquo;ll send Evia a quick &ldquo;Hey&rdquo; from your Messages app.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-paper-100 border hairline text-ink-900 font-semibold flex items-center justify-center text-sm">3</span>
            <span>Evia replies, asks a few questions, and finds caregivers near you.</span>
          </li>
        </ol>
      </div>
      <div className="rounded-2xl bg-paper-100 border hairline px-5 py-4 text-sm text-ink-600 leading-relaxed">
        <p className="font-semibold text-ink-900 mb-1">Quick note on texts</p>
        <p>
          {role === 'caregiver'
            ? 'Evia will text you about jobs near you and family requests. Standard message and data rates may apply. Reply STOP anytime.'
            : 'Evia will text you about caregiver matches and visit updates — never sales pitches. Standard rates may apply. Reply STOP anytime.'}
          {' '}
          <Link to="/terms" className="underline underline-offset-2">Terms</Link>
          {' · '}
          <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
        </p>
      </div>
      <label className="flex items-center gap-3 cursor-pointer select-none rounded-2xl border hairline bg-white px-5 py-4 hover:shadow-sm transition">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="w-5 h-5 rounded accent-ink-900 flex-shrink-0"
        />
        <span className="text-base text-ink-900">I agree to the terms above</span>
      </label>
      <button
        onClick={onContinue}
        disabled={!agreed}
        className="w-full py-4 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
      >
        Continue
      </button>
      {onBack && (
        <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">
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
          <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">What&rsquo;s your name?</h2>
          <p className="text-ink-600 text-sm text-center">So Evia knows who she&rsquo;s talking to.</p>
        </div>
        <input
          type="text"
          autoFocus
          maxLength={80}
          autoComplete="given-name"
          placeholder="Your first name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-white border hairline rounded-xl px-4 py-3.5 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-base"
        />
        <button
          type="submit"
          disabled={!isValid}
          className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
        >
          Continue
        </button>
        <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">← Back</button>
      </form>
    );
  }
  return (
    <form onSubmit={onSubmitForm} className="space-y-5">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">What&rsquo;s your name?</h2>
        <p className="text-ink-600 text-base">
          {role === 'caregiver'
            ? "So Evia can greet you properly when you text her."
            : "So Evia knows who she’s helping when you text her."}
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
        className="w-full bg-white border hairline rounded-2xl px-5 py-4 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-lg"
      />
      <button
        type="submit"
        disabled={!isValid}
        className="w-full py-4 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
      >
        Continue
      </button>
      <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">← Back</button>
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
          <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">What's your mobile number?</h2>
          <p className="text-ink-600 text-sm text-center">We'll text you a 6-digit code.</p>
        </div>
        <div className="flex gap-2">
          <select
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="bg-white border hairline rounded-xl px-3 py-3.5 text-base text-ink-900 focus:outline-none focus:border-ink-400 flex-shrink-0"
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
            className="flex-1 bg-white border hairline rounded-xl px-4 py-3.5 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-base"
          />
        </div>
        <button
          type="submit"
          disabled={!isValid || loading}
          className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
        >
          {loading ? 'Sending code…' : 'Send code'}
        </button>
        {error && <p className="text-red-600 text-xs text-center">{error}</p>}
        <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">← Back</button>
      </form>
    );
  }
  return (
    <form onSubmit={onSubmitForm} className="space-y-5">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">What&rsquo;s your mobile number?</h2>
        <p className="text-ink-600 text-base">
          {role === 'caregiver'
            ? "We'll text a 6-digit code to confirm it's you."
            : "We'll text a 6-digit code to make sure it really is you."}
        </p>
      </div>
      <div className="flex gap-3">
        <select
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          className="bg-white border hairline rounded-2xl px-4 py-4 text-base text-ink-900 focus:outline-none focus:border-ink-400"
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
          className="flex-1 bg-white border hairline rounded-2xl px-5 py-4 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-lg tracking-wide"
        />
      </div>
      <button
        type="submit"
        disabled={!isValid || loading}
        className="w-full py-4 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
      >
        {loading ? 'Sending code…' : 'Send code'}
      </button>
      {error && <p className="text-red-600 text-sm text-center">{error}</p>}
      <button type="button" onClick={onBack} className="w-full py-3 text-sm text-ink-600 hover:text-ink-900 font-medium transition">← Back</button>
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
          <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] text-center">Enter the code</h2>
          <p className="text-ink-600 text-sm text-center">We texted {displayPhone}</p>
        </div>
        <input
          type="text"
          inputMode="numeric"
          autoFocus
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="w-full bg-white border hairline rounded-xl px-4 py-4 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-2xl tracking-[0.5em] text-center font-mono"
        />
        <button
          type="submit"
          disabled={code.length !== 6 || loading}
          className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
        >
          {loading ? 'Verifying…' : 'Verify'}
        </button>
        {error && <p className="text-red-600 text-xs text-center">{error}</p>}
        <div className="flex items-center justify-between text-xs">
          <button type="button" onClick={onChangeNumber} className="py-3 text-ink-600 hover:text-ink-900 font-medium transition">
            ← Change number
          </button>
          <button
            type="button"
            onClick={onResend}
            disabled={resendIn > 0}
            className="py-3 text-ink-600 hover:text-ink-900 disabled:hover:text-ink-600 font-medium transition"
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
        <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Enter the code</h2>
        <p className="text-ink-600 text-base">
          We texted a 6-digit code to <span className="font-medium text-ink-900">{displayPhone}</span>. Type it below.
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
        className="w-full bg-white border hairline rounded-2xl px-5 py-5 text-ink-900 placeholder-ink-400 focus:outline-none focus:border-ink-400 text-3xl tracking-[0.5em] text-center font-mono"
      />
      <button
        type="submit"
        disabled={code.length !== 6 || loading}
        className="w-full py-4 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
      >
        {loading ? 'Verifying…' : 'Verify'}
      </button>
      {error && <p className="text-red-600 text-sm text-center">{error}</p>}
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={onChangeNumber} className="py-3 text-ink-600 hover:text-ink-900 font-medium transition">
          ← Change number
        </button>
        <button
          type="button"
          onClick={onResend}
          disabled={resendIn > 0}
          className="py-3 text-ink-600 hover:text-ink-900 disabled:hover:text-ink-600 font-medium transition"
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
            <>Tap below to open Messages. We&rsquo;ve filled in a quick &ldquo;Hey Evia&rdquo; — just hit send.</>
          ) : (
            <>One last step: open Messages and send the pre-filled note to Evia. She&rsquo;ll take it from there.</>
          )
        }
        ctaLabel={isCaregiver ? 'Open Messages' : 'Send to Evia'}
        helper={<>Evia will reply on this number. You can keep texting her here whenever you need.</>}
      />
    );
  }
  return (
    <QRHandoff
      linqPhone={linqPhone}
      tone={tone}
      caption={
        isCaregiver ? (
          <>Scan with your phone&rsquo;s camera. We&rsquo;ll open Messages with a quick &ldquo;Hey Evia&rdquo; ready to send.</>
        ) : (
          <>
            <p className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-1">Scan to start your conversation</p>
            <p>Point your phone&rsquo;s camera at the code. Your Messages app will open with a note to Evia — just press send.</p>
          </>
        )
      }
      helper={
        isCaregiver
          ? <>No camera? Text the number above with the words <span className="font-semibold">Hey Evia</span>.</>
          : <>Don&rsquo;t have a camera handy? Text the number above with the words <span className="font-semibold">Hey Evia</span>.</>
      }
    />
  );
};

// Front door Stage 2 (deliverable 7). The bug: with the childcare flags off,
// createWebOnboardingSession cleared the vertical stamp (correct — fail closed)
// and the person silently continued into SENIOR onboarding, even though they had
// picked childcare. SMS, for the same intent, reached an explicit waitlist. This
// screen is the web's equivalent of that waitlist: honest, terminal, and it does
// not pretend a childcare signup happened.
//
// No SMS handoff is offered here on purpose — texting Evia would start the
// senior funnel, which is exactly the fall-through being fixed.
const ChildcareUnavailableScreen: React.FC<{ role: OnboardingRole; tone: 'dark' | 'light' }> = ({ role, tone }) => (
  <div className={`text-center space-y-4 ${tone === 'dark' ? '' : 'pt-4'}`}>
    <div className="w-14 h-14 mx-auto rounded-full bg-paper-100 border hairline flex items-center justify-center">
      <BloomMark className="w-7 h-7 text-ink-900" />
    </div>
    <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">
      Childcare isn&rsquo;t open here yet
    </h2>
    <p className="text-ink-600 text-base leading-relaxed">
      {role === 'caregiver'
        ? "We're not taking childcare caregivers in your area quite yet. Your phone number is saved and we'll text you the moment it opens up."
        : "We're not offering childcare in your area quite yet. Your phone number is saved and we'll text you the moment it opens up."}
    </p>
    <p className="text-ink-600 text-base leading-relaxed">
      {role === 'caregiver'
        ? 'Looking for senior-care work in the meantime? '
        : 'Need care for an older adult in the meantime? '}
      <Link to="/start" className="underline underline-offset-2 font-medium text-ink-900">
        Start there instead
      </Link>
      .
    </p>
    {supportPhone && (
      <p className="text-ink-400 text-sm">
        Questions? Call us at {supportPhone.display}.
      </p>
    )}
  </div>
);

const ConnectedScreen: React.FC<{ role: OnboardingRole; tone: 'dark' | 'light' }> = ({ role, tone }) => {
  if (tone === 'dark') {
    return (
      <div className="text-center space-y-4">
        <div className="text-5xl text-emerald-600">✓</div>
        <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">You&rsquo;re connected</h2>
        <p className="text-ink-600 text-sm leading-relaxed">
          {role === 'caregiver'
            ? "Evia is texting you now. Keep the conversation going in Messages — she'll walk you through your profile in a few minutes."
            : "Evia is texting you. Open Messages to continue."}
        </p>
        <p className="text-ink-400 text-xs">You can close this tab.</p>
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
      <h2 className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia is texting you now</h2>
      <p className="text-ink-600 text-lg leading-relaxed">
        Open Messages to continue. She&rsquo;ll ask a few quick questions and then show you caregivers in your area.
      </p>
      <p className="text-ink-400 text-sm">You can close this tab — everything happens by text from here.</p>
    </div>
  );
};
