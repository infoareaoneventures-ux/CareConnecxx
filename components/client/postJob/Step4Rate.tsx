import React, { useEffect, useState } from 'react';
import { StepProps } from './types';
import { dbService } from '../../../services/api';
import { billedHourlyRate, fmtMoney, SERVICE_FEE_PERCENT_LABEL } from '../../../utils/pricing';
import { rateRangeOrFallback, FALLBACK_RATE_RANGE } from '../../../utils/marketRate';

export const Step4Rate: React.FC<StepProps> = ({ data, onChange, onContinue, onBack }) => {
  // The error sits under the field and goes away as soon as the rate is fixed (2026-11-11: it was a toast at the top
  // of the screen that stayed on the next step).
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ min: number; max: number }>({ ...FALLBACK_RATE_RANGE });

  useEffect(() => {
    let cancelled = false;
    dbService.getPublicCaregiverRates().then((rates) => { if (!cancelled) setRange(rateRangeOrFallback(rates)); });
    return () => { cancelled = true; };
  }, []);

  const handleContinue = () => {
    if (!data.rateFlexible && (!data.rate || data.rate <= 0)) {
      setError('Enter the hourly rate you want to pay.');
      return;
    }
    setError(null);
    onContinue();
  };

  const hasRate = !data.rateFlexible && !!data.rate && data.rate > 0;

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">Set your rate</h2>
      <p className="text-sm text-slate-500 text-center mb-6">
        Care providers near you typically ask about <span className="font-semibold text-slate-700">${range.min}–${range.max}/hr</span>.
      </p>

      <div className="space-y-6">
        <div>
          <div className="mb-2">
            <label htmlFor="job-rate" className="text-sm font-semibold text-slate-700">Hourly rate</label>
          </div>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-semibold">$</span>
            <input
              id="job-rate"
              type="number"
              min={1}
              value={data.rate ?? ''}
              disabled={data.rateFlexible}
              onChange={e => { setError(null); onChange({ rate: e.target.value === '' ? undefined : Number(e.target.value) }); }}
              placeholder={`e.g. ${Math.round((range.min + range.max) / 2)}`}
              aria-invalid={!!error}
              aria-describedby={error ? 'job-rate-error' : 'job-rate-help'}
              className={`w-full pl-8 pr-14 py-3 border-2 rounded-xl text-lg font-semibold text-slate-900 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400 ${error ? 'border-red-400 focus:border-red-500' : 'border-slate-200 focus:border-primary-500'}`}
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-medium">/hr</span>
          </div>
          {error && <p id="job-rate-error" role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
          <p id="job-rate-help" className="mt-2 text-sm text-slate-500" data-testid="billed-rate">
            {hasRate
              ? <>You'll be billed <span className="font-semibold text-slate-700">{fmtMoney(billedHourlyRate(data.rate as number))}/hr</span>: the {fmtMoney(data.rate as number)}/hr goes to the care provider, plus a {SERVICE_FEE_PERCENT_LABEL} service fee.</>
              : <>There's a {SERVICE_FEE_PERCENT_LABEL} service fee on top of the rate, so $25/hr is billed as {fmtMoney(billedHourlyRate(25))}/hr.</>}
          </p>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700 font-medium">Back</button>
        <button type="button" onClick={handleContinue} className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-10 py-3 rounded-xl shadow-md transition-colors">Continue</button>
      </div>
    </div>
  );
};
