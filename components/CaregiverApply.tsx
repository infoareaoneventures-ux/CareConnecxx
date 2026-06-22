import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Activity, ArrowLeft, ShieldCheck, Check, Loader2 } from 'lucide-react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { ViewType, AddToastFunction } from '../types';
import { authService } from '../services/api';
import { normalizePhoneNumber } from '../utils/validation';
import { geocodeToLatLng } from '../utils/geocode';

function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

interface CaregiverApplyProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

export const CaregiverApply: React.FC<CaregiverApplyProps> = ({ onNavigate, onShowToast }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [consentErrors, setConsentErrors] = useState<{ terms?: string; sms?: string }>({});

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    phone: '',
    street: '',
    zipCode: '',
    city: '',
    state: '',
  });

  const [zipLookingUp, setZipLookingUp] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [emailChecking, setEmailChecking] = useState(false);
  const [emailExists, setEmailExists] = useState(false);

  // Mirror the latest form values so the debounced async callbacks can drop
  // stale (out-of-order) responses instead of clobbering newer user input.
  const formDataRef = useRef(formData);
  formDataRef.current = formData;

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
        // Drop stale results: only apply if the email hasn't changed since this call started.
        if (formDataRef.current.email !== email) return;
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
        // Drop stale results: only apply if the zip hasn't changed since this call started.
        if (formDataRef.current.zipCode !== zip) return;
        const place = data.places?.[0];
        if (place) {
          setFormData(prev => ({
            ...prev,
            city: prev.city || place['place name'],
            state: prev.state || place['state abbreviation'],
          }));
        }
      } catch {
        // non-critical
      } finally {
        setZipLookingUp(false);
      }
    }, 400),
    []
  );

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
      const digits = value.replace(/\D/g, '').slice(0, 10);
      let formatted = digits;
      if (digits.length > 6) formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      else if (digits.length > 3) formatted = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
      else if (digits.length > 0) formatted = `(${digits}`;
      setFormData(prev => ({ ...prev, phone: formatted }));
      if (digits.length > 0 && digits.length < 10) {
        errors.phone = 'Phone number must be 10 digits';
      } else {
        delete errors.phone;
      }
      setFieldErrors(errors);
      return;
    }

    if (name === 'zipCode') {
      const digits = value.replace(/\D/g, '').slice(0, 5);
      setFormData(prev => ({ ...prev, zipCode: digits, city: '', state: '' }));
      if (digits.length !== 5) {
        errors.zipCode = 'Please enter a 5-digit zip code';
      } else {
        delete errors.zipCode;
        lookupZip(digits);
      }
      setFieldErrors(errors);
      return;
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
    const errors: { terms?: string; sms?: string } = {};
    if (!termsAccepted) errors.terms = 'Please agree to the Terms of Service and Privacy Policy';
    if (!smsConsent) errors.sms = 'Please consent to receive text messages to continue';
    if (Object.keys(errors).length > 0) {
      setConsentErrors(errors);
      onShowToast(Object.values(errors)[0], 'error');
      return;
    }

    setIsLoading(true);
    try {
      const normalizedPhone = normalizePhoneNumber(formData.phone) || formData.phone;
      const locationString = `${formData.city}, ${formData.state} ${formData.zipCode}`;
      const coords = await geocodeToLatLng(formData.street, formData.city, formData.state, formData.zipCode);
      await authService.signup(
        formData.email,
        formData.password,
        `${formData.firstName} ${formData.lastName}`,
        'caregiver',
        {
          firstName: formData.firstName.trim(),
          lastName: formData.lastName.trim(),
          phone: normalizedPhone,
          street: formData.street,
          zipCode: formData.zipCode,
          city: formData.city,
          state: formData.state,
          location: locationString,
          latitude: coords?.lat ?? null,
          longitude: coords?.lng ?? null,
          onboardingStatus: 'incomplete',
        } as any
      );
      onShowToast('Welcome to CareConnex! Complete your profile to start finding jobs.', 'success');
      onNavigate('caregiver');
    } catch (error: any) {
      let msg = error?.message || 'Failed to create account. Please try again.';
      if (msg.includes('already exists') || msg.includes('email-already-in-use')) {
        msg = 'An account with this email already exists. Try logging in instead.';
      } else if (msg.includes('auth/invalid-email')) {
        msg = 'Please enter a valid email address.';
      } else if (msg.includes('auth/weak-password')) {
        msg = 'Password is too weak. Please use 8+ characters with uppercase, lowercase, and numbers.';
      } else if (msg.includes('auth/network-request-failed')) {
        msg = 'Network error. Please check your internet connection and try again.';
      }
      onShowToast(msg, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col animate-slide-in">
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => onNavigate('landing')}>
              <div className="bg-slate-900 p-2 rounded-xl shadow-lg shadow-slate-200">
                <Activity className="text-white w-5 h-5" />
              </div>
              <span className="text-xl font-bold text-slate-900 tracking-tight">CareConnex</span>
            </div>
            <nav className="hidden md:flex items-center gap-8">
              <button onClick={() => onNavigate('caregiver-jobs')} className="text-slate-600 hover:text-slate-900 font-medium transition-colors text-sm">Find Jobs</button>
              <a href="/help" className="text-slate-600 hover:text-slate-900 font-medium transition-colors text-sm">Help</a>
            </nav>
            <div className="flex items-center gap-3">
              <button onClick={() => onNavigate('caregiver-login')} className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">Log In</button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <div className="sm:mx-auto sm:w-full sm:max-w-md">
            <div className="bg-white py-8 px-4 shadow-xl rounded-2xl sm:px-10 border border-slate-100">
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <h2 className="text-2xl font-extrabold text-slate-900">Apply as a Caregiver</h2>
                  <p className="text-sm text-slate-500 mt-1">Join CareConnex and start connecting with families.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input name="firstName" label="First Name" placeholder="Jane" required value={formData.firstName} onChange={handleChange} />
                  <Input name="lastName" label="Last Name" placeholder="Doe" required value={formData.lastName} onChange={handleChange} />
                </div>

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
                      <button type="button" onClick={() => onNavigate('caregiver-login')} className="underline font-medium">
                        Sign in instead
                      </button>
                    </p>
                  )}
                </div>

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
                  <Input
                    name="city"
                    label="City"
                    placeholder="Beverly Hills"
                    required
                    value={formData.city}
                    onChange={handleChange}
                  />
                </div>

                <Input
                  name="state"
                  label="State"
                  placeholder="CA"
                  required
                  value={formData.state}
                  onChange={handleChange}
                />

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-start gap-3">
                  <ShieldCheck className="w-5 h-5 text-slate-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-slate-800">Your information is secure and never sold to third parties.</p>
                </div>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={e => { setTermsAccepted(e.target.checked); setConsentErrors(prev => ({ ...prev, terms: undefined })); }}
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 flex-shrink-0"
                  />
                  <span className={`text-xs leading-relaxed ${consentErrors.terms ? 'text-red-600' : 'text-slate-600'}`}>
                    I agree to CareConnex's{' '}
                    <a href="/terms" target="_blank" rel="noreferrer" className="text-slate-900 font-medium underline hover:text-slate-700">Terms of Service</a>
                    {' '}and{' '}
                    <a href="/privacy" target="_blank" rel="noreferrer" className="text-slate-900 font-medium underline hover:text-slate-700">Privacy Policy</a>.
                  </span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smsConsent}
                    onChange={e => { setSmsConsent(e.target.checked); setConsentErrors(prev => ({ ...prev, sms: undefined })); }}
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 flex-shrink-0"
                  />
                  <span className={`text-xs leading-relaxed ${consentErrors.sms ? 'text-red-600' : 'text-slate-600'}`}>
                    I consent to receive text messages (SMS/MMS) from CareConnex at the phone number provided, including job alerts and care updates. Message &amp; data rates may apply. Reply STOP to opt out at any time.
                  </span>
                </label>

                <Button fullWidth type="submit" disabled={isLoading || emailChecking || emailExists}>
                  {isLoading ? 'Creating your account…' : 'Create Account'}
                </Button>
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
        </div>
      </div>
    </div>
  );
};
