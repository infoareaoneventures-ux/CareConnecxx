import React, { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { validators } from '../../../../utils/validation';

interface Step2Props {
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
  phone: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

const formatPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
};

export const Step2AccountInfo: React.FC<Step2Props> = ({
  email,
  password,
  confirmPassword,
  firstName,
  lastName,
  phone,
  onChange,
  onNext,
  onBack,
  onShowToast,
  isLoading,
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): Record<string, string> => {
    const newErrors: Record<string, string> = {};

    if (!firstName.trim()) newErrors.firstName = 'First name is required';
    if (!lastName.trim()) newErrors.lastName = 'Last name is required';
    if (!email.trim()) newErrors.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) newErrors.email = 'Invalid email address';

    const passwordError = validators.password(password);
    if (passwordError) newErrors.password = passwordError;
    if (password !== confirmPassword) newErrors.confirmPassword = 'Passwords do not match';

    if (!phone) newErrors.phone = 'Phone number is required';
    else if (phone.length !== 10) newErrors.phone = 'Phone must be 10 digits';

    setErrors(newErrors);
    return newErrors;
  };

  const handleContinue = () => {
    const newErrors = validate();
    if (Object.keys(newErrors).length > 0) {
      onShowToast(Object.values(newErrors)[0], 'error');
      return;
    }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        There's a new family that can't wait to meet you
      </h1>
      <p className="text-slate-500 mb-6">Create your caregiver account</p>

      <Input
        label="Email"
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => onChange('email', e.target.value)}
        error={errors.email}
      />

      <div className="grid grid-cols-2 gap-4">
        <div className="relative">
          <Input
            label="Password"
            type={showPassword ? 'text' : 'password'}
            placeholder="Password"
            value={password}
            onChange={(e) => onChange('password', e.target.value)}
            error={errors.password}
          />
        </div>
        <div className="relative">
          <Input
            label="Confirm Password"
            type={showPassword ? 'text' : 'password'}
            placeholder="Retype password"
            value={confirmPassword}
            onChange={(e) => onChange('confirmPassword', e.target.value)}
            error={errors.confirmPassword}
          />
        </div>
      </div>

      {/* Password toggle */}
      <button
        type="button"
        onClick={() => setShowPassword(!showPassword)}
        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4 -mt-2"
      >
        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        {showPassword ? 'Hide' : 'Show'} password
      </button>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="First Name"
          placeholder="First Name"
          value={firstName}
          onChange={(e) => onChange('firstName', e.target.value)}
          error={errors.firstName}
        />
        <Input
          label="Last Name"
          placeholder="Last Name"
          value={lastName}
          onChange={(e) => onChange('lastName', e.target.value)}
          error={errors.lastName}
        />
      </div>

      <Input
        label="Phone Number"
        type="tel"
        placeholder="(xxx) xxx-xxxx"
        value={formatPhone(phone)}
        onChange={(e) => onChange('phone', e.target.value.replace(/\D/g, '').slice(0, 10))}
        error={errors.phone}
      />

      <div className="flex gap-3 mt-6">
        <Button variant="secondary" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleContinue}
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Creating account...
            </span>
          ) : (
            'Continue'
          )}
        </Button>
      </div>
    </div>
  );
};
