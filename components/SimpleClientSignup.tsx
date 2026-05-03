import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Check, Eye, EyeOff, Activity } from 'lucide-react';
import firebase from 'firebase/compat/app';
import { auth, db } from '../lib/firebase';
import { useCareConnex } from '../context/CareConnexContext';

export default function SimpleClientSignup() {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    password: '',
    confirmPassword: '',
    streetAddress: '',
    city: '',
    state: '',
    zipCode: '',
    residenceDuration: '',
  });

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setError('');
  };

  const validateForm = (): boolean => {
    // Check each field and show specific error
    if (!formData.firstName?.trim()) {
      setError('Please enter your first name');
      return false;
    }
    if (!formData.lastName?.trim()) {
      setError('Please enter your last name');
      return false;
    }
    if (!formData.phone?.trim()) {
      setError('Please enter your phone number');
      return false;
    }
    if (!/^\d{10}$/.test(formData.phone.replace(/\D/g, ''))) {
      setError('Please enter a valid 10-digit phone number');
      return false;
    }
    if (!formData.email?.trim()) {
      setError('Please enter your email');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setError('Please enter a valid email (e.g., name@example.com)');
      return false;
    }
    if (!formData.streetAddress?.trim()) {
      setError('Please enter the street address');
      return false;
    }
    if (!formData.city?.trim()) {
      setError('Please enter the city');
      return false;
    }
    if (!formData.state?.trim()) {
      setError('Please enter the state');
      return false;
    }
    if (!formData.zipCode?.trim()) {
      setError('Please enter your ZIP code');
      return false;
    }
    if (!/^\d{5}(-\d{4})?$/.test(formData.zipCode)) {
      setError('Please enter a valid 5-digit ZIP code');
      return false;
    }
    if (!formData.residenceDuration?.trim()) {
      setError('Please enter how long you have been at your current residence');
      return false;
    }
    if (!formData.password) {
      setError('Please create a password');
      return false;
    }
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters long');
      return false;
    }
    if (!formData.confirmPassword) {
      setError('Please confirm your password');
      return false;
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Clear any previous errors
    setError('');
    
    // Validate form
    if (!validateForm()) {
      return;
    }
    
    setIsSubmitting(true);

    try {
      if (!auth || !db) {
        setError('Unable to connect to server. Please check your internet connection and try again.');
        setIsSubmitting(false);
        return;
      }

      const userCredential = await auth.createUserWithEmailAndPassword(
        formData.email,
        formData.password
      );

      const user = userCredential.user;

      if (!user) {
        throw new Error('Failed to create user');
      }

      await user.updateProfile({
        displayName: `${formData.firstName} ${formData.lastName}`,
      });

      const fullName = `${formData.firstName} ${formData.lastName}`;

      // Create minimal intake data
      const intakeData = {
        recipientName: fullName,
        recipientFirstName: formData.firstName,
        recipientLastName: formData.lastName,
        relationship: 'Self',
        careTypes: [], // Will be filled in "Update Care Plan"
        streetAddress: formData.streetAddress,
        city: formData.city,
        state: formData.state,
        zipCode: formData.zipCode,
        schedule: 'Flexible Schedule',
        startDate: 'ASAP',
        duration: 'Ongoing',
        additionalComments: '',
        contactName: fullName,
        phone: formData.phone,
        email: formData.email,
        userId: user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'incomplete',
      };

      await db.collection('clientIntakes').doc(user.uid).set(intakeData);

      await db.collection('users').doc(user.uid).set({
        uid: user.uid,
        email: formData.email,
        phone: formData.phone,
        displayName: fullName,
        firstName: formData.firstName,
        lastName: formData.lastName,
        role: 'client',
        residenceDuration: formData.residenceDuration,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        intakeCompleted: false,
      });

      // Create admin notification
      await db.collection('adminNotifications').add({
        type: 'new_client_signup',
        clientId: user.uid,
        clientName: fullName,
        careRecipientName: fullName,
        careTypes: [],
        location: `${formData.city}, ${formData.state}`,
        status: 'incomplete_intake',
        createdAt: new Date().toISOString(),
        read: false,
        dismissed: false
      });

      addToast('Welcome! Please complete your intake to get matched with caregivers.', 'success');
      navigate('/client/dashboard', { replace: true });
    } catch (err: any) {
      console.error('Signup error:', err);
      
      let errorMessage = 'Failed to create account. Please try again.';
      
      if (err.code === 'auth/email-already-in-use') {
        errorMessage = 'An account with this email already exists. Please sign in instead.';
      } else if (err.code === 'auth/invalid-email') {
        errorMessage = 'Invalid email address. Please check and try again.';
      } else if (err.code === 'auth/weak-password') {
        errorMessage = 'Password is too weak. Please use at least 8 characters.';
      } else if (err.code === 'auth/network-request-failed') {
        errorMessage = 'Network error. Please check your connection and try again.';
      } else if (err.code === 'auth/timeout') {
        errorMessage = 'Request timed out. Please try again.';
      } else if (err.message) {
        errorMessage = err.message;
      }
      
      setError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-blue-600 p-2 rounded-xl">
              <Activity className="text-white w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-slate-900">CareConnex</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-4 py-8">
        {/* Back Button */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center text-slate-500 hover:text-slate-700 mb-6 transition-colors"
        >
          <ChevronLeft className="w-5 h-5 mr-1" />
          Back
        </button>

        {/* Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Create Your Account
          </h1>
          <p className="text-slate-600">
            Let's get started finding the perfect care for you or your loved one.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-4">
          {/* Name Fields */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                First Name *
              </label>
              <input
                type="text"
                value={formData.firstName}
                onChange={(e) => updateField('firstName', e.target.value)}
                onInput={(e) => updateField('firstName', (e.target as HTMLInputElement).value)}
                placeholder="First name"
                autoComplete="given-name"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Last Name *
              </label>
              <input
                type="text"
                value={formData.lastName}
                onChange={(e) => updateField('lastName', e.target.value)}
                onInput={(e) => updateField('lastName', (e.target as HTMLInputElement).value)}
                placeholder="Last name"
                autoComplete="family-name"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
          </div>

          {/* Phone */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Phone Number *
            </label>
            <input
              type="tel"
              value={formData.phone}
              onChange={(e) => updateField('phone', e.target.value)}
              onInput={(e) => updateField('phone', (e.target as HTMLInputElement).value)}
              placeholder="(555) 123-4567"
              autoComplete="tel"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Email Address *
            </label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => updateField('email', e.target.value)}
              onInput={(e) => updateField('email', (e.target as HTMLInputElement).value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>

          {/* Service Address */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Service Address *
            </label>
            <input
              type="text"
              value={formData.streetAddress}
              onChange={(e) => updateField('streetAddress', e.target.value)}
              onInput={(e) => updateField('streetAddress', (e.target as HTMLInputElement).value)}
              placeholder="Street address where care is needed"
              autoComplete="street-address"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>

          {/* City, State, ZIP */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                City *
              </label>
              <input
                type="text"
                value={formData.city}
                onChange={(e) => updateField('city', e.target.value)}
                onInput={(e) => updateField('city', (e.target as HTMLInputElement).value)}
                placeholder="City"
                autoComplete="address-level2"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                State *
              </label>
              <input
                type="text"
                value={formData.state}
                onChange={(e) => updateField('state', e.target.value)}
                onInput={(e) => updateField('state', (e.target as HTMLInputElement).value)}
                placeholder="State"
                autoComplete="address-level1"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                ZIP *
              </label>
              <input
                type="text"
                value={formData.zipCode}
                onChange={(e) => updateField('zipCode', e.target.value)}
                onInput={(e) => updateField('zipCode', (e.target as HTMLInputElement).value)}
                placeholder="ZIP"
                autoComplete="postal-code"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
          </div>

          {/* Residence Duration */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              How long at current residence? *
            </label>
            <input
              type="text"
              value={formData.residenceDuration}
              onChange={(e) => updateField('residenceDuration', e.target.value)}
              onInput={(e) => updateField('residenceDuration', (e.target as HTMLInputElement).value)}
              placeholder="e.g., 2 years, 6 months"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Create Password *
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={formData.password}
                onChange={(e) => updateField('password', e.target.value)}
                onInput={(e) => updateField('password', (e.target as HTMLInputElement).value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Confirm Password *
            </label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                value={formData.confirmPassword}
                onChange={(e) => updateField('confirmPassword', e.target.value)}
                onInput={(e) => updateField('confirmPassword', (e.target as HTMLInputElement).value)}
                placeholder="Confirm your password"
                autoComplete="new-password"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all pr-10"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-2 border-red-200 rounded-xl animate-pulse">
              <p className="text-sm font-medium text-red-700">{error}</p>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-4 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-h-[56px] touch-manipulation"
          >
            {isSubmitting ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                Creating Account...
              </>
            ) : (
              <>
                <Check className="w-5 h-5 mr-2" />
                Create Account
              </>
            )}
          </button>
        </form>

        {/* Footer */}
        <p className="text-center text-sm text-slate-500 mt-6">
          Already have an account?{' '}
          <a href="/login" className="text-blue-600 hover:underline font-medium">
            Sign in
          </a>
        </p>
      </main>
    </div>
  );
}
