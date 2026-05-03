import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { PRIMARY_SERVICES, ADDITIONAL_SERVICES, CERTIFICATIONS, EXPERIENCE_LEVELS } from '../constants';

interface Step6Props {
  primaryServices: Array<{ name: string; yearsExperience: string }>;
  additionalServices: string[];
  certifications: string[];
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

export const Step6Services: React.FC<Step6Props> = ({
  primaryServices,
  additionalServices,
  certifications,
  onChange,
  onNext,
  onBack,
  onShowToast,
  isLoading,
}) => {
  const togglePrimaryService = (serviceName: string) => {
    const exists = primaryServices.find((s) => s.name === serviceName);
    if (exists) {
      onChange(
        'primaryServices',
        primaryServices.filter((s) => s.name !== serviceName)
      );
    } else {
      onChange('primaryServices', [
        ...primaryServices,
        { name: serviceName, yearsExperience: '' },
      ]);
    }
  };

  const updateExperience = (serviceName: string, yearsExperience: string) => {
    onChange(
      'primaryServices',
      primaryServices.map((s) =>
        s.name === serviceName ? { ...s, yearsExperience } : s
      )
    );
  };

  const toggleAdditional = (service: string) => {
    const updated = additionalServices.includes(service)
      ? additionalServices.filter((s) => s !== service)
      : [...additionalServices, service];
    onChange('additionalServices', updated);
  };

  const toggleCert = (cert: string) => {
    const updated = certifications.includes(cert)
      ? certifications.filter((c) => c !== cert)
      : [...certifications, cert];
    onChange('certifications', updated);
  };

  const handleContinue = () => {
    if (primaryServices.length === 0 && additionalServices.length === 0) {
      onShowToast('Please select at least one service you offer', 'error');
      return;
    }
    const missingExp = primaryServices.find((s) => !s.yearsExperience);
    if (missingExp) {
      onShowToast(`Please select experience level for "${missingExp.name}"`, 'error');
      return;
    }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        What services do you offer?
      </h1>
      <p className="text-slate-500 mb-6">Select the services you provide and your experience level</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left: Primary Services */}
        <div>
          <h3 className="font-semibold text-slate-700 mb-3">Senior Care</h3>
          <p className="text-sm text-slate-500 mb-4">
            Select the services you offer and list your years of experience.
          </p>
          <div className="space-y-3">
            {PRIMARY_SERVICES.map((service) => {
              const selected = primaryServices.find((s) => s.name === service);
              return (
                <div key={service}>
                  <button
                    onClick={() => togglePrimaryService(service)}
                    className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${
                      selected
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className={`text-sm font-medium ${selected ? 'text-primary-700' : 'text-slate-600'}`}>
                      {selected && <span className="mr-1.5">&#10003;</span>}
                      {service}
                    </span>
                  </button>
                  {selected && (
                    <select
                      value={selected.yearsExperience}
                      onChange={(e) => updateExperience(service, e.target.value)}
                      className="mt-1.5 w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 bg-white focus:outline-none focus:border-primary-500"
                    >
                      <option value="">Select experience</option>
                      {EXPERIENCE_LEVELS.map((level) => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Additional Services */}
        <div>
          <h3 className="font-semibold text-slate-700 mb-3">More services</h3>
          <div className="space-y-2.5">
            {ADDITIONAL_SERVICES.map((service) => (
              <label
                key={service}
                className="flex items-center gap-3 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={additionalServices.includes(service)}
                  onChange={() => toggleAdditional(service)}
                  className="w-5 h-5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-slate-600 group-hover:text-slate-800 transition-colors">
                  {service}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Certifications */}
      <div className="mt-8">
        <h3 className="font-semibold text-slate-700 mb-3">Certifications</h3>
        <div className="flex flex-wrap gap-2">
          {CERTIFICATIONS.map((cert) => (
            <button
              key={cert}
              onClick={() => toggleCert(cert)}
              className={`px-4 py-2 rounded-full border-2 text-sm font-medium transition-all ${
                certifications.includes(cert)
                  ? 'bg-primary-600 border-primary-600 text-white'
                  : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
              }`}
            >
              {certifications.includes(cert) && <span className="mr-1">&#10003;</span>}
              {cert}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-3 mt-8">
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
