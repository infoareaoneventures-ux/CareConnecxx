
import React, { useState } from 'react';
import { X, Shield, Lock, CheckCircle, ChevronLeft, FileText, AlertCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { dbService } from '../services/api';
import { AddToastFunction } from '../types';

interface BackgroundCheckModalProps {
  onClose: () => void;
  onShowToast: AddToastFunction;
  onSuccess?: () => void;
}

type Step = 'disclosure' | 'form' | 'success';

export const BackgroundCheckModal: React.FC<BackgroundCheckModalProps> = ({ onClose, onShowToast, onSuccess }) => {
  const [step, setStep] = useState<Step>('disclosure');
  const [formData, setFormData] = useState({
    legalFirstName: '',
    legalLastName: '',
    zipCode: '',
    state: '',
    consentGiven: false,
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.consentGiven) {
      onShowToast('Please authorize the background check to continue.', 'error');
      return;
    }
    setLoading(true);

    try {
      await dbService.initiateBackgroundCheck({
        legalFirstName: formData.legalFirstName.trim(),
        legalLastName: formData.legalLastName.trim(),
        zipCode: formData.zipCode.trim(),
        state: formData.state.trim(),
        consentGiven: true,
      });

      setStep('success');

      setTimeout(() => {
        if (onSuccess) onSuccess();
        onClose();
      }, 3500);
    } catch (error: any) {
      console.error('BackgroundCheck submit error:', error);
      const msg = error?.message || '';
      if (msg.includes('not logged in') || msg.includes('Backend not connected') || msg.includes('unauthenticated')) {
        onShowToast('You must be logged in to submit. Please refresh and try again.', 'error');
      } else if (msg.includes('already') || msg.includes('candidateId')) {
        onShowToast('A background check is already in progress. Check your email for the Checkr link.', 'info');
        setStep('success');
        return;
      } else {
        onShowToast(msg || 'Submission failed. Please try again or contact support.', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  if (step === 'success') {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />
        <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-8 animate-slide-in text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-10 h-10 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Check Your Email</h2>
          <p className="text-slate-500">
            Checkr just emailed you a secure link to complete verification. Reports typically come back within 24–48 hours once you finish.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden animate-slide-in">
        {/* Header */}
        <div className="bg-slate-900 p-6 text-white text-center relative">
          <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-white">
            <X size={24} />
          </button>
          <div className="flex justify-center mb-3">
            {step === 'disclosure' ? (
              <FileText className="w-10 h-10 text-blue-400" />
            ) : (
              <Shield className="w-10 h-10 text-green-400" />
            )}
          </div>
          <h2 className="text-xl font-bold">
            {step === 'disclosure' ? 'Background Check Disclosure' : 'Authorization'}
          </h2>
          <p className="text-sm text-slate-400 mt-1">Powered by Checkr • 256-bit SSL Encrypted</p>

          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2 mt-3">
            <div className={`h-1.5 w-12 rounded-full ${step === 'disclosure' ? 'bg-blue-400' : 'bg-green-400'}`} />
            <div className={`h-1.5 w-12 rounded-full ${step === 'form' ? 'bg-green-400' : 'bg-slate-600'}`} />
          </div>
        </div>

        {/* Step 1 — Disclosure */}
        {step === 'disclosure' && (
          <div className="p-6 space-y-4">
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <p className="text-sm font-semibold text-blue-900 mb-2">Disclosure Notice</p>
              <p className="text-xs text-blue-800 leading-relaxed">
                In connection with your application to provide care services through Evia, a consumer report (background check) will be obtained about you from <strong>Checkr, Inc.</strong>, a consumer reporting agency (FCRA § 604). This report may include criminal history and other public record information, and will be used solely to evaluate your eligibility to join the platform.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Your Rights Under the FCRA</p>
              <ul className="space-y-2">
                {[
                  'You have the right to know when a consumer report is being prepared about you.',
                  'You may request a free copy of your consumer report from Checkr within 60 days of any adverse action.',
                  'You have the right to dispute incomplete or inaccurate information in your report.',
                  'Checkr will provide you with "A Summary of Your Rights Under the Fair Credit Reporting Act" when you complete their verification form.',
                ].map((right, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    <span className="text-xs text-slate-600 leading-relaxed">{right}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-start gap-3">
              <Lock className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-500 leading-relaxed">
                Your SSN and date of birth are entered directly on Checkr's secure site — <strong>they are never transmitted to or stored by Evia</strong>.
              </p>
            </div>

            <Button
              fullWidth
              type="button"
              onClick={() => setStep('form')}
              className="bg-blue-600 hover:bg-blue-700 text-white mt-2"
            >
              I Understand — Continue to Authorization
            </Button>
          </div>
        )}

        {/* Step 2 — Authorization form */}
        {step === 'form' && (
          <div className="p-6">
            <button
              type="button"
              onClick={() => setStep('disclosure')}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-4"
            >
              <ChevronLeft size={14} /> Back to Disclosure
            </button>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Legal First Name"
                  required
                  value={formData.legalFirstName}
                  onChange={(e) => setFormData({ ...formData, legalFirstName: e.target.value })}
                />
                <Input
                  label="Legal Last Name"
                  required
                  value={formData.legalLastName}
                  onChange={(e) => setFormData({ ...formData, legalLastName: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Current Zip Code"
                  required
                  value={formData.zipCode}
                  onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                />
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    State <span className="text-red-500">*</span>
                  </label>
                  <select
                    required
                    value={formData.state}
                    onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none bg-white"
                  >
                    <option value="">Select state</option>
                    {["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 text-green-600 rounded border-slate-300 focus:ring-green-500"
                  checked={formData.consentGiven}
                  onChange={(e) => setFormData({ ...formData, consentGiven: e.target.checked })}
                />
                <span className="text-xs text-slate-600 leading-relaxed">
                  I have read the disclosure above and authorize Evia and Checkr, Inc. to obtain a consumer report (background check) about me for caregiving eligibility purposes under the FCRA. I understand that Checkr will email me a secure link to provide my SSN and date of birth directly on their platform. I agree to Checkr's{' '}
                  <a
                    href="https://checkr.com/customer-terms-of-service"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-blue-600"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Terms of Service
                  </a>{' '}
                  and{' '}
                  <a
                    href="https://checkr.com/privacy-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-blue-600"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Privacy Policy
                  </a>
                  .
                </span>
              </label>

              <Button
                fullWidth
                type="submit"
                disabled={loading || !formData.consentGiven || !formData.state}
                className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
              >
                {loading ? 'Submitting securely...' : 'Submit for Verification'}
              </Button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
