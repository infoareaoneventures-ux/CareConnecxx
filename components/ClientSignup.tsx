import React, { useState, useCallback, useEffect } from 'react';
import { Activity, ArrowLeft, ShieldCheck, Check, Loader2 } from 'lucide-react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { LegalDocs } from './LegalDocs';
import { ViewType, AddToastFunction } from '../types';
import { authService } from '../services/api';
import { normalizePhoneNumber } from '../utils/validation';

function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

interface ClientSignupProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

interface GoogleConfirmData {
  uid: string;
  firstName: string;
  lastName: string;
  email: string;
}

export const ClientSignup: React.FC<ClientSignupProps> = ({ onNavigate, onShowToast }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [legalModal, setLegalModal] = useState<'privacy' | 'terms' | null>(null);
  const [googleConfirmData, setGoogleConfirmData] = useState<GoogleConfirmData | null>(null);
  const [googleConfirmLoading, setGoogleConfirmLoading] = useState(false);

  const prefillZip = sessionStorage.getItem('careconnex_signup_zip') || '';
  if (prefillZip) sessionStorage.removeItem('careconnex_signup_zip');

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    phone: '',
    street: '',
    zipCode: prefillZip,
    city: '',
    state: '',
  });

  const [zipLookingUp, setZipLookingUp] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [emailChecking, setEmailChecking] = useState(false);
  const [emailExists, setEmailExists] = useState(false);

  const passwordRequirements = [
    { label: 'At least 8 characters', met: formData.password.length >= 8 },
    { label: 'Contains uppercase letter', met: /[A-Z]/.test(formData.password) },
    { label: 'Contains lowercase letter', met: /[a-z]/.test(formData.password) },
    { label: 'Contains a number', met: /\d/.test(formData.password) },
  ];

  const checkEmailExists = useCallback(
    debounce(async (email: string) => {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      setEmailChecking(true);
      try {
        const exists = await authService.checkEmailExists(email);
        setEmailExists(exists);
        if (exists) {
          setFieldErrors(prev => ({ ...prev, email: 'This email is already registered. Please sign in instead.' }));
        }
      } catch {
        // non-critical
      } finally {
        setEmailChecking(false);
      }
    }, 500),
    []
  );

  const lookupZip = useCallback(
    debounce(async (zip: string) => {
      if (zip.length !== 5) return;
      setZipLookingUp(true);
      try {
        const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
        if (!res.ok) { setZipLookingUp(false); return; }
        const data = await res.json();
        const place = data.places?.[0];
        if (place) {
          setFormData(prev => ({
            ...prev,
            city: prev.city || place['place name'],
            state: prev.state || place['state abbreviation'],
          }));
        }
      } catch {
        // non-critical — user can fill in manually
      } finally {
        setZipLookingUp(false);
      }
    }, 400),
    []
  );

  useEffect(() => {
    if (prefillZip.length === 5) lookupZip(prefillZip);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    const errors = { ...fieldErrors };

    if (name === 'email') {
      if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.email = 'Please enter a valid email address';
        setEmailExists(false);
      } else {
        delete errors.email;
        setEmailExists(false);
        if (value) checkEmailExists(value);
      }
    }

    if (name === 'password') {
      if (value.length > 0 && value.length < 8) {
        errors.password = 'Password must be at least 8 characters';
      } else {
        delete errors.password;
      }
    }

    if (name === 'phone') {
      const digits = value.replace(/\D/g, '');
      if (digits.length > 0 && digits.length < 10) {
        errors.phone = 'Phone number must be 10 digits';
      } else {
        delete errors.phone;
      }
    }

    if (name === 'zipCode') {
      const digits = value.replace(/\D/g, '').slice(0, 5);
      // Reset city/state so autofill re-runs on new zip
      setFormData(prev => ({ ...prev, zipCode: digits, city: '', state: '' }));
      if (digits.length !== 5) {
        errors.zipCode = 'Please enter a 5-digit zip code';
      } else {
        delete errors.zipCode;
        lookupZip(digits);
      }
      setFieldErrors(errors);
      return; // formData already set above
    }

    setFieldErrors(errors);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.firstName.trim() || !formData.lastName.trim()) {
      onShowToast('Please enter your first and last name.', 'error'); return;
    }
    if (!formData.email) {
      onShowToast('Please enter your email address.', 'error'); return;
    }
    if (fieldErrors.email) {
      onShowToast(fieldErrors.email, 'error'); return;
    }
    if (emailExists) {
      onShowToast('This email is already registered. Please sign in instead.', 'error'); return;
    }
    const { password } = formData;
    if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      onShowToast('Password must have: 8+ characters, uppercase, lowercase, and a number.', 'error'); return;
    }
    const digits = formData.phone.replace(/\D/g, '');
    if (digits.length !== 10) {
      onShowToast('Please enter a valid 10-digit phone number.', 'error'); return;
    }
    if (!formData.street.trim()) {
      onShowToast('Please enter your street address.', 'error'); return;
    }
    if (formData.zipCode.length !== 5) {
      onShowToast('Please enter a valid 5-digit zip code.', 'error'); return;
    }
    if (!formData.city.trim()) {
      onShowToast('Please enter your city.', 'error'); return;
    }
    if (!formData.state.trim()) {
      onShowToast('Please enter your state.', 'error'); return;
    }

    setIsLoading(true);
    try {
      const normalizedPhone = normalizePhoneNumber(formData.phone) || formData.phone;
      const locationString = `${formData.city}, ${formData.state} ${formData.zipCode}`;
      await authService.signup(
        formData.email,
        formData.password,
        `${formData.firstName} ${formData.lastName}`,
        'client',
        {
          firstName: formData.firstName.trim(),
          lastName:  formData.lastName.trim(),
          phone: normalizedPhone,
          street: formData.street,
          zipCode: formData.zipCode,
          city: formData.city,
          state: formData.state,
          location: locationString,
        } as any
      );
      onShowToast('Welcome to CareConnex! Browse caregivers near you.', 'success');
      sessionStorage.setItem('careconnex_show_wizard', 'true');
      onNavigate('client');
    } catch (error: any) {
      let msg = error?.message || 'Failed to create account. Please try again.';
      if (msg.includes('already exists') || msg.includes('email-already-in-use')) {
        msg = 'An account with this email already exists. Try logging in or reset your password.';
      } else if (msg.includes('auth/invalid-email')) {
        msg = 'Please enter a valid email address.';
      } else if (msg.includes('auth/weak-password')) {
        msg = 'Password is too weak. Please use 8+ characters with uppercase, lowercase, and numbers.';
      } else if (msg.includes('auth/network-request-failed')) {
        msg = 'Network error. Please check your internet connection and try again.';
      } else if (msg.includes('auth/configuration-not-found') || msg.includes('not configured')) {
        msg = 'Service temporarily unavailable. Please try again in a few minutes.';
      }
      onShowToast(msg, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    setIsGoogleLoading(true);
    try {
      const result = await authService.signInWithGoogle('client');
      if (result.isNewUser) {
        const displayName = result.user.displayName || '';
        const parts = displayName.trim().split(' ');
        setGoogleConfirmData({
          uid: result.user.uid,
          firstName: parts[0] || '',
          lastName: parts.slice(1).join(' ') || '',
          email: result.user.email || '',
        });
      } else {
        onShowToast('Welcome back to CareConnex!', 'success');
        onNavigate('client');
      }
    } catch (error: unknown) {
      onShowToast(error instanceof Error ? error.message : 'Google sign-up failed', 'error');
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleGoogleConfirm = async () => {
    if (!googleConfirmData) return;
    if (!googleConfirmData.firstName.trim() || !googleConfirmData.lastName.trim()) {
      onShowToast('Please enter your first and last name.', 'error'); return;
    }
    setGoogleConfirmLoading(true);
    try {
      await authService.confirmGoogleUserName(
        googleConfirmData.uid,
        googleConfirmData.firstName,
        googleConfirmData.lastName
      );
      onShowToast('Welcome to CareConnex! Browse caregivers near you.', 'success');
      sessionStorage.setItem('careconnex_show_wizard', 'true');
      onNavigate('client');
    } catch {
      onShowToast('Failed to save your info. Please try again.', 'error');
    } finally {
      setGoogleConfirmLoading(false);
    }
  };

  // Google sign-up: name confirmation screen
  if (googleConfirmData) {
    return (
      <div className="min-h-screen bg-teal-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8 animate-slide-in">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="flex justify-center mb-6">
            <div className="bg-primary-600 p-3 rounded-xl">
              <Activity className="text-white w-8 h-8" />
            </div>
          </div>
        </div>
        <div className="mt-4 sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-indigo-600 py-8 px-6 rounded-2xl shadow-xl sm:px-10">
            <h2 className="text-2xl font-bold text-white text-center mb-1">Confirm your information</h2>
            <div className="flex justify-center mb-5">
              <div className="w-10 h-0.5 bg-cyan-400 rounded-full" />
            </div>
            <p className="text-indigo-100 text-sm text-center mb-6">
              For security, please make sure this is your legal first and last name.
            </p>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div>
                <label className="block text-xs font-medium text-indigo-200 mb-1">First Name</label>
                <input
                  type="text"
                  value={googleConfirmData.firstName}
                  onChange={e => setGoogleConfirmData(prev => prev ? { ...prev, firstName: e.target.value } : prev)}
                  className="w-full px-3 py-2 rounded-lg bg-white text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  placeholder="First"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-indigo-200 mb-1">Last Name</label>
                <input
                  type="text"
                  value={googleConfirmData.lastName}
                  onChange={e => setGoogleConfirmData(prev => prev ? { ...prev, lastName: e.target.value } : prev)}
                  className="w-full px-3 py-2 rounded-lg bg-white text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  placeholder="Last"
                />
              </div>
            </div>
            <p className="text-indigo-100 text-sm text-center mb-3">Is this the email you want to use?</p>
            <div className="mb-6">
              <label className="block text-xs font-medium text-indigo-200 mb-1">Email Address</label>
              <input
                type="email"
                value={googleConfirmData.email}
                readOnly
                className="w-full px-3 py-2 rounded-lg bg-indigo-500 text-white text-sm cursor-default focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={handleGoogleConfirm}
              disabled={googleConfirmLoading}
              className="w-full py-3 rounded-xl bg-white text-indigo-700 font-semibold text-sm hover:bg-indigo-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {googleConfirmLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8 animate-slide-in">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center mb-6">
          <div className="bg-primary-600 p-3 rounded-xl">
            <Activity className="text-white w-8 h-8" />
          </div>
        </div>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-xl rounded-2xl sm:px-10 border border-slate-100">

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <h2 className="text-2xl font-extrabold text-slate-900">Sign up for free</h2>
              <p className="text-sm text-slate-500 mt-1">Discover trusted caregivers with CareConnex.</p>
            </div>

            {/* Name */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input name="firstName" label="First Name" placeholder="Jane" required value={formData.firstName} onChange={handleChange} />
              <Input name="lastName" label="Last Name" placeholder="Doe" required value={formData.lastName} onChange={handleChange} />
            </div>

            {/* Email */}
            <div className="relative">
              <Input
                name="email"
                label="Email Address"
                type="email"
                placeholder="jane@example.com"
                required
                value={formData.email}
                onChange={handleChange}
                error={fieldErrors.email}
              />
              {emailChecking && (
                <div className="absolute right-3 top-9">
                  <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
                </div>
              )}
              {emailExists && !emailChecking && (
                <p className="text-sm text-red-600 mt-1">
                  This email is already registered.{' '}
                  <button type="button" onClick={() => onNavigate('client-login')} className="underline font-medium">
                    Sign in instead
                  </button>
                </p>
              )}
            </div>

            {/* Password */}
            <div>
              <Input
                name="password"
                label="Create Password"
                type="password"
                placeholder="••••••••"
                required
                value={formData.password}
                onChange={handleChange}
                error={fieldErrors.password}
              />
              {formData.password.length > 0 && (
                <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <ul className="space-y-1">
                    {passwordRequirements.map((req, idx) => (
                      <li key={idx} className={`text-sm flex items-center gap-2 ${req.met ? 'text-emerald-600' : 'text-slate-500'}`}>
                        <Check className={`w-4 h-4 ${req.met ? 'opacity-100' : 'opacity-30'}`} />
                        {req.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Phone */}
            <div>
              <Input
                name="phone"
                label="Phone Number"
                type="tel"
                placeholder="(555) 123-4567"
                required
                value={formData.phone}
                onChange={handleChange}
                error={fieldErrors.phone}
              />
              <p className="text-xs text-slate-500 mt-1">Used only for appointment reminders. Never shared without your consent.</p>
            </div>

            {/* Address */}
            <div>
              <Input
                name="street"
                label="Street Address"
                placeholder="123 Main St"
                required
                value={formData.street}
                onChange={handleChange}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Zip code */}
              <div className="relative">
                <Input
                  name="zipCode"
                  label="Zip Code"
                  placeholder="90210"
                  required
                  value={formData.zipCode}
                  onChange={handleChange}
                  error={fieldErrors.zipCode}
                />
                {zipLookingUp && (
                  <div className="absolute right-3 top-9">
                    <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
                  </div>
                )}
              </div>

              {/* City — autofilled */}
              <Input
                name="city"
                label="City"
                placeholder="Beverly Hills"
                required
                value={formData.city}
                onChange={handleChange}
              />
            </div>

            {/* State — autofilled */}
            <Input
              name="state"
              label="State"
              placeholder="CA"
              required
              value={formData.state}
              onChange={handleChange}
            />

            <div className="bg-primary-50 border border-primary-100 rounded-xl p-3 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-primary-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-primary-800">Your information is secure and never sold to third parties.</p>
            </div>

            <Button fullWidth type="submit" disabled={isLoading || isGoogleLoading || emailChecking || emailExists}>
              {isLoading ? 'Creating your account…' : 'Create Account'}
            </Button>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-xs text-slate-400 font-medium">or</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>

            <button
              type="button"
              onClick={handleGoogleSignUp}
              disabled={isGoogleLoading || isLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-700 font-semibold text-sm hover:bg-slate-50 hover:border-slate-400 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {isGoogleLoading ? 'Signing up...' : 'Continue with Google'}
            </button>

            <p className="text-xs text-slate-500 text-center">
              By signing up, you agree to our{' '}
              <button type="button" onClick={() => setLegalModal('terms')} className="text-primary-600 underline hover:text-primary-700">
                Terms of Service
              </button>
              {' '}and{' '}
              <button type="button" onClick={() => setLegalModal('privacy')} className="text-primary-600 underline hover:text-primary-700">
                Privacy Policy
              </button>
              .
            </p>
          </form>
        </div>

        <div className="mt-6 text-center">
          <button
            onClick={() => onNavigate('landing')}
            className="flex items-center justify-center mx-auto text-slate-400 hover:text-slate-600 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Home
          </button>
        </div>
      </div>

      {legalModal && <LegalDocs type={legalModal} onClose={() => setLegalModal(null)} />}
    </div>
  );
};
