import React, { useState } from 'react';
import { Button } from '../../../ui/Button';

interface Step1Props {
  dateOfBirth: string;
  termsAccepted: boolean;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  onGoogleSignup?: () => Promise<void>;
  isLoading?: boolean;
}

export const Step1GetStarted: React.FC<Step1Props> = ({
  dateOfBirth,
  termsAccepted,
  onChange,
  onNext,
  onShowToast,
  onGoogleSignup,
  isLoading = false,
}) => {
  const [dobMonth, setDobMonth] = useState('');
  const [dobDay, setDobDay] = useState('');
  const [dobYear, setDobYear] = useState('');

  const updateDob = (month: string, day: string, year: string) => {
    setDobMonth(month);
    setDobDay(day);
    setDobYear(year);
    if (month && day && year.length === 4) {
      onChange('dateOfBirth', `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    }
  };

  const handleContinue = () => {
    const month = parseInt(dobMonth);
    const day = parseInt(dobDay);
    const year = parseInt(dobYear);

    if (!dobMonth || !dobDay || !dobYear || dobYear.length !== 4 || isNaN(month) || isNaN(day) || isNaN(year)) {
      onShowToast('Please enter a valid date of birth', 'error');
      return;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > new Date().getFullYear()) {
      onShowToast('Please enter a valid date of birth', 'error');
      return;
    }

    const birthDate = new Date(year, month - 1, day);
    // Check the Date object didn't roll over (e.g. Feb 31 → Mar 3)
    if (birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) {
      onShowToast('Please enter a valid date of birth', 'error');
      return;
    }

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    if (age < 18) {
      onShowToast('You must be at least 18 years old to sign up', 'error');
      return;
    }

    if (!termsAccepted) {
      onShowToast('Please agree to the Terms of Service and Privacy Policy', 'error');
      return;
    }

    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        Find great caregiving jobs
      </h1>
      <p className="text-slate-500 mb-8">Join families who need your help</p>

      {/* Date of Birth */}
      <div className="mb-6">
        <label className="block text-base font-semibold text-slate-800 mb-2">
          Date of birth <span className="text-slate-400 font-normal">(must be at least 18 yrs)</span>
        </label>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="MM"
            maxLength={2}
            value={dobMonth}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '');
              updateDob(v, dobDay, dobYear);
            }}
            className="w-20 px-4 py-3 rounded-xl border-2 border-slate-300 text-center text-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
          />
          <span className="flex items-center text-slate-400 text-xl">—</span>
          <input
            type="text"
            placeholder="DD"
            maxLength={2}
            value={dobDay}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '');
              updateDob(dobMonth, v, dobYear);
            }}
            className="w-20 px-4 py-3 rounded-xl border-2 border-slate-300 text-center text-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
          />
          <span className="flex items-center text-slate-400 text-xl">—</span>
          <input
            type="text"
            placeholder="YYYY"
            maxLength={4}
            value={dobYear}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '');
              updateDob(dobMonth, dobDay, v);
            }}
            className="w-28 px-4 py-3 rounded-xl border-2 border-slate-300 text-center text-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
          />
        </div>
      </div>


      {/* Terms */}
      <label className="flex items-start gap-3 mb-6 cursor-pointer">
        <input
          type="checkbox"
          checked={termsAccepted}
          onChange={(e) => onChange('termsAccepted', e.target.checked)}
          className="mt-1 w-5 h-5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
        />
        <span className="text-sm text-slate-600">
          By checking this box, I confirm that I have reviewed and agree to CareConnecxx's{' '}
          <a href="/privacy" className="text-primary-600 underline">Privacy Policy</a> &{' '}
          <a href="/terms" className="text-primary-600 underline">Terms of Service</a>
        </span>
      </label>

      {onGoogleSignup && (
        <>
          <button
            type="button"
            onClick={async () => {
              if (!termsAccepted) {
                onShowToast('Please agree to the Terms of Service and Privacy Policy', 'error');
                return;
              }
              await onGoogleSignup();
            }}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-700 font-semibold text-sm hover:bg-slate-50 hover:border-slate-400 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {isLoading ? "Signing up..." : "Continue with Google"}
          </button>

          <div className="flex items-center gap-3 my-2">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-400 font-medium">or</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>
        </>
      )}

      {/* Continue with Email */}
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={handleContinue}
        disabled={isLoading}
      >
        Sign up with email
      </Button>

      <p className="text-center mt-6 text-sm text-slate-500">
        Already have an account?{' '}
        <a href="/caregiver/login" className="text-primary-600 font-medium hover:underline">Log in</a>
      </p>
    </div>
  );
};
