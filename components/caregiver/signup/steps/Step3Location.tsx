import React, { useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { Input } from '../../../ui/Input';
import { Button } from '../../../ui/Button';
import { US_STATES } from '../constants';

interface Step3Props {
  street: string;
  apt: string;
  zipCode: string;
  city: string;
  state: string;
  neighborhood: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

export const Step3Location: React.FC<Step3Props> = ({
  street,
  apt,
  zipCode,
  city,
  state,
  neighborhood,
  onChange,
  onNext,
  onBack,
  onShowToast,
  isLoading,
}) => {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!street.trim()) newErrors.street = 'Street address is required';
    if (!zipCode.trim()) newErrors.zipCode = 'Zip code is required';
    else if (!/^\d{5}(-\d{4})?$/.test(zipCode.trim())) newErrors.zipCode = 'Invalid zip code';
    if (!city.trim()) newErrors.city = 'City is required';
    if (!state) newErrors.state = 'State is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleContinue = () => {
    if (!validate()) {
      onShowToast('Please fill in all required fields', 'error');
      return;
    }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        Find trusted jobs nearby
      </h1>
      <p className="text-slate-500 mb-6">Your address helps us match you with families in your area</p>

      <div className="grid grid-cols-[1fr_120px] gap-4">
        <Input
          label="Street"
          placeholder="Street"
          value={street}
          onChange={(e) => onChange('street', e.target.value)}
          error={errors.street}
        />
        <Input
          label="Apt #"
          placeholder="Apt #"
          value={apt}
          onChange={(e) => onChange('apt', e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Zip code"
          placeholder="Zip"
          value={zipCode}
          onChange={(e) => onChange('zipCode', e.target.value.replace(/[^\d-]/g, ''))}
          error={errors.zipCode}
        />
        <Input
          label="City"
          placeholder="City"
          value={city}
          onChange={(e) => onChange('city', e.target.value)}
          error={errors.city}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="w-full mb-4">
          <label className="block text-base font-semibold text-slate-800 mb-2">
            State
          </label>
          <select
            value={state}
            onChange={(e) => onChange('state', e.target.value)}
            className={`w-full px-4 py-4 rounded-xl border-2 bg-white text-lg text-slate-900 focus:outline-none focus:ring-2 transition-all duration-200 ${
              errors.state
                ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
                : 'border-slate-300 focus:border-primary-500 focus:ring-primary-100 hover:border-slate-400'
            }`}
          >
            <option value="">State</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {errors.state && (
            <p className="mt-2 text-sm text-red-600 font-medium">{errors.state}</p>
          )}
        </div>
        <Input
          label="Neighborhood"
          placeholder="Neighborhood (Optional)"
          value={neighborhood}
          onChange={(e) => onChange('neighborhood', e.target.value)}
        />
      </div>

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
              <Loader2 className="w-5 h-5 animate-spin" /> Saving...
            </span>
          ) : (
            'Continue'
          )}
        </Button>
      </div>
    </div>
  );
};
