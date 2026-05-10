import React, { useState, useRef } from 'react';
import {
  ChevronLeft, CheckCircle, Loader2, Upload, Sparkles,
  User, Heart, ChevronDown, ChevronUp, Lightbulb, FileText, X,
} from 'lucide-react';
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

const cleanData = (data: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined && v !== ''));

export const CaregiverOnboardingWizard: React.FC<WizardProps> = ({
  uid, firstName, city, state, onComplete, onShowToast,
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
    if (field === 'profilePhoto' && value.preview) blobUrlsRef.current.add(value.preview);
  };

  const next = () => setStep(s => Math.min(s + 1, TOTAL_STEPS));
  const back = () => setStep(s => Math.max(s - 1, 1));

  const handleSavePhoto = async () => {
    if (!form.profilePhoto.file) { onShowToast('Please upload a profile photo', 'error'); return; }
    setIsLoading(true);
    try {
      await documentUploadService.uploadDocument(uid, form.profilePhoto.file, 'profilePhoto');
      next();
    } catch { onShowToast('Failed to upload photo. Please try again.', 'error'); }
    finally { setIsLoading(false); }
  };

  const handleSaveAvailability = async () => {
    if (form.jobTypes.length === 0) { onShowToast('Please select at least one job type', 'error'); return; }
    setIsLoading(true);
    try {
      await dbService.updateUser('caregivers', uid, cleanData({
        weeklyAvailability: form.weeklyAvailability,
        jobTypes: form.jobTypes,
      }) as any);
      next();
    } catch { onShowToast('Failed to save availability. Please try again.', 'error'); }
    finally { setIsLoading(false); }
  };

  const handleSaveServices = async () => {
    if (form.primaryServices.length === 0 && form.additionalServices.length === 0) {
      onShowToast('Please select at least one service you offer', 'error'); return;
    }
    const missingExp = form.primaryServices.find(s => !s.yearsExperience);
    if (missingExp) { onShowToast(`Please select experience level for "${missingExp.name}"`, 'error'); return; }
    setIsLoading(true);
    try {
      await dbService.updateUser('caregivers', uid, cleanData({
        primaryServices: form.primaryServices,
        skills: [...form.primaryServices.map(s => s.name), ...form.additionalServices],
        certifications: form.certifications,
      }) as any);
      next();
    } catch { onShowToast('Failed to save services. Please try again.', 'error'); }
    finally { setIsLoading(false); }
  };

  const handleSaveRates = async () => {
    if (!form.hourlyRate) { onShowToast('Please enter your minimum hourly rate', 'error'); return; }
    const rate = parseInt(form.hourlyRate);
    if (rate < 15 || rate > 200) { onShowToast('Hourly rate must be between $15 and $200', 'error'); return; }
    setIsLoading(true);
    try {
      const rateData: Record<string, any> = { hourlyRate: rate };
      if (form.rateFor2Seniors) rateData.rateFor2Seniors = parseInt(form.rateFor2Seniors);
      if (form.rateFor3PlusSeniors) rateData.rateFor3PlusSeniors = parseInt(form.rateFor3PlusSeniors);
      if (form.maxClients) rateData.maxClients = parseInt(form.maxClients);
      await dbService.updateUser('caregivers', uid, rateData as any);
      next();
    } catch { onShowToast('Failed to save rates. Please try again.', 'error'); }
    finally { setIsLoading(false); }
  };

  const handleSaveBio = async () => {
    if (form.bio.length < 150) {
      onShowToast(`Please write at least 150 characters (${150 - form.bio.length} more needed)`, 'error'); return;
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
    } catch { onShowToast('Failed to save bio. Please try again.', 'error'); }
    finally { setIsLoading(false); }
  };

  const progressPct = Math.round(((step - 1) / (TOTAL_STEPS - 1)) * 100);
  const isColoredStep = [1, 7].includes(step);
  const cardBg = isColoredStep ? 'bg-indigo-600' : 'bg-white';

  const renderStep = () => {
    switch (step) {
      // ── Step 1: Welcome ──────────────────────────────────────────────────
      case 1:
        return (
          <div className="flex flex-col items-center text-center gap-5 py-2">
            <h2 className="text-2xl font-bold text-white leading-snug">
              Welcome, {firstName || 'there'}!<br />
              <span className="text-indigo-200 text-lg font-normal">Let's set up your profile.</span>
            </h2>
            <div className="w-20 h-20 flex items-center justify-center">
              <div className="relative">
                <User size={44} className="text-white/90" />
                <Heart size={18} className="text-teal-300 absolute -bottom-1 -right-2" fill="currentColor" />
              </div>
            </div>
            <div className="w-full space-y-2">
              {[
                ['📷', 'Profile photo', 'Make a great first impression'],
                ['📅', 'Availability', 'When you are free to work'],
                ['🩺', 'Services & skills', 'What you offer families'],
                ['💰', 'Your rate', 'How much you charge per hour'],
                ['✍️', 'About you', 'Tell families your story'],
              ].map(([icon, label, sub]) => (
                <div key={label} className="w-full bg-white/15 rounded-2xl px-4 py-2.5 flex items-center gap-3 text-left">
                  <span className="text-lg w-7 text-center">{icon}</span>
                  <div>
                    <p className="text-white font-semibold text-sm">{label}</p>
                    <p className="text-indigo-200 text-xs">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={next}
              className="w-full bg-white text-indigo-700 font-semibold py-3 rounded-full hover:bg-indigo-50 transition-colors mt-1"
            >
              Let's go
            </button>
            <button onClick={onComplete} className="text-indigo-300 text-xs hover:text-indigo-100">
              Skip for now
            </button>
          </div>
        );

      // ── Step 2: Photo ────────────────────────────────────────────────────
      case 2:
        return <PhotoStep
          profilePhoto={form.profilePhoto} onChange={updateField}
          onNext={handleSavePhoto} isLoading={isLoading} onShowToast={onShowToast}
        />;

      // ── Step 3: Availability ─────────────────────────────────────────────
      case 3:
        return <AvailabilityStep
          jobTypes={form.jobTypes} weeklyAvailability={form.weeklyAvailability}
          neverAvailable={form.neverAvailable} onChange={updateField}
          onNext={handleSaveAvailability} isLoading={isLoading} onShowToast={onShowToast}
        />;

      // ── Step 4: Services ─────────────────────────────────────────────────
      case 4:
        return <ServicesStep
          primaryServices={form.primaryServices} additionalServices={form.additionalServices}
          certifications={form.certifications} onChange={updateField}
          onNext={handleSaveServices} isLoading={isLoading} onShowToast={onShowToast}
        />;

      // ── Step 5: Rates ────────────────────────────────────────────────────
      case 5:
        return <RatesStep
          hourlyRate={form.hourlyRate} rateFor2Seniors={form.rateFor2Seniors}
          rateFor3PlusSeniors={form.rateFor3PlusSeniors} maxClients={form.maxClients}
          onChange={updateField} onNext={handleSaveRates} isLoading={isLoading} onShowToast={onShowToast}
        />;

      // ── Step 6: Bio ──────────────────────────────────────────────────────
      case 6:
        return <BioStep
          bio={form.bio} onChange={updateField}
          onNext={handleSaveBio} isLoading={isLoading} onShowToast={onShowToast}
        />;

      // ── Step 7: Done ─────────────────────────────────────────────────────
      case 7:
        return (
          <div className="flex flex-col items-center text-center gap-5 py-4">
            <div className="w-16 h-16 rounded-full bg-teal-400/20 flex items-center justify-center">
              <Sparkles size={30} className="text-teal-300" />
            </div>
            <h2 className="text-2xl font-bold text-white">
              You're all set, {firstName || 'there'}!
            </h2>
            <p className="text-indigo-200 text-sm leading-relaxed">
              Your profile has been submitted for review. Our team will verify your information within 1–2 business days.
            </p>
            <div className="w-full bg-white/15 rounded-2xl px-4 py-3 flex items-center gap-3">
              <CheckCircle size={18} className="text-teal-300 shrink-0" />
              <p className="text-white text-sm">
                You'll receive an email once you're approved and can start accepting bookings.
              </p>
            </div>
            <button
              onClick={onComplete}
              className="w-full bg-white text-indigo-700 font-semibold py-3 rounded-full hover:bg-indigo-50 transition-colors"
            >
              Go to my dashboard
            </button>
          </div>
        );

      default: return null;
    }
  };

  // ── Outer shell ────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`w-full max-w-md rounded-3xl shadow-2xl overflow-hidden ${cardBg} transition-colors duration-300 max-h-[92vh] flex flex-col`}>
        {/* Progress bar + back button */}
        {step > 1 && (
          <div className="flex items-center gap-2 px-4 pt-4 shrink-0">
            <button
              onClick={back}
              className={`shrink-0 ${isColoredStep ? 'text-white/70 hover:text-white' : 'text-slate-400 hover:text-slate-600'} transition-colors`}
              aria-label="Go back"
            >
              <ChevronLeft size={20} />
            </button>
            <div className={`flex-1 h-1.5 rounded-full ${isColoredStep ? 'bg-white/20' : 'bg-slate-100'}`}>
              <div
                className="h-full rounded-full bg-teal-400 transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {step < TOTAL_STEPS && (
              <button
                onClick={onComplete}
                className={`text-xs shrink-0 ${isColoredStep ? 'text-indigo-300 hover:text-indigo-100' : 'text-slate-400 hover:text-slate-600'}`}
              >
                Skip
              </button>
            )}
          </div>
        )}

        {/* Step content (scrollable) */}
        <div className="px-6 py-6 overflow-y-auto flex-1">
          {renderStep()}
        </div>
      </div>
    </div>
  );
};

