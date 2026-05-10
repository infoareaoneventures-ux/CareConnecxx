import React, { useState, useRef } from 'react';
import { CheckCircle, Loader2, X, Camera, Upload, Star, MapPin, ChevronDown, ChevronUp, Lightbulb, FileText } from 'lucide-react';
import { Button } from '../ui/Button';
import { dbService } from '../../services/api';
import { documentUploadService } from '../../services/documentUpload';
import { AddToastFunction } from '../../types';
import {
  PRIMARY_SERVICES,
  ADDITIONAL_SERVICES,
  CERTIFICATIONS,
  EXPERIENCE_LEVELS,
  TIME_BLOCKS,
  DAYS,
  JOB_TYPES,
  MAX_CLIENTS_OPTIONS,
  WRITING_IDEAS,
  EXAMPLE_BIO,
} from './signup/constants';

interface WizardProps {
  uid: string;
  firstName: string;
  city: string;
  state: string;
  onComplete: () => void;
  onShowToast: AddToastFunction;
}

interface WizardForm {
  profilePhoto: { file: File | null; preview: string | null };
  jobTypes: string[];
  weeklyAvailability: Record<string, string[]>;
  neverAvailable: string[];
  primaryServices: Array<{ name: string; yearsExperience: string }>;
  additionalServices: string[];
  certifications: string[];
  hourlyRate: string;
  rateFor2Seniors: string;
  rateFor3PlusSeniors: string;
  maxClients: string;
  bio: string;
}

const TOTAL_STEPS = 7;

const STEP_LABELS = [
  'Welcome',
  'Photo',
  'Availability',
  'Services',
  'Rates',
  'About Me',
  'Done',
];

const cleanData = (data: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined && v !== ''));

