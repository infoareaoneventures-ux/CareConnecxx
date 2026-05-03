import React, { useState } from 'react';
import { ChevronDown, ChevronUp, DollarSign, Loader2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { MAX_CLIENTS_OPTIONS } from '../constants';

interface Step7Props {
  hourlyRate: string;
  rateFor2Seniors: string;
  rateFor3PlusSeniors: string;
  maxClients: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

export const Step7Rates: React.FC<Step7Props> = ({
  hourlyRate,
  rateFor2Seniors,
  rateFor3PlusSeniors,
  maxClients,
  onChange,
  onNext,
  onBack,
  onShowToast,
  isLoading,
}) => {
  const [showDetailed, setShowDetailed] = useState(false);

  const handleRateChange = (field: string, value: string) => {
    // Only allow digits
    const cleaned = value.replace(/\D/g, '');
    onChange(field, cleaned);
  };

  const handleContinue = () => {
    if (!hourlyRate) {
      onShowToast('Please enter your minimum hourly rate', 'error');
      return;
    }
    const rate = parseInt(hourlyRate);
    if (rate < 15 || rate > 200) {
      onShowToast('Hourly rate must be between $15 and $200', 'error');
      return;
    }
    if (rateFor2Seniors) {
      const r2 = parseInt(rateFor2Seniors);
      if (r2 < 15 || r2 > 200) {
        onShowToast('Rate for 2 seniors must be between $15 and $200', 'error');
        return;
      }
    }
    if (rateFor3PlusSeniors) {
      const r3 = parseInt(rateFor3PlusSeniors);
      if (r3 < 15 || r3 > 200) {
        onShowToast('Rate for 3+ seniors must be between $15 and $200', 'error');
        return;
      }
    }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        What is your minimum rate?
      </h1>
      <p className="text-slate-500 mb-6">
        Caregivers in your area are charging <span className="font-semibold text-slate-700">$24/hr</span> for one senior
      </p>

      {/* Minimum Rate */}
      <div className="mb-4">
        <label className="block text-base font-semibold text-slate-800 mb-2">
          Minimum rate
        </label>
        <div className="flex items-center">
          <span className="flex items-center justify-center w-12 h-14 bg-slate-100 border-2 border-r-0 border-slate-300 rounded-l-xl text-slate-500 font-semibold">
            $
          </span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="Minimum hourly rate"
            value={hourlyRate}
            onChange={(e) => handleRateChange('hourlyRate', e.target.value)}
            className="flex-1 px-4 py-3.5 border-2 border-slate-300 rounded-r-xl text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
          />
        </div>
      </div>

      {/* Toggle Detailed Rates */}
      <button
        onClick={() => setShowDetailed(!showDetailed)}
        className="flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 mb-6"
      >
        {showDetailed ? (
          <>Hide detailed rates <ChevronUp className="w-4 h-4" /></>
        ) : (
          <>Add detailed rates <ChevronDown className="w-4 h-4" /></>
        )}
      </button>

      {/* Detailed Rates (expandable) */}
      {showDetailed && (
        <div className="space-y-4 mb-6 fade-in">
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Minimum rate for two seniors
            </label>
            <div className="flex items-center">
              <span className="flex items-center justify-center w-10 h-12 bg-slate-100 border-2 border-r-0 border-slate-300 rounded-l-xl text-slate-500 text-sm font-semibold">
                $
              </span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="Two seniors"
                value={rateFor2Seniors}
                onChange={(e) => handleRateChange('rateFor2Seniors', e.target.value)}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 rounded-r-xl text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Minimum rate for three or more seniors
            </label>
            <div className="flex items-center">
              <span className="flex items-center justify-center w-10 h-12 bg-slate-100 border-2 border-r-0 border-slate-300 rounded-l-xl text-slate-500 text-sm font-semibold">
                $
              </span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="Three+ seniors"
                value={rateFor3PlusSeniors}
                onChange={(e) => handleRateChange('rateFor3PlusSeniors', e.target.value)}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 rounded-r-xl text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
              />
            </div>
          </div>

          {/* Max Clients */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Max seniors at one time:
            </label>
            <select
              value={maxClients}
              onChange={(e) => onChange('maxClients', e.target.value)}
              className="w-full px-4 py-3 rounded-xl border-2 border-slate-300 bg-white text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
            >
              <option value="">Select max to care for</option>
              {MAX_CLIENTS_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
      )}

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