// ─── Photo Step ────────────────────────────────────────────────────────────────

const PhotoStep: React.FC<{
  profilePhoto: { file: File | null; preview: string | null };
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ profilePhoto, onChange, onNext, isLoading, onShowToast }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { onShowToast('Photo must be under 5MB', 'error'); return; }
    if (!file.type.startsWith('image/')) { onShowToast('Please select an image file', 'error'); return; }
    onChange('profilePhoto', { file, preview: URL.createObjectURL(file) });
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-slate-800 text-center">Select your profile photo</h2>
      <p className="text-sm text-slate-500 text-center">Make a great first impression with families</p>

      <div onClick={() => fileInputRef.current?.click()} className="cursor-pointer">
        {profilePhoto.preview ? (
          <div className="flex flex-col items-center gap-2">
            <img src={profilePhoto.preview} alt="Profile preview"
              className="w-32 h-32 rounded-full object-cover border-4 border-indigo-100 shadow-lg" />
            <button className="text-indigo-600 font-medium text-sm hover:underline">Change photo</button>
          </div>
        ) : (
          <div className="border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center hover:border-indigo-300 hover:bg-indigo-50/30 transition-all">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <Upload size={24} className="text-slate-400" />
            </div>
            <p className="text-slate-600 font-medium text-sm">Click to upload your photo</p>
            <p className="text-xs text-slate-400 mt-1">JPG, PNG or WebP · max 5MB</p>
          </div>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />

      <div className="bg-slate-50 rounded-2xl p-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Photo tips</p>
        <ul className="space-y-1.5 text-sm text-slate-600">
          <li className="flex items-start gap-2"><span className="text-red-400 font-bold">✕</span>No other people, sunglasses, or hats</li>
          <li className="flex items-start gap-2"><span className="text-teal-500 font-bold">✓</span>Clear, well-lit close-up photo</li>
          <li className="flex items-start gap-2"><span className="text-teal-500 font-bold">✓</span>Recent photo families will recognize</li>
        </ul>
      </div>

      <button
        onClick={onNext}
        disabled={isLoading}
        className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
      >
        {isLoading ? <><Loader2 size={16} className="animate-spin" />Uploading…</> : 'Continue'}
      </button>
    </div>
  );
};