export const CaregiverOnboardingWizard: React.FC<WizardProps> = ({
  uid,
  firstName,
  city,
  state,
  onComplete,
  onShowToast,
}) => {
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const blobUrlsRef = useRef<Set<string>>(new Set());

  const [form, setForm] = useState<WizardForm>({
    profilePhoto: { file: null, preview: null },
    jobTypes: [],
    weeklyAvailability: {
      sunday: [], monday: [], tuesday: [], wednesday: [],
      thursday: [], friday: [], saturday: [],
    },
    neverAvailable: [],
    primaryServices: [],
    additionalServices: [],
    certifications: [],
    hourlyRate: '',
    rateFor2Seniors: '',
    rateFor3PlusSeniors: '',
    maxClients: '',
    bio: '',
  });

  const updateField = (field: string, value: any) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (field === 'profilePhoto' && value.preview) {
      blobUrlsRef.current.add(value.preview);
    }
  };

  const next = () => setStep(s => Math.min(s + 1, TOTAL_STEPS));
  const back = () => setStep(s => Math.max(s - 1, 1));

  // Step 2: Save photo
  const handleSavePhoto = async () => {
    if (!form.profilePhoto.file) {
      onShowToast('Please upload a profile photo', 'error');
      return;
    }
    setIsLoading(true);
    try {
      await documentUploadService.uploadDocument(uid, form.profilePhoto.file, 'profilePhoto');
      next();
    } catch {
      onShowToast('Failed to upload photo. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 3: Save availability
  const handleSaveAvailability = async () => {
    if (form.jobTypes.length === 0) {
      onShowToast('Please select at least one job type', 'error');
      return;
    }
    setIsLoading(true);
    try {
      await dbService.updateUser('caregivers', uid, cleanData({
        weeklyAvailability: form.weeklyAvailability,
        jobTypes: form.jobTypes,
      }) as any);
      next();
    } catch {
      onShowToast('Failed to save availability. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 4: Save services
  const handleSaveServices = async () => {
    if (form.primaryServices.length === 0 && form.additionalServices.length === 0) {
      onShowToast('Please select at least one service you offer', 'error');
      return;
    }
    const missingExp = form.primaryServices.find(s => !s.yearsExperience);
    if (missingExp) {
      onShowToast(`Please select experience level for "${missingExp.name}"`, 'error');
      return;
    }
    setIsLoading(true);
    try {
      const allSkills = [
        ...form.primaryServices.map(s => s.name),
        ...form.additionalServices,
      ];
      await dbService.updateUser('caregivers', uid, cleanData({
        primaryServices: form.primaryServices,
        skills: allSkills,
        certifications: form.certifications,
      }) as any);
      next();
    } catch {
      onShowToast('Failed to save services. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 5: Save rates
  const handleSaveRates = async () => {
    if (!form.hourlyRate) {
      onShowToast('Please enter your minimum hourly rate', 'error');
      return;
    }
    const rate = parseInt(form.hourlyRate);
    if (rate < 15 || rate > 200) {
      onShowToast('Hourly rate must be between $15 and $200', 'error');
      return;
    }
    setIsLoading(true);
    try {
      const rateData: Record<string, any> = { hourlyRate: rate };
      if (form.rateFor2Seniors) rateData.rateFor2Seniors = parseInt(form.rateFor2Seniors);
      if (form.rateFor3PlusSeniors) rateData.rateFor3PlusSeniors = parseInt(form.rateFor3PlusSeniors);
      if (form.maxClients) rateData.maxClients = parseInt(form.maxClients);
      await dbService.updateUser('caregivers', uid, rateData as any);
      next();
    } catch {
      onShowToast('Failed to save rates. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 6: Save bio + finish
  const handleSaveBio = async () => {
    if (form.bio.length < 150) {
      onShowToast(`Please write at least 150 characters (${150 - form.bio.length} more needed)`, 'error');
      return;
    }
    setIsLoading(true);
    try {
      await dbService.updateUser('caregivers', uid, cleanData({
        bio: form.bio,
        onboardingStep: 2,
        onboardingStatus: 'submitted',
        verificationStatus: 'submitted',
        submittedAt: new Date().toISOString(),
      }) as any);
      next();
    } catch {
      onShowToast('Failed to save bio. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const progressPct = ((step - 1) / (TOTAL_STEPS - 1)) * 100;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 sm:px-6 py-4 flex items-center gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium text-slate-500">
              {step < TOTAL_STEPS ? `Step ${step} of ${TOTAL_STEPS - 1}: ${STEP_LABELS[step - 1]}` : 'All done!'}
            </span>
            {step < TOTAL_STEPS && (
              <span className="text-sm text-slate-400">{Math.round(progressPct)}%</span>
            )}
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-500 rounded-full transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        {step > 1 && step < TOTAL_STEPS && (
          <button
            onClick={onComplete}
            className="text-xs text-slate-400 hover:text-slate-600 whitespace-nowrap ml-2"
          >
            Skip for now
          </button>
        )}
      </div>

      {/* Step content */}
      <div className="flex-1 flex items-start justify-center px-4 sm:px-6 py-8">
        <div className="w-full max-w-xl">
          {step === 1 && (
            <WelcomeStep firstName={firstName} onNext={next} />
          )}
          {step === 2 && (
            <PhotoStep
              profilePhoto={form.profilePhoto}
              firstName={firstName}
              city={city}
              state={state}
              onChange={updateField}
              onNext={handleSavePhoto}
              onBack={back}
              isLoading={isLoading}
              onShowToast={onShowToast}
            />
          )}
          {step === 3 && (
            <AvailabilityStep
              jobTypes={form.jobTypes}
              weeklyAvailability={form.weeklyAvailability}
              neverAvailable={form.neverAvailable}
              onChange={updateField}
              onNext={handleSaveAvailability}
              onBack={back}
              isLoading={isLoading}
              onShowToast={onShowToast}
            />
          )}
          {step === 4 && (
            <ServicesStep
              primaryServices={form.primaryServices}
              additionalServices={form.additionalServices}
              certifications={form.certifications}
              onChange={updateField}
              onNext={handleSaveServices}
              onBack={back}
              isLoading={isLoading}
              onShowToast={onShowToast}
            />
          )}
          {step === 5 && (
            <RatesStep
              hourlyRate={form.hourlyRate}
              rateFor2Seniors={form.rateFor2Seniors}
              rateFor3PlusSeniors={form.rateFor3PlusSeniors}
              maxClients={form.maxClients}
              onChange={updateField}
              onNext={handleSaveRates}
              onBack={back}
              isLoading={isLoading}
              onShowToast={onShowToast}
            />
          )}
          {step === 6 && (
            <BioStep
              bio={form.bio}
              onChange={updateField}
              onNext={handleSaveBio}
              onBack={back}
              isLoading={isLoading}
              onShowToast={onShowToast}
            />
          )}
          {step === 7 && (
            <DoneStep firstName={firstName} onComplete={onComplete} />
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Step 1: Welcome ─────────────────────────────────────────────────────────

const WelcomeStep: React.FC<{ firstName: string; onNext: () => void }> = ({ firstName, onNext }) => (
  <div className="text-center fade-in">
    <div className="w-20 h-20 rounded-full bg-primary-100 flex items-center justify-center mx-auto mb-6">
      <span className="text-4xl">👋</span>
    </div>
    <h1 className="text-3xl font-bold text-slate-800 mb-3">
      Welcome, {firstName || 'there'}!
    </h1>
    <p className="text-slate-500 mb-3 leading-relaxed">
      Let's set up your caregiver profile so families can find and book you.
    </p>
    <p className="text-sm text-slate-400 mb-8">
      This takes about 3 minutes. You can skip and come back any time.
    </p>
    <div className="space-y-3 text-left bg-slate-50 rounded-2xl p-5 mb-8">
      {[
        ['📷', 'Profile photo', 'Make a great first impression'],
        ['📅', 'Availability', 'When you are free to work'],
        ['🩺', 'Services & skills', 'What you offer families'],
        ['💰', 'Your rate', 'How much you charge per hour'],
        ['✍️', 'About you', 'Tell families your story'],
      ].map(([icon, label, sub]) => (
        <div key={label} className="flex items-center gap-3">
          <span className="text-xl w-8 text-center">{icon}</span>
          <div>
            <p className="text-sm font-semibold text-slate-700">{label}</p>
            <p className="text-xs text-slate-400">{sub}</p>
          </div>
        </div>
      ))}
    </div>
    <Button variant="primary" size="lg" fullWidth onClick={onNext}>
      Let's get started
    </Button>
  </div>
);

// ─── Step 2: Photo ────────────────────────────────────────────────────────────

const PhotoStep: React.FC<{
  profilePhoto: { file: File | null; preview: string | null };
  firstName: string;
  city: string;
  state: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ profilePhoto, firstName, city, state, onChange, onNext, onBack, isLoading, onShowToast }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { onShowToast('Photo must be under 5MB', 'error'); return; }
    if (!file.type.startsWith('image/')) { onShowToast('Please select an image file', 'error'); return; }
    onChange('profilePhoto', { file, preview: URL.createObjectURL(file) });
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">Select your profile photo</h1>
      <p className="text-slate-500 mb-6">Make a great first impression</p>

      <div onClick={() => fileInputRef.current?.click()} className="cursor-pointer mb-6">
        {profilePhoto.preview ? (
          <div className="flex flex-col items-center">
            <img src={profilePhoto.preview} alt="Profile preview"
              className="w-36 h-36 rounded-full object-cover border-4 border-primary-100 shadow-lg mb-3" />
            <button className="text-primary-600 font-medium text-sm hover:underline">Change photo</button>
          </div>
        ) : (
          <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center hover:border-primary-400 hover:bg-primary-50/30 transition-all">
            <div className="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <Upload className="w-8 h-8 text-slate-400" />
            </div>
            <p className="text-slate-600 font-medium">Click to upload your photo</p>
            <p className="text-sm text-slate-400 mt-1">JPG, PNG or WebP (max 5MB)</p>
          </div>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />

      <div className="bg-slate-50 rounded-xl p-4 mb-6">
        <h3 className="font-semibold text-slate-700 mb-2">Photo Guidelines:</h3>
        <ul className="space-y-1.5 text-sm text-slate-600">
          <li className="flex items-start gap-2"><span className="text-red-400 font-bold">✕</span>No other people, sunglasses, or hats.</li>
          <li className="flex items-start gap-2"><span className="text-primary-500 font-bold">✓</span>Choose a close-up, well-lit photo.</li>
          <li className="flex items-start gap-2"><span className="text-primary-500 font-bold">✓</span>Recent photos help families recognize you.</li>
        </ul>
      </div>

      <div className="flex gap-3">
        <Button variant="secondary" size="lg" onClick={onBack}>Back</Button>
        <Button variant="primary" size="lg" fullWidth onClick={onNext} disabled={isLoading}>
          {isLoading ? <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />Uploading...</span> : 'Continue'}
        </Button>
      </div>
    </div>
  );
};

// ─── Step 3: Availability ─────────────────────────────────────────────────────

const AvailabilityStep: React.FC<{
  jobTypes: string[];
  weeklyAvailability: Record<string, string[]>;
  neverAvailable: string[];
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ jobTypes, weeklyAvailability, neverAvailable, onChange, onNext, onBack, isLoading, onShowToast }) => {
  const toggleJobType = (id: string) => {
    onChange('jobTypes', jobTypes.includes(id) ? jobTypes.filter(t => t !== id) : [...jobTypes, id]);
  };

  const toggleSlot = (day: string, block: string) => {
    if (neverAvailable.includes(day)) onChange('neverAvailable', neverAvailable.filter(d => d !== day));
    const daySlots = weeklyAvailability[day] || [];
    onChange('weeklyAvailability', {
      ...weeklyAvailability,
      [day]: daySlots.includes(block) ? daySlots.filter(s => s !== block) : [...daySlots, block],
    });
  };

  const toggleNever = (day: string) => {
    if (neverAvailable.includes(day)) {
      onChange('neverAvailable', neverAvailable.filter(d => d !== day));
    } else {
      onChange('neverAvailable', [...neverAvailable, day]);
      onChange('weeklyAvailability', { ...weeklyAvailability, [day]: [] });
    }
  };

  const handleNext = () => {
    if (jobTypes.length === 0) { onShowToast('Please select at least one job type', 'error'); return; }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">What jobs are you looking for?</h1>
      <p className="text-slate-500 mb-6">Deselect any that don't apply</p>

      <div className="flex flex-wrap gap-3 mb-8">
        {JOB_TYPES.map(jt => (
          <button key={jt.id} onClick={() => toggleJobType(jt.id)}
            className={`px-5 py-2.5 rounded-full border-2 text-sm font-medium transition-all ${
              jobTypes.includes(jt.id)
                ? 'bg-primary-600 border-primary-600 text-white'
                : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
            }`}>
            {jobTypes.includes(jt.id) && <span className="mr-1.5">✓</span>}
            {jt.label}
            <span className="block text-xs opacity-75 mt-0.5">{jt.subtitle}</span>
          </button>
        ))}
      </div>

      <h2 className="text-xl font-bold text-slate-800 mb-1">When are you generally available?</h2>
      <p className="text-sm text-slate-500 mb-4">You can customize your calendar in more detail later.</p>

      <div className="overflow-x-auto">
        <div className="min-w-[420px]">
          {TIME_BLOCKS.map(block => (
            <div key={block.id} className="mb-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-base">{block.icon}</span>
                <span className="text-sm font-semibold text-slate-700">
                  {block.label} <span className="font-normal text-slate-400">({block.time})</span>
                </span>
              </div>
              <div className="flex gap-2">
                {DAYS.map((day, i) => {
                  const isActive = (weeklyAvailability[day.id] || []).includes(block.id);
                  const isNever = neverAvailable.includes(day.id);
                  return (
                    <button key={`${block.id}-${day.id}-${i}`}
                      onClick={() => !isNever && toggleSlot(day.id, block.id)}
                      disabled={isNever}
                      className={`w-10 h-10 rounded-full text-sm font-semibold transition-all ${
                        isNever ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                          : isActive ? 'bg-primary-400 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}>
                      {day.short}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-base">⏱</span>
              <span className="text-sm font-semibold text-slate-700">Never available</span>
            </div>
            <div className="flex gap-2">
              {DAYS.map((day, i) => (
                <button key={`never-${day.id}-${i}`} onClick={() => toggleNever(day.id)}
                  className={`w-10 h-10 rounded-full text-sm font-semibold transition-all ${
                    neverAvailable.includes(day.id) ? 'bg-slate-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}>
                  {day.short}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-3 mt-8">
        <Button variant="secondary" size="lg" onClick={onBack}>Back</Button>
        <Button variant="primary" size="lg" fullWidth onClick={handleNext} disabled={isLoading}>
          {isLoading ? <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />Saving...</span> : 'Next'}
        </Button>
      </div>
    </div>
  );
};

// ─── Step 4: Services ─────────────────────────────────────────────────────────

const ServicesStep: React.FC<{
  primaryServices: Array<{ name: string; yearsExperience: string }>;
  additionalServices: string[];
  certifications: string[];
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ primaryServices, additionalServices, certifications, onChange, onNext, onBack, isLoading, onShowToast }) => {
  const togglePrimary = (name: string) => {
    const exists = primaryServices.find(s => s.name === name);
    onChange('primaryServices', exists
      ? primaryServices.filter(s => s.name !== name)
      : [...primaryServices, { name, yearsExperience: '' }]
    );
  };
  const updateExp = (name: string, yearsExperience: string) => {
    onChange('primaryServices', primaryServices.map(s => s.name === name ? { ...s, yearsExperience } : s));
  };
  const toggleAdditional = (service: string) => {
    onChange('additionalServices', additionalServices.includes(service)
      ? additionalServices.filter(s => s !== service)
      : [...additionalServices, service]
    );
  };
  const toggleCert = (cert: string) => {
    onChange('certifications', certifications.includes(cert)
      ? certifications.filter(c => c !== cert)
      : [...certifications, cert]
    );
  };

  const handleNext = () => {
    if (primaryServices.length === 0 && additionalServices.length === 0) {
      onShowToast('Please select at least one service you offer', 'error'); return;
    }
    const missingExp = primaryServices.find(s => !s.yearsExperience);
    if (missingExp) { onShowToast(`Please select experience level for "${missingExp.name}"`, 'error'); return; }
    onNext();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">What services do you offer?</h1>
      <p className="text-slate-500 mb-6">Select the services you provide and your experience level</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h3 className="font-semibold text-slate-700 mb-3">Senior Care</h3>
          <p className="text-sm text-slate-500 mb-4">Select services and list your years of experience.</p>
          <div className="space-y-3">
            {PRIMARY_SERVICES.map(service => {
              const selected = primaryServices.find(s => s.name === service);
              return (
                <div key={service}>
                  <button onClick={() => togglePrimary(service)}
                    className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${
                      selected ? 'border-primary-500 bg-primary-50' : 'border-slate-200 hover:border-slate-300'
                    }`}>
                    <span className={`text-sm font-medium ${selected ? 'text-primary-700' : 'text-slate-600'}`}>
                      {selected && <span className="mr-1.5">✓</span>}{service}
                    </span>
                  </button>
                  {selected && (
                    <select value={selected.yearsExperience} onChange={e => updateExp(service, e.target.value)}
                      className="mt-1.5 w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700 bg-white focus:outline-none focus:border-primary-500">
                      <option value="">Select experience</option>
                      {EXPERIENCE_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-slate-700 mb-3">More services</h3>
          <div className="space-y-2.5">
            {ADDITIONAL_SERVICES.map(service => (
              <label key={service} className="flex items-center gap-3 cursor-pointer group">
                <input type="checkbox" checked={additionalServices.includes(service)}
                  onChange={() => toggleAdditional(service)}
                  className="w-5 h-5 rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
                <span className="text-sm text-slate-600 group-hover:text-slate-800 transition-colors">{service}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8">
        <h3 className="font-semibold text-slate-700 mb-3">Certifications</h3>
        <div className="flex flex-wrap gap-2">
          {CERTIFICATIONS.map(cert => (
            <button key={cert} onClick={() => toggleCert(cert)}
              className={`px-4 py-2 rounded-full border-2 text-sm font-medium transition-all ${
                certifications.includes(cert) ? 'bg-primary-600 border-primary-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
              }`}>
              {certifications.includes(cert) && <span className="mr-1">✓</span>}{cert}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-3 mt-8">
        <Button variant="secondary" size="lg" onClick={onBack}>Back</Button>
        <Button variant="primary" size="lg" fullWidth onClick={handleNext} disabled={isLoading}>
          {isLoading ? <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />Saving...</span> : 'Continue'}
        </Button>
      </div>
    </div>
  );
};

// ─── Step 5: Rates ────────────────────────────────────────────────────────────

const RatesStep: React.FC<{
  hourlyRate: string;
  rateFor2Seniors: string;
  rateFor3PlusSeniors: string;
  maxClients: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ hourlyRate, rateFor2Seniors, rateFor3PlusSeniors, maxClients, onChange, onNext, onBack, isLoading, onShowToast }) => {
  const [showDetailed, setShowDetailed] = useState(false);
  const numOnly = (v: string) => v.replace(/\D/g, '');

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">What is your minimum rate?</h1>
      <p className="text-slate-500 mb-6">
        Caregivers in your area are charging <span className="font-semibold text-slate-700">$24/hr</span> for one senior
      </p>

      <div className="mb-4">
        <label className="block text-base font-semibold text-slate-800 mb-2">Minimum rate</label>
        <div className="flex items-center">
          <span className="flex items-center justify-center w-12 h-14 bg-slate-100 border-2 border-r-0 border-slate-300 rounded-l-xl text-slate-500 font-semibold">$</span>
          <input type="text" inputMode="numeric" placeholder="Minimum hourly rate" value={hourlyRate}
            onChange={e => onChange('hourlyRate', numOnly(e.target.value))}
            className="flex-1 px-4 py-3.5 border-2 border-slate-300 rounded-r-xl text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100" />
        </div>
      </div>

      <button onClick={() => setShowDetailed(!showDetailed)}
        className="flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 mb-6">
        {showDetailed ? <>Hide detailed rates <ChevronUp className="w-4 h-4" /></> : <>Add detailed rates <ChevronDown className="w-4 h-4" /></>}
      </button>

      {showDetailed && (
        <div className="space-y-4 mb-6 fade-in">
          {[
            { field: 'rateFor2Seniors', label: 'Minimum rate for two seniors', value: rateFor2Seniors, placeholder: 'Two seniors' },
            { field: 'rateFor3PlusSeniors', label: 'Minimum rate for three or more seniors', value: rateFor3PlusSeniors, placeholder: 'Three+ seniors' },
          ].map(({ field, label, value, placeholder }) => (
            <div key={field}>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">{label}</label>
              <div className="flex items-center">
                <span className="flex items-center justify-center w-10 h-12 bg-slate-100 border-2 border-r-0 border-slate-300 rounded-l-xl text-slate-500 text-sm font-semibold">$</span>
                <input type="text" inputMode="numeric" placeholder={placeholder} value={value}
                  onChange={e => onChange(field, numOnly(e.target.value))}
                  className="flex-1 px-4 py-2.5 border-2 border-slate-300 rounded-r-xl text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100" />
              </div>
            </div>
          ))}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">Max seniors at one time:</label>
            <select value={maxClients} onChange={e => onChange('maxClients', e.target.value)}
              className="w-full px-4 py-3 rounded-xl border-2 border-slate-300 bg-white text-lg text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100">
              <option value="">Select max to care for</option>
              {MAX_CLIENTS_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      )}

      <div className="flex gap-3 mt-6">
        <Button variant="secondary" size="lg" onClick={onBack}>Back</Button>
        <Button variant="primary" size="lg" fullWidth onClick={onNext} disabled={isLoading}>
          {isLoading ? <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />Saving...</span> : 'Continue'}
        </Button>
      </div>
    </div>
  );
};

// ─── Step 6: Bio ──────────────────────────────────────────────────────────────

const BioStep: React.FC<{
  bio: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ bio, onChange, onNext, onBack, isLoading }) => {
  const [showIdeas, setShowIdeas] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const minChars = 150;
  const maxChars = 2500;
  const count = bio.length;

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">Tell families more about yourself.</h1>
      <p className="text-slate-500 mb-1 leading-relaxed">
        What's your background? What qualifications, personality traits, and talents make you a great caregiver?
        Be sure to highlight your experience with seniors.
      </p>
      <p className="text-sm text-slate-400 mb-6">Avoid including contact information. {minChars} characters required.</p>

      <div className="mb-2">
        <textarea value={bio} onChange={e => { if (e.target.value.length <= maxChars) onChange('bio', e.target.value); }}
          placeholder={`Describe your relevant experience for families. At least ${minChars} characters required.`}
          rows={8}
          className="w-full px-4 py-4 rounded-xl border-2 border-slate-300 text-base text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100 resize-y transition-all" />
      </div>
      <div className="flex items-center justify-between mb-4">
        <span className={`text-sm ${count < minChars ? 'text-primary-500' : 'text-slate-400'}`}>{maxChars - count} characters left</span>
        <span className={`text-sm font-medium ${count < minChars ? 'text-primary-500' : count >= maxChars ? 'text-red-500' : 'text-primary-600'}`}>{count}/{minChars} min</span>
      </div>

      <div className="flex items-center justify-center gap-4 mb-6">
        <button onClick={() => setShowIdeas(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 border-slate-300 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-slate-50 transition-all">
          <Lightbulb className="w-4 h-4" />See Writing Ideas
        </button>
        <button onClick={() => setShowExample(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 border-slate-300 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-slate-50 transition-all">
          <FileText className="w-4 h-4" />See Example
        </button>
      </div>

      <div className="flex gap-3">
        <Button variant="secondary" size="lg" onClick={onBack}>Back</Button>
        <Button variant="primary" size="lg" fullWidth onClick={onNext} disabled={isLoading || count < minChars}>
          {isLoading ? <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />Finishing up...</span> : 'Continue'}
        </Button>
      </div>

      {showIdeas && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800">Writing Ideas</h3>
              <button onClick={() => setShowIdeas(false)} className="p-1.5 rounded-lg hover:bg-slate-100"><X className="w-5 h-5 text-slate-500" /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">Try answering some of these questions in your bio:</p>
            <ul className="space-y-3">
              {WRITING_IDEAS.map((idea, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                  <span className="text-primary-500 mt-0.5">•</span>{idea}
                </li>
              ))}
            </ul>
            <Button variant="primary" fullWidth className="mt-6" onClick={() => setShowIdeas(false)}>Got it</Button>
          </div>
        </div>
      )}

      {showExample && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800">Example Bio</h3>
              <button onClick={() => setShowExample(false)} className="p-1.5 rounded-lg hover:bg-slate-100"><X className="w-5 h-5 text-slate-500" /></button>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">{EXAMPLE_BIO}</div>
            <Button variant="primary" fullWidth className="mt-6" onClick={() => setShowExample(false)}>Got it</Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Step 7: Done ─────────────────────────────────────────────────────────────

const DoneStep: React.FC<{ firstName: string; onComplete: () => void }> = ({ firstName, onComplete }) => (
  <div className="text-center fade-in py-8">
    <div className="w-24 h-24 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
      <CheckCircle className="w-14 h-14 text-green-500" />
    </div>
    <h1 className="text-3xl font-bold text-slate-800 mb-3">You're all set, {firstName || 'there'}!</h1>
    <p className="text-slate-500 mb-3 leading-relaxed">
      Your profile has been submitted for review. Our team will verify your information within 1-2 business days.
    </p>
    <p className="text-sm text-slate-400 mb-10">
      You'll receive an email once you're approved and can start accepting bookings.
    </p>
    <Button variant="primary" size="lg" fullWidth onClick={onComplete}>
      Go to my dashboard
    </Button>
  </div>
);
