import React, { useState } from 'react';
import { functions } from '../../lib/firebase';

// Token-authenticated FCRA disclosure + authorization for caregivers arriving
// from Evia's SMS link (/bgcheck?t=...). Webapp parity: the same disclosure and
// consent the logged-in BackgroundCheckModal collects, restyled to match the
// dark SMS-first surfaces (UploadPage). On submit, v1-confirmBgcheckOnboarding
// creates the Checkr candidate + invitation server-side and Checkr emails the
// caregiver a secure link — SSN/DOB are entered on Checkr's site, never here.

const LINQ_PHONE = import.meta.env.VITE_LINQ_PHONE_NUMBER || '';

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];

const FCRA_RIGHTS = [
  'You have the right to know when a consumer report is being prepared about you.',
  'You may request a free copy of your consumer report from Checkr within 60 days of any adverse action.',
  'You have the right to dispute incomplete or inaccurate information in your report.',
  'Checkr will provide you with "A Summary of Your Rights Under the Fair Credit Reporting Act" when you complete their verification form.',
];

type Step = 'disclosure' | 'form' | 'done' | 'expired';

export default function BgcheckConsentPage() {
  const [step, setStep] = useState<Step>('disclosure');
  const [form, setForm] = useState({
    legalFirstName: '',
    legalLastName: '',
    zipCode: '',
    state: '',
    consentGiven: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.consentGiven || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (!functions) {
        setErrorMsg('Something went wrong loading the page — please try again.');
        return;
      }
      const token = new URLSearchParams(window.location.search).get('t') ?? '';
      if (!token) {
        setStep('expired');
        return;
      }
      const confirm = functions.httpsCallable('v1-confirmBgcheckOnboarding');
      await confirm({
        token,
        legalFirstName: form.legalFirstName.trim(),
        legalLastName: form.legalLastName.trim(),
        zipCode: form.zipCode.trim(),
        state: form.state,
        consentGiven: true,
      });
      setStep('done');
      // Hand the caregiver straight back to their iMessage/SMS thread with Evia.
      setTimeout(() => {
        if (LINQ_PHONE) window.location.href = `sms:${LINQ_PHONE}`;
      }, 4000);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      // Compat SDK surfaces HttpsError codes without the "functions/" prefix,
      // modular with it — accept both (same handling as UploadPage).
      const code = (e?.code ?? '').replace(/^functions\//, '');
      if (code === 'unauthenticated') {
        setStep('expired');
        return;
      }
      console.error('confirmBgcheckOnboarding failed:', err);
      setErrorMsg(
        code === 'invalid-argument' && e?.message
          ? e.message
          : 'Submission failed. Please try again — or text Evia and we’ll sort it out.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'expired') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center gap-6">
        <div className="w-16 h-16 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
          <span className="text-3xl">⏳</span>
        </div>
        <div>
          <p className="text-white text-xl font-semibold">This link has expired</p>
          <p className="text-white/50 text-sm mt-1">
            For your security these links expire after a couple of hours. Text Evia and I'll send you a fresh one.
          </p>
        </div>
        <a
          href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
          className="w-full max-w-xs py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl text-base text-center transition-all active:scale-95"
        >
          Text Evia for a new link
        </a>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center gap-6">
        <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center">
          <span className="text-3xl">📬</span>
        </div>
        <div className="max-w-sm">
          <p className="text-white text-xl font-semibold">Check your email</p>
          <p className="text-white/50 text-sm mt-2">
            Checkr just emailed you a secure link to finish verification — your SSN and date of birth go directly to
            Checkr, never to Evia. Results usually come back within 1–3 days once you're done.
          </p>
        </div>
        <a
          href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
          className="text-blue-400 text-sm underline underline-offset-2"
        >
          Tap here to return to Evia
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center px-5 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto">
            <span className="text-2xl">🛡️</span>
          </div>
          <h1 className="text-white text-xl font-semibold">
            {step === 'disclosure' ? 'Background Check Disclosure' : 'Authorization'}
          </h1>
          <p className="text-white/40 text-xs">Powered by Checkr • Included in your membership</p>
          <div className="flex items-center justify-center gap-2 pt-1">
            <div className={`h-1.5 w-12 rounded-full ${step === 'disclosure' ? 'bg-blue-500' : 'bg-green-500'}`} />
            <div className={`h-1.5 w-12 rounded-full ${step === 'form' ? 'bg-green-500' : 'bg-white/15'}`} />
          </div>
        </div>

        {step === 'disclosure' && (
          <div className="space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-4">
              <p className="text-sm font-semibold text-blue-300 mb-2">Disclosure Notice</p>
              <p className="text-xs text-blue-100/80 leading-relaxed">
                In connection with your application to provide care services through Evia, a consumer report
                (background check) will be obtained about you from <strong>Checkr, Inc.</strong>, a consumer reporting
                agency (FCRA § 604). This report may include criminal history and other public record information, and
                will be used solely to evaluate your eligibility to join the platform.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-white/60 uppercase tracking-wide">Your Rights Under the FCRA</p>
              <ul className="space-y-2">
                {FCRA_RIGHTS.map((right, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-white/30 mt-0.5 shrink-0">•</span>
                    <span className="text-xs text-white/60 leading-relaxed">{right}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-3 flex items-start gap-3">
              <span className="text-white/40 mt-0.5 shrink-0">🔒</span>
              <p className="text-xs text-white/50 leading-relaxed">
                Your SSN and date of birth are entered directly on Checkr's secure site —{' '}
                <strong className="text-white/70">they are never transmitted to or stored by Evia</strong>.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setStep('form')}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl text-base transition-all active:scale-95"
            >
              I Understand — Continue to Authorization
            </button>
          </div>
        )}

        {step === 'form' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <button
              type="button"
              onClick={() => setStep('disclosure')}
              className="text-xs text-white/40 hover:text-white/70 underline underline-offset-2"
            >
              ← Back to Disclosure
            </button>

            <p className="text-xs text-white/50 leading-relaxed">
              Use your <strong className="text-white/80">legal name</strong> exactly as it appears on your ID — that's
              what your records are searched against.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">Legal First Name *</label>
                <input
                  required
                  maxLength={50}
                  value={form.legalFirstName}
                  onChange={(e) => setForm({ ...form, legalFirstName: e.target.value })}
                  className="w-full px-3 py-3 bg-white/5 border border-white/15 rounded-xl text-sm text-white placeholder-white/25 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">Legal Last Name *</label>
                <input
                  required
                  maxLength={50}
                  value={form.legalLastName}
                  onChange={(e) => setForm({ ...form, legalLastName: e.target.value })}
                  className="w-full px-3 py-3 bg-white/5 border border-white/15 rounded-xl text-sm text-white placeholder-white/25 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">Current Zip Code *</label>
                <input
                  required
                  inputMode="numeric"
                  pattern="\d{5}(-\d{4})?"
                  value={form.zipCode}
                  onChange={(e) => setForm({ ...form, zipCode: e.target.value })}
                  className="w-full px-3 py-3 bg-white/5 border border-white/15 rounded-xl text-sm text-white placeholder-white/25 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1">State *</label>
                <select
                  required
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                  className="w-full px-3 py-3 bg-white/5 border border-white/15 rounded-xl text-sm text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none [&>option]:bg-slate-900"
                >
                  <option value="">Select state</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex items-start gap-3 p-3 rounded-2xl bg-white/5 border border-white/10 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded"
                checked={form.consentGiven}
                onChange={(e) => setForm({ ...form, consentGiven: e.target.checked })}
              />
              <span className="text-xs text-white/60 leading-relaxed">
                I have read the disclosure above and authorize Evia and Checkr, Inc. to obtain a consumer report
                (background check) about me for caregiving eligibility purposes under the FCRA. I understand that
                Checkr will email me a secure link to provide my SSN and date of birth directly on their platform. I
                agree to Checkr's{' '}
                <a
                  href="https://checkr.com/customer-terms-of-service"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-blue-400"
                  onClick={(e) => e.stopPropagation()}
                >
                  Terms of Service
                </a>{' '}
                and{' '}
                <a
                  href="https://checkr.com/privacy-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-blue-400"
                  onClick={(e) => e.stopPropagation()}
                >
                  Privacy Policy
                </a>
                .
              </span>
            </label>

            {errorMsg && <p className="text-red-400 text-sm">{errorMsg}</p>}

            <button
              type="submit"
              disabled={submitting || !form.consentGiven || !form.state}
              className="w-full py-4 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-2xl text-base transition-all active:scale-95 disabled:opacity-40"
            >
              {submitting ? 'Submitting securely…' : 'Submit for Verification'}
            </button>
          </form>
        )}

        <div className="text-center">
          <a
            href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
            className="text-white/30 text-xs underline underline-offset-2"
          >
            Questions? Text Evia
          </a>
        </div>
      </div>
    </div>
  );
}
