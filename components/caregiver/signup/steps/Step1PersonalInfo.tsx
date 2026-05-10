import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Loader2, MapPin } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { validators } from '../../../../utils/validation';

interface Step1Props {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  email: string;
  password: string;
  phone: string;
  termsAccepted: boolean;
  street: string;
  zipCode: string;
  city: string;
  state: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  onGoogleSignup?: () => Promise<void>;
  isLoading: boolean;
}

const formatPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
};

export const Step1PersonalInfo: React.FC<Step1Props> = ({
  firstName, lastName, dateOfBirth, email, password, phone, termsAccepted,
  street, zipCode, city, state,
  onChange, onNext, onShowToast, onGoogleSignup, isLoading,
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [zipLoading, setZipLoading] = useState(false);

  const [dobMonth, setDobMonth] = useState(() => dateOfBirth ? dateOfBirth.split('-')[1] || '' : '');
  const [dobDay, setDobDay] = useState(() => dateOfBirth ? dateOfBirth.split('-')[2] || '' : '');
  const [dobYear, setDobYear] = useState(() => dateOfBirth ? dateOfBirth.split('-')[0] || '' : '');

  const updateDob = (month: string, day: string, year: string) => {
    setDobMonth(month);
    setDobDay(day);
    setDobYear(year);
    if (month && day && year.length === 4) {
      onChange('dateOfBirth', `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    }
  };

  useEffect(() => {
    const clean = zipCode.replace(/\D/g, '');
    if (clean.length !== 5) return;
    setZipLoading(true);
    fetch(`https://api.zippopotam.us/us/${clean}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        onChange('city', data.places[0]['place name']);
        onChange('state', data.places[0]['state abbreviation']);
      })
      .catch(() => {})
      .finally(() => setZipLoading(false));
  }, [zipCode]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};

    if (!firstName.trim()) e.firstName = 'First name is required';
    if (!lastName.trim()) e.lastName = 'Last name is required';

    const month = parseInt(dobMonth);
    const day = parseInt(dobDay);
    const year = parseInt(dobYear);
    if (!dobMonth || !dobDay || !dobYear || dobYear.length !== 4 || isNaN(month) || isNaN(day) || isNaN(year)) {
      e.dob = 'Enter a valid date of birth';
    } else if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > new Date().getFullYear()) {
      e.dob = 'Enter a valid date of birth';
    } else {
      const birthDate = new Date(year, month - 1, day);
      if (birthDate.getMonth() !== month - 1 || birthDate.getDate() !== day) {
        e.dob = 'Enter a valid date of birth';
      } else {
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        if (today.getMonth() < birthDate.getMonth() || (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())) age--;
        if (age < 18) e.dob = 'You must be at least 18 years old';
      }
    }

    if (!email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Invalid email address';

    const passwordError = validators.password(password);
    if (passwordError) e.password = passwordError;

    const phoneDigits = phone.replace(/\D/g, '');
    if (!phoneDigits) e.phone = 'Phone number is required';
    else if (phoneDigits.length !== 10) e.phone = 'Phone must be 10 digits';

    if (!street.trim()) e.street = 'Street address is required';
    if (!zipCode.trim()) e.zipCode = 'Zip code is required';
    else if (!/^\d{5}$/.test(zipCode.trim())) e.zipCode = 'Enter a 5-digit zip code';
    if (!city.trim()) e.city = 'City is required';
    if (!state.trim()) e.state = 'State is required';

    if (!termsAccepted) e.terms = 'Please agree to the Terms of Service and Privacy Policy';

    setErrors(e);
    if (Object.keys(e).length > 0) {
      onShowToast(Object.values(e)[0], 'error');
      return false;
    }
    return true;
  };

  const handleContinue = () => {
    if (validate()) onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">Find great caregiving jobs</h1>
      <p className="text-slate-500 mb-6">Join families who need your help</p>


      {/* Name */}
      <div className="grid grid-cols-2 gap-4">
        <Input label="First Name" placeholder="First name" value={firstName}
          onChange={e => onChange('firstName', e.target.value)} error={errors.firstName} />
        <Input label="Last Name" placeholder="Last name" value={lastName}
          onChange={e => onChange('lastName', e.target.value)} error={errors.lastName} />
      </div>

      {/* Date of Birth */}
      <div className="mb-4">
        <label className="block text-base font-semibold text-slate-800 mb-2">
          Date of birth <span className="text-slate-400 font-normal text-sm">(must be 18+)</span>
        </label>
        <div className="flex gap-3">
          <input type="text" placeholder="MM" maxLength={2} value={dobMonth}
            onChange={e => updateDob(e.target.value.replace(/\D/g, ''), dobDay, dobYear)}
            className={`w-20 px-4 py-3 rounded-xl border-2 text-center text-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${errors.dob ? 'border-red-400' : 'border-slate-300'}`} />
          <span className="flex items-center text-slate-400 text-xl">—</span>
          <input type="text" placeholder="DD" maxLength={2} value={dobDay}
            onChange={e => updateDob(dobMonth, e.target.value.replace(/\D/g, ''), dobYear)}
            className={`w-20 px-4 py-3 rounded-xl border-2 text-center text-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${errors.dob ? 'border-red-400' : 'border-slate-300'}`} />
          <span className="flex items-center text-slate-400 text-xl">—</span>
          <input type="text" placeholder="YYYY" maxLength={4} value={dobYear}
            onChange={e => updateDob(dobMonth, dobDay, e.target.value.replace(/\D/g, ''))}
            className={`w-28 px-4 py-3 rounded-xl border-2 text-center text-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${errors.dob ? 'border-red-400' : 'border-slate-300'}`} />
        </div>
        {errors.dob && <p className="mt-2 text-sm text-red-600 font-medium">{errors.dob}</p>}
      </div>

      {/* Email */}
      <Input label="Email address" type="email" placeholder="you@example.com" value={email}
        onChange={e => onChange('email', e.target.value)} error={errors.email} />

      {/* Password */}
      <div className="relative mb-4">
        <Input label="Password" type={showPassword ? 'text' : 'password'} placeholder="Password"
          value={password} onChange={e => onChange('password', e.target.value)} error={errors.password} />
        <button type="button" onClick={() => setShowPassword(s => !s)}
          className="absolute right-4 top-[42px] text-slate-400 hover:text-slate-600">
          {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
        </button>
      </div>

      {/* Phone */}
      <Input label="Phone number" type="tel" placeholder="(xxx) xxx-xxxx"
        value={formatPhone(phone)}
        onChange={e => onChange('phone', e.target.value.replace(/\D/g, '').slice(0, 10))}
        error={errors.phone} />

      {/* Location divider */}
      <div className="flex items-center gap-3 my-5">
        <div className="flex-1 h-px bg-slate-200" />
        <span className="flex items-center gap-1.5 text-xs text-slate-400 font-medium">
          <MapPin className="w-3.5 h-3.5" /> Your location
        </span>
        <div className="flex-1 h-px bg-slate-200" />
      </div>

      {/* Street */}
      <Input label="Street address" placeholder="Street" value={street}
        onChange={e => onChange('street', e.target.value)} error={errors.street} />

      {/* Zip + City + State */}
      <div className="grid grid-cols-3 gap-4">
        <div className="relative">
          <Input label="Zip code" placeholder="Zip" value={zipCode}
            onChange={e => onChange('zipCode', e.target.value.replace(/\D/g, '').slice(0, 5))}
            error={errors.zipCode} />
          {zipLoading && (
            <Loader2 className="w-4 h-4 animate-spin text-primary-500 absolute right-3 top-[42px]" />
          )}
        </div>
        <Input label="City" placeholder="City" value={city}
          onChange={e => onChange('city', e.target.value)} error={errors.city} />
        <Input label="State" placeholder="State" value={state}
          onChange={e => onChange('state', e.target.value)} error={errors.state} />
      </div>

      {/* Terms */}
      <label className="flex items-start gap-3 mt-2 mb-6 cursor-pointer">
        <input type="checkbox" checked={termsAccepted}
          onChange={e => onChange('termsAccepted', e.target.checked)}
          className="mt-1 w-5 h-5 rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
        <span className={`text-sm ${errors.terms ? 'text-red-600' : 'text-slate-600'}`}>
          I agree to CareConnecxx's{' '}
          <a href="/privacy" className="text-primary-600 underline">Privacy Policy</a> &{' '}
          <a href="/terms" className="text-primary-600 underline">Terms of Service</a>
        </span>
      </label>

      <Button variant="primary" size="lg" fullWidth onClick={handleContinue} disabled={isLoading}>
        {isLoading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Creating account...
          </span>
        ) : 'Continue'}
      </Button>

      {onGoogleSignup && (
        <>
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-400 font-medium">or</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>
          <button
            type="button"
            onClick={async () => {
              if (!termsAccepted) { onShowToast('Please agree to the Terms of Service and Privacy Policy', 'error'); return; }
              await onGoogleSignup();
            }}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-700 font-semibold text-sm hover:bg-slate-50 hover:border-slate-400 transition-all shadow-sm disabled:opacity-50"
          >
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {isLoading ? 'Signing up...' : 'Continue with Google'}
          </button>
        </>
      )}

      <p className="text-center mt-6 text-sm text-slate-500">
        Already have an account?{' '}
        <a href="/caregiver/login" className="text-primary-600 font-medium hover:underline">Log in</a>
      </p>
    </div>
  );
};