// ─── Availability Step ─────────────────────────────────────────────────────────

const AvailabilityStep: React.FC<{
  jobTypes: string[];
  weeklyAvailability: Record<string, string[]>;
  neverAvailable: string[];
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ jobTypes, weeklyAvailability, neverAvailable, onChange, onNext, isLoading, onShowToast }) => {
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
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-slate-800 text-center">What jobs are you looking for?</h2>

      <div className="flex flex-col gap-2">
        {JOB_TYPES.map(jt => (
          <button key={jt.id} onClick={() => toggleJobType(jt.id)}
            className={`w-full border-2 rounded-2xl px-4 py-3 text-left transition-all flex items-center gap-3 ${
              jobTypes.includes(jt.id) ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
            }`}>
            <div className="flex-1">
              <p className="font-semibold text-slate-800 text-sm">{jt.label}</p>
              <p className="text-slate-500 text-xs mt-0.5">{jt.subtitle}</p>
            </div>
            <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${jobTypes.includes(jt.id) ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300'}`}>
              {jobTypes.includes(jt.id) && <div className="w-2 h-2 rounded-full bg-white" />}
            </div>
          </button>
        ))}
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-700 mb-1">When are you generally available?</p>
        <p className="text-xs text-slate-400 mb-3">You can adjust your calendar in more detail later.</p>
        <div className="overflow-x-auto">
          <div className="min-w-[360px]">
            {TIME_BLOCKS.map(block => (
              <div key={block.id} className="mb-2.5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-sm">{block.icon}</span>
                  <span className="text-xs font-semibold text-slate-700">{block.label} <span className="font-normal text-slate-400">({block.time})</span></span>
                </div>
                <div className="flex gap-1.5">
                  {DAYS.map((day, i) => {
                    const isActive = (weeklyAvailability[day.id] || []).includes(block.id);
                    const isNever = neverAvailable.includes(day.id);
                    return (
                      <button key={`${block.id}-${day.id}-${i}`}
                        onClick={() => !isNever && toggleSlot(day.id, block.id)}
                        disabled={isNever}
                        className={`w-9 h-9 rounded-full text-xs font-semibold transition-all ${
                          isNever ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                            : isActive ? 'bg-indigo-500 text-white shadow-sm'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                        }`}>
                        {day.short}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="mb-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-sm">⏱</span>
                <span className="text-xs font-semibold text-slate-700">Never available</span>
              </div>
              <div className="flex gap-1.5">
                {DAYS.map((day, i) => (
                  <button key={`never-${day.id}-${i}`} onClick={() => toggleNever(day.id)}
                    className={`w-9 h-9 rounded-full text-xs font-semibold transition-all ${
                      neverAvailable.includes(day.id) ? 'bg-slate-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}>
                    {day.short}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <button onClick={handleNext} disabled={isLoading}
        className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
        {isLoading ? <><Loader2 size={16} className="animate-spin" />Saving…</> : 'Next'}
      </button>
    </div>
  );
};

// ─── Services Step ─────────────────────────────────────────────────────────────

const ServicesStep: React.FC<{
  primaryServices: Array<{ name: string; yearsExperience: string }>;
  additionalServices: string[];
  certifications: string[];
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ primaryServices, additionalServices, certifications, onChange, onNext, isLoading, onShowToast }) => {
  const togglePrimary = (name: string) => {
    const exists = primaryServices.find(s => s.name === name);
    onChange('primaryServices', exists
      ? primaryServices.filter(s => s.name !== name)
      : [...primaryServices, { name, yearsExperience: '' }]);
  };
  const updateExp = (name: string, yearsExperience: string) =>
    onChange('primaryServices', primaryServices.map(s => s.name === name ? { ...s, yearsExperience } : s));
  const toggleAdditional = (service: string) =>
    onChange('additionalServices', additionalServices.includes(service)
      ? additionalServices.filter(s => s !== service) : [...additionalServices, service]);
  const toggleCert = (cert: string) =>
    onChange('certifications', certifications.includes(cert)
      ? certifications.filter(c => c !== cert) : [...certifications, cert]);

  const handleNext = () => {
    if (primaryServices.length === 0 && additionalServices.length === 0) {
      onShowToast('Please select at least one service', 'error'); return;
    }
    const missingExp = primaryServices.find(s => !s.yearsExperience);
    if (missingExp) { onShowToast(`Please select experience level for "${missingExp.name}"`, 'error'); return; }
    onNext();
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-slate-800 text-center">What services do you offer?</h2>

      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Senior Care</p>
        <div className="space-y-2">
          {PRIMARY_SERVICES.map(service => {
            const selected = primaryServices.find(s => s.name === service);
            return (
              <div key={service}>
                <button onClick={() => togglePrimary(service)}
                  className={`w-full text-left px-4 py-2.5 rounded-xl border-2 transition-all ${
                    selected ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                  }`}>
                  <span className={`text-sm font-medium ${selected ? 'text-indigo-700' : 'text-slate-600'}`}>
                    {selected && '✓ '}{service}
                  </span>
                </button>
                {selected && (
                  <select value={selected.yearsExperience} onChange={e => updateExp(service, e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 bg-white focus:outline-none focus:border-indigo-500">
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
        <p className="text-sm font-semibold text-slate-700 mb-2">More services</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {ADDITIONAL_SERVICES.map(service => (
            <label key={service} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={additionalServices.includes(service)}
                onChange={() => toggleAdditional(service)}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <span className="text-xs text-slate-600">{service}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2">Certifications</p>
        <div className="flex flex-wrap gap-2">
          {CERTIFICATIONS.map(cert => (
            <button key={cert} onClick={() => toggleCert(cert)}
              className={`px-3 py-1.5 rounded-full border-2 text-xs font-medium transition-all ${
                certifications.includes(cert) ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
              }`}>
              {certifications.includes(cert) && '✓ '}{cert}
            </button>
          ))}
        </div>
      </div>

      <button onClick={handleNext} disabled={isLoading}
        className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
        {isLoading ? <><Loader2 size={16} className="animate-spin" />Saving…</> : 'Continue'}
      </button>
    </div>
  );
};

// ─── Rates Step ────────────────────────────────────────────────────────────────

const RatesStep: React.FC<{
  hourlyRate: string;
  rateFor2Seniors: string;
  rateFor3PlusSeniors: string;
  maxClients: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ hourlyRate, rateFor2Seniors, rateFor3PlusSeniors, maxClients, onChange, onNext, isLoading, onShowToast }) => {
  const [showDetailed, setShowDetailed] = useState(false);
  const numOnly = (v: string) => v.replace(/\D/g, '');

  const handleNext = () => {
    if (!hourlyRate) { onShowToast('Please enter your minimum hourly rate', 'error'); return; }
    const rate = parseInt(hourlyRate);
    if (rate < 15 || rate > 200) { onShowToast('Hourly rate must be between $15 and $200', 'error'); return; }
    onNext();
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-slate-800 text-center">What is your minimum rate?</h2>
      <p className="text-sm text-slate-500 text-center">
        Caregivers in your area charge <span className="font-semibold text-slate-700">$24/hr</span> on average
      </p>

      <div>
        <label className="block text-sm font-semibold text-slate-800 mb-1.5">Minimum hourly rate</label>
        <div className="flex items-center">
          <span className="flex items-center justify-center w-11 h-12 bg-slate-100 border-2 border-r-0 border-slate-200 rounded-l-xl text-slate-500 font-semibold">$</span>
          <input type="text" inputMode="numeric" placeholder="e.g. 25" value={hourlyRate}
            onChange={e => onChange('hourlyRate', numOnly(e.target.value))}
            className="flex-1 px-4 py-3 border-2 border-slate-200 rounded-r-xl text-lg text-slate-900 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
        </div>
      </div>

      <button onClick={() => setShowDetailed(!showDetailed)}
        className="flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
        {showDetailed ? <>Hide detailed rates <ChevronUp size={14} /></> : <>Add detailed rates <ChevronDown size={14} /></>}
      </button>

      {showDetailed && (
        <div className="space-y-3 bg-slate-50 rounded-2xl p-4">
          {[
            { field: 'rateFor2Seniors', label: 'Rate for two seniors', value: rateFor2Seniors, placeholder: 'Two seniors' },
            { field: 'rateFor3PlusSeniors', label: 'Rate for three or more seniors', value: rateFor3PlusSeniors, placeholder: 'Three+ seniors' },
          ].map(({ field, label, value, placeholder }) => (
            <div key={field}>
              <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
              <div className="flex items-center">
                <span className="flex items-center justify-center w-9 h-10 bg-white border-2 border-r-0 border-slate-200 rounded-l-lg text-slate-500 text-sm font-semibold">$</span>
                <input type="text" inputMode="numeric" placeholder={placeholder} value={value}
                  onChange={e => onChange(field, numOnly(e.target.value))}
                  className="flex-1 px-3 py-2 border-2 border-slate-200 rounded-r-lg text-slate-900 focus:outline-none focus:border-indigo-500" />
              </div>
            </div>
          ))}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Max seniors at one time</label>
            <select value={maxClients} onChange={e => onChange('maxClients', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-2 border-slate-200 bg-white text-slate-900 focus:outline-none focus:border-indigo-500">
              <option value="">Select</option>
              {MAX_CLIENTS_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      )}

      <button onClick={handleNext} disabled={isLoading}
        className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
        {isLoading ? <><Loader2 size={16} className="animate-spin" />Saving…</> : 'Continue'}
      </button>
    </div>
  );
};

// ─── Bio Step ──────────────────────────────────────────────────────────────────

const BioStep: React.FC<{
  bio: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  isLoading: boolean;
  onShowToast: AddToastFunction;
}> = ({ bio, onChange, onNext, isLoading }) => {
  const [showIdeas, setShowIdeas] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const minChars = 150;
  const maxChars = 2500;
  const count = bio.length;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-slate-800 text-center">Tell families about yourself</h2>
      <p className="text-sm text-slate-500 text-center">
        Highlight your experience, personality, and what makes you a great caregiver. Min {minChars} characters.
      </p>

      <div>
        <textarea value={bio} onChange={e => { if (e.target.value.length <= maxChars) onChange('bio', e.target.value); }}
          placeholder={`Describe your caregiving background... at least ${minChars} characters required.`}
          rows={7}
          className="w-full px-4 py-3 rounded-2xl border-2 border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 resize-none transition-all" />
        <div className="flex justify-between mt-1">
          <span className={`text-xs ${count < minChars ? 'text-indigo-500' : 'text-slate-400'}`}>{maxChars - count} left</span>
          <span className={`text-xs font-medium ${count < minChars ? 'text-indigo-500' : 'text-teal-600'}`}>{count}/{minChars} min</span>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setShowIdeas(true)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border-2 border-slate-200 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all">
          <Lightbulb size={13} />Writing ideas
        </button>
        <button onClick={() => setShowExample(true)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border-2 border-slate-200 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all">
          <FileText size={13} />See example
        </button>
      </div>

      <button onClick={onNext} disabled={isLoading || count < minChars}
        className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
        {isLoading ? <><Loader2 size={16} className="animate-spin" />Finishing up…</> : 'Continue'}
      </button>

      {showIdeas && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[300] p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-800">Writing Ideas</h3>
              <button onClick={() => setShowIdeas(false)} className="p-1 rounded-lg hover:bg-slate-100"><X size={18} className="text-slate-500" /></button>
            </div>
            <ul className="space-y-2.5">
              {WRITING_IDEAS.map((idea, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                  <span className="text-indigo-500 mt-0.5">•</span>{idea}
                </li>
              ))}
            </ul>
            <button onClick={() => setShowIdeas(false)}
              className="w-full mt-4 bg-indigo-600 text-white font-semibold py-2.5 rounded-full hover:bg-indigo-700 transition-colors text-sm">
              Got it
            </button>
          </div>
        </div>
      )}

      {showExample && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[300] p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-800">Example Bio</h3>
              <button onClick={() => setShowExample(false)} className="p-1 rounded-lg hover:bg-slate-100"><X size={18} className="text-slate-500" /></button>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{EXAMPLE_BIO}</div>
            <button onClick={() => setShowExample(false)}
              className="w-full mt-4 bg-indigo-600 text-white font-semibold py-2.5 rounded-full hover:bg-indigo-700 transition-colors text-sm">
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
