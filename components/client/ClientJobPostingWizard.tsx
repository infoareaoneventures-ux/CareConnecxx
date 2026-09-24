import React, { useState, useEffect, useRef } from 'react';
import {
  Shield, ChevronLeft, ChevronRight, User, Check,
  Sparkles, Heart, Clock, MapPin, Calendar, Loader2, Phone, Briefcase
} from 'lucide-react';
import { AvatarUpload } from '../ui/AvatarUpload';
import { dbService, createJobPosting, loadJobPostingDraft, saveJobPostingDraft } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// ── Types ──────────────────────────────────────────────────────────────────

interface WizardForm {
  careFrequency: string;
  street: string;
  zipCode: string;
  city: string;
  state: string;
  neighborhood: string;
  startDate: string;
  endDate: string;
  ongoing: boolean;
  daysFlexible: boolean;
  selectedDays: string[];
  timeOfDay: string[];
  photoURL: string;
  careRecipientFirstName: string;
  careRecipientLastName: string;
  careRecipientAge: string;
  adultsCount: number;
  caregiversNeeded: number;
  additionalRecipients: { firstName: string; lastName: string; age: string; relationship: string }[];
  relationship: string;
  emergencyFirstName: string;
  emergencyLastName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
  careNeeds: string[];
  petsInHome: boolean;
  smokingHousehold: boolean;
  rate?: number;
  rateFlexible: boolean;
  // Cash removed platform-wide (Hamse, 2026-08-23) — every job is paid by
  // card now, so this is no longer a real choice. Also fixes a pre-existing
  // inconsistency: this field used to store 'credit_card' while every other
  // write path (BookingFlow.tsx, PostsPage.tsx, the backend's
  // normalizePaymentMethod default) uses 'credit'.
  paymentMethod: 'credit';
  jobDescription: string;
}

interface Props {
  uid: string;
  onComplete: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TOTAL_STEPS = 15;
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const TIME_OPTIONS = [
  { value: 'morning',   label: 'Morning',   sub: '6am–12pm' },
  { value: 'afternoon', label: 'Afternoon', sub: '12pm–6pm' },
  { value: 'evening',   label: 'Evening',   sub: '6pm–12am' },
  { value: 'overnight', label: 'Overnight', sub: '12am–6am' },
];
const CARE_NEEDS_OPTIONS = [
  'Mobility Assistance',
  'Dementia / Memory Care',
  'Medication Reminders',
  'Personal Care',
  'Companionship',
  'Transportation',
  'Meal Preparation',
  'Light Housekeeping',
];
const JOB_DESCRIPTION_EXAMPLES = [
  "My mom is 78, lives alone, and needs help with morning routines and light housekeeping 3 days a week. She loves gardening and chatting over coffee.",
  "Looking for a kind, experienced caregiver for my father who has early-stage Alzheimer's. He needs companionship, medication reminders, and help with meals.",
  "My husband had a stroke 6 months ago. He needs assistance with mobility, bathing, and physical therapy exercises. Patience and positivity are a must.",
];

// ── Helper: today as yyyy-mm-dd (local time, not UTC) ──────────────────────

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Component ──────────────────────────────────────────────────────────────

const INITIAL_FORM: WizardForm = {
    careFrequency: '',
    street: '',
    zipCode: '',
    city: '',
    state: '',
    neighborhood: '',
    startDate: '',
    endDate: '',
    ongoing: false,
    daysFlexible: false,
    selectedDays: [],
    timeOfDay: [],
    photoURL: '',
    careRecipientFirstName: '',
    careRecipientLastName: '',
    careRecipientAge: '',
    adultsCount: 1,
    caregiversNeeded: 1,
    additionalRecipients: [],
    relationship: '',
    emergencyFirstName: '',
    emergencyLastName: '',
    emergencyPhone: '',
    emergencyRelationship: '',
    careNeeds: [],
    petsInHome: false,
    smokingHousehold: false,
    rate: undefined,
    rateFlexible: false,
    paymentMethod: 'credit',
    jobDescription: '',
  };

export const ClientJobPostingWizard: React.FC<Props> = ({ uid, onComplete }) => {
  const { addToast } = useCareConnex();

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nearbyCount, setNearbyCount] = useState<number | null>(null);
  // Account-recovery email (2026-09-05) — the account's phone number IS the
  // login, so there was no way back in if it's ever lost. Evia's SMS
  // onboarding already collects this same field (users/{uid}.email); this
  // closes the parity gap on the web side. Optional, asked at the very end
  // so it never blocks the actual job-posting submission at Step 14.
  const [recoveryEmail, setRecoveryEmail] = useState('');
  // 2026-09-06: /start now collects this up front for every new account —
  // without this check, every client would see this prompt again here even
  // though they already provided one at signup.
  const [hasEmailOnFile, setHasEmailOnFile] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [exampleIdx, setExampleIdx] = useState(0);
  const [clientFirstName, setClientFirstName] = useState('');
  const [clientLastName, setClientLastName] = useState('');
  const [clientAddress, setClientAddress] = useState({ street: '', zipCode: '', city: '', state: '' });
  const [customAddressOpen, setCustomAddressOpen] = useState(false);
  const [zipLooking, setZipLooking] = useState(false);
  const zipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [homeAddress, setHomeAddress] = useState({ street: '', zipCode: '', city: '', state: '' });
  const [homeZipLooking, setHomeZipLooking] = useState(false);
  const homeZipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [form, setForm] = useState<WizardForm>(INITIAL_FORM);

  // Pre-fill address and name from users doc
  useEffect(() => {
    const load = async () => {
      try {
        const d = await dbService.getUser(uid) as any;
        if (d) {
          // Prefer dedicated fields; fall back to splitting combined `name`.
          // Guard: if firstName somehow contains the full name (space present)
          // and lastName is empty, re-split so the pre-fill is correct.
          let first = (d.firstName as string | undefined)?.trim() || '';
          let last  = (d.lastName  as string | undefined)?.trim() || '';
          if (first.includes(' ') && !last) {
            const parts = first.split(/\s+/);
            first = parts[0];
            last  = parts.slice(1).join(' ');
          }
          if (!first && d.name) {
            const parts = (d.name as string).trim().split(/\s+/);
            first = parts[0] || '';
            last  = parts.slice(1).join(' ');
          }
          setClientFirstName(first);
          setClientLastName(last);
          if ((d.email as string | undefined)?.trim()) setHasEmailOnFile(true);
          const street = d.street  || '';
          const zip    = d.zipCode || '';
          const city   = d.city    || '';
          const state  = d.state   || '';
          setClientAddress({ street, zipCode: zip, city, state });
          setHomeAddress({ street, zipCode: zip, city, state });
          if (!zip) setCustomAddressOpen(true);
          setForm(f => ({ ...f, street: street || f.street, zipCode: zip || f.zipCode, city: city || f.city, state: state || f.state }));
        }
      } catch { /* best effort */ }
    };
    load();
  }, []);

  // Rotate examples on step 14
  useEffect(() => {
    if (step !== 14) return;
    const id = setInterval(() => setExampleIdx(i => (i + 1) % JOB_DESCRIPTION_EXAMPLES.length), 4000);
    return () => clearInterval(id);
  }, [step]);


  // ── Helpers ──────────────────────────────────────────────────────────────

  const update = <K extends keyof WizardForm>(key: K, value: WizardForm[K]) =>
    setForm(f => ({ ...f, [key]: value }));

  const toggleDay = (day: string) =>
    setForm(f => ({
      ...f,
      selectedDays: f.selectedDays.includes(day)
        ? f.selectedDays.filter(d => d !== day)
        : [...f.selectedDays, day],
    }));

  const toggleNeed = (need: string) =>
    setForm(f => ({
      ...f,
      careNeeds: f.careNeeds.includes(need)
        ? f.careNeeds.filter(n => n !== need)
        : [...f.careNeeds, need],
    }));

  const addPerson = () => setForm(f => {
    if (f.adultsCount >= 4) return f;
    return { ...f, adultsCount: f.adultsCount + 1, additionalRecipients: [...f.additionalRecipients, { firstName: '', lastName: '', age: '', relationship: '' }] };
  });

  const removePerson = () => setForm(f => {
    if (f.adultsCount <= 1) return f;
    return { ...f, adultsCount: f.adultsCount - 1, additionalRecipients: f.additionalRecipients.slice(0, -1) };
  });

  const updateAdditional = (idx: number, field: 'firstName' | 'lastName' | 'age' | 'relationship', val: string) =>
    setForm(f => {
      const updated = [...f.additionalRecipients];
      updated[idx] = { ...updated[idx], [field]: val };
      return { ...f, additionalRecipients: updated };
    });

  const handleHomeZip = (raw: string) => {
    const val = raw.replace(/\D/g, '').slice(0, 5);
    setHomeAddress(a => ({ ...a, zipCode: val, city: '', state: '' }));
    if (homeZipTimerRef.current) clearTimeout(homeZipTimerRef.current);
    if (val.length === 5) {
      setHomeZipLooking(true);
      homeZipTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`https://api.zippopotam.us/us/${val}`);
          if (res.ok) {
            const json = await res.json();
            const place = json.places?.[0];
            if (place) {
              setHomeAddress(a => ({ ...a, city: place['place name'] || '', state: place['state abbreviation'] || '' }));
            }
          }
        } catch { /* best effort */ }
        setHomeZipLooking(false);
      }, 400);
    } else {
      setHomeZipLooking(false);
    }
  };

  const handleSaveHomeAddress = () => {
    if (homeAddress.zipCode) {
      dbService.updateUser('users', uid, {
        street: homeAddress.street,
        zipCode: homeAddress.zipCode,
        city: homeAddress.city,
        state: homeAddress.state,
      }).catch(console.error);
    }
    setClientAddress(homeAddress);
    setCustomAddressOpen(false);
    setForm(f => ({ ...f, street: homeAddress.street, zipCode: homeAddress.zipCode, city: homeAddress.city, state: homeAddress.state }));
    next();
  };

  const handleCustomZip = (raw: string) => {
    const val = raw.replace(/\D/g, '').slice(0, 5);
    update('zipCode', val);
    update('city', '');
    update('state', '');
    if (zipTimerRef.current) clearTimeout(zipTimerRef.current);
    if (val.length === 5) {
      setZipLooking(true);
      zipTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`https://api.zippopotam.us/us/${val}`);
          if (res.ok) {
            const json = await res.json();
            const place = json.places?.[0];
            if (place) {
              update('city', place['place name'] || '');
              update('state', place['state abbreviation'] || '');
            }
          }
        } catch { /* best effort */ }
        setZipLooking(false);
      }, 400);
    } else {
      setZipLooking(false);
    }
  };

  const progressPct = Math.round(((step - 1) / (TOTAL_STEPS - 1)) * 100);

  const canAdvanceAt = (s: number): boolean => {
    if (s === 2) return !!form.careFrequency;
    if (s === 3) return homeAddress.street.trim().length > 0 && homeAddress.zipCode.trim().length >= 5;
    if (s === 4) return customAddressOpen
      ? form.zipCode.trim().length >= 5
      : clientAddress.zipCode.trim().length >= 5;
    if (s === 6) return !!form.startDate && (form.selectedDays.length > 0 || form.daysFlexible);
    if (s === 10) return form.careRecipientFirstName.trim().length > 0;
    if (s === 11) return form.emergencyFirstName.trim().length > 0 && form.emergencyPhone.trim().length >= 10;
    if (s === 12) return form.careNeeds.length > 0;
    if (s === 13) return !!form.rate && (form.rate ?? 0) > 0;
    return true;
  };
  const canAdvance = (): boolean => canAdvanceAt(step);

  // ── Draft: resume + per-step save (2026-09-20, founder: one questionnaire, two doors) ──
  // job_postings/{uid} holds the answers so far — from THIS wizard's earlier steps
  // or from Evia over text (she mirrors each answer in these same field names).
  const draftReady = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await loadJobPostingDraft(uid);
        if (cancelled || !d || d.status === 'active') return;
        setForm(f => {
          const next: any = { ...f };
          for (const k of Object.keys(f)) if (d[k] !== undefined && d[k] !== null) next[k] = d[k];
          return next as WizardForm;
        });
        if (d._homeAddress) setHomeAddress(d._homeAddress);
        if (typeof d._customAddressOpen === 'boolean') setCustomAddressOpen(d._customAddressOpen);
        if (typeof d.draftStep === 'number' && d.draftStep > 1 && d.draftStep < TOTAL_STEPS) setStep(d.draftStep);
        else setStep(prev => (prev === 1 && Object.keys(d).some(k => k in INITIAL_FORM) ? 2 : prev));
      } catch { /* start fresh */ }
      finally { draftReady.current = true; }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);
  useEffect(() => {
    if (!draftReady.current || step <= 1 || step >= TOTAL_STEPS) return;
    void saveJobPostingDraft(uid, { ...form, _homeAddress: homeAddress, _customAddressOpen: customAddressOpen }, step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const next = () => setStep(s => Math.min(s + 1, TOTAL_STEPS));
  const back = () => setStep(s => Math.max(s - 1, 1));

  const handleFrequency = (val: string) => {
    update('careFrequency', val);
    setTimeout(next, 150);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await createJobPosting(uid, { ...form, rate: form.rate ?? 0 });
      try {
        const { caregivers } = await dbService.getCaregivers(50, null);
        setNearbyCount(caregivers.length);
      } catch { setNearbyCount(null); }
      next();
    } catch (e: any) {
      console.error('createJobPosting failed:', e);
      const msg = e?.message || 'Failed to save. Please try again.';
      setSaveError(msg);
      addToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRecoveryEmail = async () => {
    // Strip ALL whitespace, not just the ends — mobile keyboard autocomplete
    // (Gboard's "@" suggestion strip especially) can insert a stray space
    // mid-address (e.g. "name@ gmail.com"), which .trim() alone never
    // catches since it only strips the leading/trailing ends. A space is
    // never valid inside an email anyway, so removing it outright is
    // strictly more forgiving than rejecting an otherwise-correct address
    // over an invisible typo the user didn't mean to make.
    const trimmed = recoveryEmail.replace(/\s+/g, '');
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
      setEmailError("That doesn't look like a valid email address.");
      return;
    }
    setEmailSaving(true);
    setEmailError(null);
    try {
      await dbService.updateUser('users', uid, { email: trimmed.toLowerCase() });
      setEmailSaved(true);
    } catch (e: any) {
      setEmailError(e?.message || 'Could not save. Please try again.');
    } finally {
      setEmailSaving(false);
    }
  };

  // ── Shared layout ────────────────────────────────────────────────────────

  const isColoredStep = [1, 5, 7, 15].includes(step);

  const cardBg = isColoredStep ? 'bg-indigo-600' : 'bg-white';
  const textPrimary = isColoredStep ? 'text-white' : 'text-slate-800';
  const textSecondary = isColoredStep ? 'text-indigo-200' : 'text-slate-500';

  // ── Render steps ─────────────────────────────────────────────────────────

  const renderStep = () => {
    switch (step) {
      // ── Step 1: Welcome ──────────────────────────────────────────────────
      case 1:
        return (
          <div className="flex flex-col items-center text-center gap-6 py-4">
            <h2 className="text-2xl font-bold text-white leading-snug px-2">
              Welcome! Ready to find the right caregiver for your loved one?<br />
              <span className="text-indigo-200 text-lg font-normal">Let's get started!</span>
            </h2>
            <div className="w-24 h-24 flex items-center justify-center">
              <div className="relative">
                <User size={48} className="text-white/90" />
                <Heart size={20} className="text-teal-300 absolute -bottom-1 -right-2" />
              </div>
            </div>
            <div className="w-full bg-white/15 rounded-2xl p-4 flex gap-3 items-start text-left">
              <Shield size={22} className="text-teal-300 mt-0.5 shrink-0" />
              <div>
                <p className="text-white font-semibold text-sm">Safety is our top priority</p>
                <p className="text-indigo-200 text-xs mt-1">
                  Every caregiver on Evia is background checked and their profile is reviewed by our Trust & Safety team.
                </p>
              </div>
            </div>
            <button
              onClick={next}
              className="w-full bg-white text-indigo-700 font-semibold py-3 rounded-full hover:bg-indigo-50 transition-colors"
            >
              Let's go
            </button>
          </div>
        );

      // ── Step 2: Care Frequency ───────────────────────────────────────────
      case 2:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">How often do you need care?</h2>
            <div className="flex flex-col gap-2">
              {[
                { val: 'specific', label: 'Occasional', sub: '', icon: <Calendar className="w-5 h-5 text-indigo-500" /> },
                { val: 'part-time', label: 'Part-time', sub: '', icon: <Clock className="w-5 h-5 text-blue-500" /> },
                { val: 'full-time', label: 'Full-time', sub: '', icon: <Briefcase className="w-5 h-5 text-teal-500" /> },
              ].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => handleFrequency(opt.val)}
                  className={`w-full border-2 rounded-2xl px-4 py-3 text-left transition-all flex items-center gap-3 ${
                    form.careFrequency === opt.val
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center flex-shrink-0">
                    {opt.icon}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800 text-sm">{opt.label}</p>
                    <p className="text-slate-500 text-xs mt-0.5">{opt.sub}</p>
                  </div>
                  <div className={`ml-auto w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${form.careFrequency === opt.val ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300'}`}>
                    {form.careFrequency === opt.val && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </button>
              ))}
            </div>
          </div>
        );

      // ── Step 3: Your Home Address ────────────────────────────────────────
      case 3:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              What's your home address?
            </h2>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Street address"
                value={homeAddress.street}
                onChange={e => setHomeAddress(a => ({ ...a, street: e.target.value }))}
                className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
              />
              <div className="relative">
                <input
                  type="text"
                  placeholder="Zip code"
                  value={homeAddress.zipCode}
                  onChange={e => handleHomeZip(e.target.value)}
                  className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent pr-7"
                />
                {homeZipLooking && (
                  <Loader2 size={14} className="animate-spin text-indigo-400 absolute right-1 top-3" />
                )}
              </div>
              <input
                type="text"
                placeholder="City"
                value={homeAddress.city}
                onChange={e => setHomeAddress(a => ({ ...a, city: e.target.value }))}
                className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
              />
              <input
                type="text"
                placeholder="State"
                value={homeAddress.state}
                onChange={e => setHomeAddress(a => ({ ...a, state: e.target.value }))}
                className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
              />
            </div>
            <button
              onClick={handleSaveHomeAddress}
              disabled={!canAdvance()}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-1"
            >
              Next
            </button>
          </div>
        );

      // ── Step 4: Location ─────────────────────────────────────────────────
      case 4:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              Where are you looking for care?
            </h2>

            {/* Pre-filled address display */}
            {clientAddress.zipCode && !customAddressOpen && (
              <div className="bg-slate-50 rounded-2xl px-4 py-3.5 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-teal-100 flex items-center justify-center shrink-0">
                  <MapPin size={16} className="text-teal-600" />
                </div>
                <div className="flex-1 min-w-0">
                  {clientAddress.street && (
                    <p className="text-slate-800 font-semibold text-sm truncate">{clientAddress.street}</p>
                  )}
                  <p className={`text-slate-800 text-sm truncate ${clientAddress.street ? 'font-normal' : 'font-semibold'}`}>
                    {clientAddress.city}{clientAddress.city && clientAddress.state ? ', ' : ''}{clientAddress.state} {clientAddress.zipCode}
                  </p>
                </div>
                <Check size={16} className="text-teal-500 shrink-0" />
              </div>
            )}

            {/* Toggle for different address */}
            {clientAddress.zipCode && (
              <button
                type="button"
                onClick={() => {
                  if (customAddressOpen) {
                    setCustomAddressOpen(false);
                    setForm(f => ({ ...f, street: clientAddress.street, zipCode: clientAddress.zipCode, city: clientAddress.city, state: clientAddress.state }));
                  } else {
                    setCustomAddressOpen(true);
                    setForm(f => ({ ...f, street: '', zipCode: '', city: '', state: '' }));
                  }
                }}
                className="text-indigo-500 text-sm font-medium hover:text-indigo-700 text-left flex items-center gap-1 -mt-1"
              >
                {customAddressOpen ? '← Use my saved address' : '+ Service address is different'}
              </button>
            )}

            {/* Editable inputs — shown when no saved address OR custom toggled on */}
            {(!clientAddress.zipCode || customAddressOpen) && (
              <div className="flex flex-col gap-3">
                <input
                  type="text"
                  placeholder="Street address"
                  value={form.street}
                  onChange={e => update('street', e.target.value)}
                  className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                />
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Zip code"
                    value={form.zipCode}
                    onChange={e => handleCustomZip(e.target.value)}
                    className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent pr-7"
                  />
                  {zipLooking && (
                    <Loader2 size={14} className="animate-spin text-indigo-400 absolute right-1 top-3" />
                  )}
                </div>
                <input
                  type="text"
                  placeholder="City"
                  value={form.city}
                  onChange={e => update('city', e.target.value)}
                  className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                />
                <input
                  type="text"
                  placeholder="State"
                  value={form.state}
                  onChange={e => update('state', e.target.value)}
                  className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                />
              </div>
            )}

            <button
              onClick={next}
              disabled={!canAdvance()}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-1"
            >
              Next
            </button>
          </div>
        );

      // ── Step 5: Transition – Details ─────────────────────────────────────
      case 5:
        return (
          <div className="flex flex-col items-center text-center gap-6 py-4">
            <h2 className="text-2xl font-bold text-white">
              Great!<br />
              <span className="text-xl font-normal text-indigo-200">
                Let's get some details to tailor your search.
              </span>
            </h2>
            <div className="w-20 h-20 rounded-2xl bg-white/15 flex items-center justify-center">
              <Calendar size={36} className="text-teal-300" />
            </div>
            <button
              onClick={next}
              className="w-full bg-white text-indigo-700 font-semibold py-3 rounded-full hover:bg-indigo-50 transition-colors"
            >
              Next
            </button>
          </div>
        );

      // ── Step 6: Schedule ─────────────────────────────────────────────────
      case 6:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              Now let's pick the days of the week and time of day.
            </h2>

            {/* Start / End dates */}
            <div>
              <p className="text-slate-600 text-sm font-medium mb-2">When would you like to start?</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">Starting</label>
                  <input
                    type="date"
                    value={form.startDate}
                    min={todayISO()}
                    onChange={e => {
                      const val = e.target.value;
                      update('startDate', val < todayISO() ? todayISO() : val);
                    }}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">Ending</label>
                  <input
                    type="date"
                    value={form.endDate}
                    min={form.startDate || todayISO()}
                    disabled={form.ongoing}
                    onChange={e => {
                      const val = e.target.value;
                      const minDate = form.startDate || todayISO();
                      update('endDate', val < minDate ? minDate : val);
                    }}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 text-sm focus:outline-none focus:border-indigo-500 disabled:opacity-40"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.ongoing}
                  onChange={e => update('ongoing', e.target.checked)}
                  className="w-4 h-4 rounded accent-indigo-600"
                />
                <span className="text-sm text-slate-600">Ongoing / no end date</span>
              </label>
            </div>

            {/* Days */}
            <div>
              <p className="text-slate-600 text-sm font-medium mb-2">Which days? <span className="text-slate-400 font-normal">(select all that apply)</span></p>
              <div className="flex justify-between gap-1">
                {DAYS.map(day => (
                  <button
                    key={day}
                    onClick={() => toggleDay(day)}
                    className={`flex-1 py-2 rounded-full text-xs font-semibold border-2 transition-all ${
                      form.selectedDays.includes(day)
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'
                    }`}
                  >
                    {day.charAt(0) + day.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Flexible toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <div
                onClick={() => update('daysFlexible', !form.daysFlexible)}
                className={`relative w-11 h-6 rounded-full transition-colors ${form.daysFlexible ? 'bg-indigo-500' : 'bg-slate-200'}`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${form.daysFlexible ? 'left-6' : 'left-1'}`} />
              </div>
              <span className="text-slate-600 text-sm">My days are flexible</span>
            </label>

            {/* Time of day */}
            <div>
              <p className="text-slate-600 text-sm font-medium mb-2">What time of day? <span className="text-slate-400 font-normal">(select all that apply)</span></p>
              <div className="grid grid-cols-2 gap-2">
                {TIME_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setForm(f => ({
                      ...f,
                      timeOfDay: f.timeOfDay.includes(opt.value)
                        ? f.timeOfDay.filter(v => v !== opt.value)
                        : [...f.timeOfDay, opt.value],
                    }))}
                    className={`py-3 px-3 rounded-xl text-sm font-medium border-2 transition-all ${
                      form.timeOfDay.includes(opt.value)
                        ? 'bg-indigo-50 border-indigo-500 text-indigo-600'
                        : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'
                    }`}
                  >
                    <span className="block">{opt.label}</span>
                    <span className="block text-xs font-normal opacity-60">{opt.sub}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={next}
              disabled={!canAdvance()}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-1"
            >
              Next
            </button>
          </div>
        );

      // ── Step 7: Transition – Family ───────────────────────────────────────
      case 7:
        return (
          <div className="flex flex-col items-center text-center gap-6 py-4">
            <h2 className="text-2xl font-bold text-white">
              Fantastic!<br />
              <span className="text-xl font-normal text-indigo-200">
                Tell us about your loved one to ensure a great match.
              </span>
            </h2>
            <div className="w-20 h-20 rounded-2xl bg-white/15 flex items-center justify-center">
              <div className="flex gap-1 items-center">
                <User size={28} className="text-white" />
                <div className="w-8 h-5 bg-teal-300/80 rounded-sm flex items-center justify-center">
                  <div className="space-y-0.5">
                    <div className="w-4 h-0.5 bg-white/80 rounded" />
                    <div className="w-4 h-0.5 bg-white/80 rounded" />
                    <div className="w-3 h-0.5 bg-white/80 rounded" />
                  </div>
                </div>
              </div>
            </div>
            <button
              onClick={next}
              className="w-full bg-white text-indigo-700 font-semibold py-3 rounded-full hover:bg-indigo-50 transition-colors"
            >
              Share details
            </button>
          </div>
        );

      // ── Step 8: Profile Photo ────────────────────────────────────────────
      case 8:
        return (
          <div className="flex flex-col items-center gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              Let's add a profile photo.
            </h2>
            <AvatarUpload
              currentUrl={form.photoURL || undefined}
              onImageSelected={url => update('photoURL', url)}
              size="lg"
              userId={uid}
              storageFolder="clients"
              ariaLabel="Upload your photo"
            />
            {!form.photoURL && (
              <button
                onClick={() => { update('photoURL', ''); next(); }}
                className="text-indigo-500 text-sm hover:underline"
              >
                Skip for now
              </button>
            )}
            <button
              onClick={next}
              className="w-full bg-slate-200 text-slate-700 font-semibold py-3 rounded-full hover:bg-slate-300 transition-colors"
            >
              Next
            </button>
          </div>
        );

      // ── Step 9: Relationship ─────────────────────────────────────────────
      case 9:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              What is your relationship to the person needing care?
            </h2>
            <div className="flex flex-col gap-2 mt-2">
              {[
                { val: 'myself', label: 'Myself' },
                { val: 'parent', label: 'Parent' },
                { val: 'spouse', label: 'Spouse or Partner' },
                { val: 'other', label: 'Other' },
              ].map(opt => (
                <button
                  key={opt.val}
                  onClick={() => {
                    setForm(f => ({
                      ...f,
                      relationship: opt.val,
                      ...(opt.val === 'myself' ? {
                        careRecipientFirstName: clientFirstName,
                        careRecipientLastName:  clientLastName,
                      } : {}),
                    }));
                    setTimeout(next, 150);
                  }}
                  className={`w-full border-2 rounded-2xl px-4 py-3 text-left transition-all ${
                    form.relationship === opt.val
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  <p className="font-semibold text-slate-800 text-sm">{opt.label}</p>
                </button>
              ))}
            </div>
          </div>
        );

      // ── Step 10: Care Recipient Details ──────────────────────────────────
      case 10:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              Tell us about the person needing care.
            </h2>

            {/* Primary recipient */}
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="First name"
                  value={form.careRecipientFirstName}
                  onChange={e => update('careRecipientFirstName', e.target.value)}
                  className="flex-1 border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                />
                <input
                  type="text"
                  placeholder="Last name"
                  value={form.careRecipientLastName}
                  onChange={e => update('careRecipientLastName', e.target.value)}
                  className="flex-1 border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                />
              </div>
              <input
                type="number"
                placeholder="Age (optional)"
                min={1}
                max={120}
                value={form.careRecipientAge}
                onChange={e => update('careRecipientAge', e.target.value)}
                className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
              />
            </div>

            {/* People count */}
            <div>
              <p className="text-slate-600 text-sm font-medium mb-3">How many people need care?</p>
              <div className="flex items-center gap-5 justify-center">
                <button
                  onClick={removePerson}
                  className="w-9 h-9 rounded-full border-2 border-slate-300 flex items-center justify-center text-slate-600 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
                >
                  <span className="text-xl leading-none mb-0.5">−</span>
                </button>
                <span className="text-2xl font-bold text-slate-800 w-8 text-center">{form.adultsCount}</span>
                <button
                  onClick={addPerson}
                  disabled={form.adultsCount >= 4}
                  className="w-9 h-9 rounded-full border-2 border-slate-300 flex items-center justify-center text-slate-600 hover:border-indigo-400 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="text-xl leading-none mb-0.5">+</span>
                </button>
              </div>
              <p className="text-slate-500 text-xs text-center mt-1">
                {form.adultsCount === 1 ? 'Care Recipient' : 'Care Recipients'}
              </p>
            </div>

            {/* Additional recipients */}
            {form.additionalRecipients.map((person, idx) => (
              <div key={idx} className="flex flex-col gap-3 border-t border-slate-100 pt-3">
                <p className="text-slate-600 text-xs font-semibold">Care Recipient {idx + 2}</p>
                {/* Relationship */}
                <p className="text-slate-600 text-sm">What is your relationship to this person?</p>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { val: 'parent',  label: 'Parent' },
                    { val: 'spouse',  label: 'Spouse / Partner' },
                    { val: 'other',   label: 'Other' },
                  ].map(opt => (
                    <button
                      key={opt.val}
                      type="button"
                      onClick={() => updateAdditional(idx, 'relationship', opt.val)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border-2 transition-all ${
                        person.relationship === opt.val
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'border-slate-200 text-slate-600 hover:border-indigo-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="First name"
                    value={person.firstName}
                    onChange={e => updateAdditional(idx, 'firstName', e.target.value)}
                    className="flex-1 border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                  />
                  <input
                    type="text"
                    placeholder="Last name"
                    value={person.lastName}
                    onChange={e => updateAdditional(idx, 'lastName', e.target.value)}
                    className="flex-1 border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                  />
                </div>
                <input
                  type="number"
                  placeholder="Age (optional)"
                  min={1}
                  max={120}
                  value={person.age}
                  onChange={e => updateAdditional(idx, 'age', e.target.value)}
                  className="w-full border-b border-slate-200 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 bg-transparent"
                />
              </div>
            ))}

            {/* How many caregivers needed */}
            <div>
              <p className="text-slate-600 text-sm font-medium mb-1 text-center">How many caregivers do you need?</p>
              <div className="flex items-center gap-5 justify-center">
                <button onClick={() => setForm(f => ({ ...f, caregiversNeeded: Math.max(1, f.caregiversNeeded - 1) }))} disabled={form.caregiversNeeded <= 1}
                  className="w-9 h-9 rounded-full border-2 border-slate-300 flex items-center justify-center text-slate-600 hover:border-indigo-400 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  <span className="text-xl leading-none mb-0.5">−</span>
                </button>
                <span className="text-2xl font-bold text-slate-800 w-8 text-center">{form.caregiversNeeded}</span>
                <button onClick={() => setForm(f => ({ ...f, caregiversNeeded: Math.min(4, f.caregiversNeeded + 1) }))} disabled={form.caregiversNeeded >= 4}
                  className="w-9 h-9 rounded-full border-2 border-slate-300 flex items-center justify-center text-slate-600 hover:border-indigo-400 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  <span className="text-xl leading-none mb-0.5">+</span>
                </button>
              </div>
              <p className="text-slate-500 text-xs text-center mt-1">{form.caregiversNeeded === 1 ? 'Caregiver' : 'Caregivers'}</p>
            </div>

            <button
              onClick={next}
              disabled={!canAdvance()}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-2"
            >
              Next
            </button>
          </div>
        );

      // ── Step 11: Emergency Contact ───────────────────────────────────────
      case 11:
        return (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-2 mb-1">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
                <Phone size={22} className="text-red-400" />
              </div>
              <h2 className="text-xl font-bold text-slate-800 text-center">Emergency contact</h2>
              <p className="text-slate-500 text-sm text-center">Who should we contact in case of an emergency?</p>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-slate-500 mb-1">First name <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  placeholder="First name"
                  value={form.emergencyFirstName}
                  onChange={e => update('emergencyFirstName', e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-semibold text-slate-500 mb-1">Last name</label>
                <input
                  type="text"
                  placeholder="Last name"
                  value={form.emergencyLastName}
                  onChange={e => update('emergencyLastName', e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Phone number <span className="text-red-400">*</span></label>
              <input
                type="tel"
                placeholder="(555) 000-0000"
                value={form.emergencyPhone}
                onChange={e => {
                  const d = e.target.value.replace(/\D/g, '').slice(0, 10);
                  let f = d;
                  if (d.length > 6) f = `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
                  else if (d.length > 3) f = `(${d.slice(0,3)}) ${d.slice(3)}`;
                  else if (d.length > 0) f = `(${d}`;
                  update('emergencyPhone', f);
                }}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Relationship</label>
              <input
                type="text"
                placeholder="e.g. Mother, Sibling, Friend"
                value={form.emergencyRelationship}
                onChange={e => update('emergencyRelationship', e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <button
              onClick={next}
              disabled={!canAdvance()}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-2"
            >
              Next
            </button>
          </div>
        );

      // ── Step 12: Care Needs ──────────────────────────────────────────────
      case 12:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              What type of care is needed?
            </h2>
            <p className="text-slate-500 text-sm text-center -mt-2">Select all that apply.</p>

            {/* Care types */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-2">Care needed</label>
              <div className="grid grid-cols-2 gap-2">
                {CARE_NEEDS_OPTIONS.map(need => {
                  const selected = form.careNeeds.includes(need);
                  return (
                    <button
                      key={need}
                      onClick={() => toggleNeed(need)}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-xl border-2 text-xs font-medium transition-all text-left ${
                        selected
                          ? 'bg-indigo-50 border-indigo-500 text-indigo-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'
                      }`}
                    >
                      <span>{need}</span>
                      {selected && <Check size={12} className="flex-shrink-0 text-indigo-600 ml-1" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Household */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-2">Household</label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 border-slate-200 bg-white cursor-pointer hover:border-indigo-300 transition-all">
                  <input
                    type="checkbox"
                    checked={form.petsInHome}
                    onChange={e => update('petsInHome', e.target.checked)}
                    className="w-4 h-4 accent-indigo-600"
                  />
                  <span className="text-xs font-medium text-slate-700">Pets in the home</span>
                </label>
                <label className="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 border-slate-200 bg-white cursor-pointer hover:border-indigo-300 transition-all">
                  <input
                    type="checkbox"
                    checked={form.smokingHousehold}
                    onChange={e => update('smokingHousehold', e.target.checked)}
                    className="w-4 h-4 accent-indigo-600"
                  />
                  <span className="text-xs font-medium text-slate-700">Smoking household</span>
                </label>
              </div>
            </div>

            <button
              onClick={next}
              disabled={!canAdvance()}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed mt-1"
            >
              Next
            </button>
          </div>
        );

      // ── Step 13: Rate ────────────────────────────────────────────────────
      case 13:
        return (
          <div className="flex flex-col gap-5">
            <h2 className="text-xl font-bold text-slate-800 text-center">Set your rate</h2>

            {/* Rate input */}
            <div>
              <label className="text-sm font-semibold text-slate-700 block mb-2">Hourly rate</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-semibold">$</span>
                <input
                  type="number"
                  min={1}
                  value={form.rate ?? ''}
                  onChange={e => update('rate', e.target.value === '' ? undefined : Number(e.target.value))}
                  placeholder="e.g. 32"
                  className="w-full pl-8 pr-14 py-3 border-2 border-slate-200 rounded-xl text-lg font-semibold text-slate-900 focus:outline-none focus:border-indigo-500"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-medium">/hr</span>
              </div>
            </div>

            <div className="flex items-center justify-between mt-1">
              <button
                type="button"
                onClick={back}
                className="text-sm text-slate-500 hover:text-slate-700 font-medium"
              >
                Back
              </button>
              <button
                onClick={next}
                disabled={!canAdvance()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-10 py-3 rounded-xl shadow-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
        );

      // ── Step 14: Job Description ─────────────────────────────────────────
      case 14:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-slate-800 text-center leading-snug">
              Let's get specific! What else should caregivers know about this job or your loved one?
            </h2>
            <textarea
              placeholder="Job description"
              value={form.jobDescription}
              onChange={e => update('jobDescription', e.target.value.slice(0, 2500))}
              rows={4}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 resize-none"
            />
            <div className="flex justify-between text-xs text-slate-400">
              <span>For your privacy, avoid sharing contact info here.</span>
              <span>{2500 - form.jobDescription.length} chars left</span>
            </div>
            {/* Rotating example */}
            <div className="bg-slate-50 rounded-2xl p-3">
              <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-2">Example from another family</p>
              <div className="flex gap-2 items-start">
                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                  <User size={14} className="text-indigo-500" />
                </div>
                <p className="text-slate-600 text-xs leading-relaxed italic">
                  "{JOB_DESCRIPTION_EXAMPLES[exampleIdx]}"
                </p>
              </div>
              <div className="flex gap-1 justify-center mt-2">
                {JOB_DESCRIPTION_EXAMPLES.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setExampleIdx(i)}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${i === exampleIdx ? 'bg-indigo-500' : 'bg-slate-300'}`}
                  />
                ))}
              </div>
            </div>
            {saveError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">
                {saveError}
              </div>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2 mt-1"
            >
              {saving ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : 'Next'}
            </button>
          </div>
        );

      // ── Step 15: Completion ──────────────────────────────────────────────
      case 15:
        return (
          <div className="flex flex-col items-center text-center gap-5 py-4">
            <div className="w-16 h-16 rounded-full bg-teal-400/20 flex items-center justify-center">
              <Sparkles size={30} className="text-teal-300" />
            </div>
            <h2 className="text-2xl font-bold text-white">
              Well done! We'll notify you as caregivers apply for your job.
            </h2>
            <p className="text-indigo-200 text-sm leading-relaxed">
              Later, review candidates and easily book an interview or hire if you find a great fit for your family.
            </p>
            {nearbyCount !== null && nearbyCount > 0 && (
              <div className="w-full bg-white/15 rounded-2xl px-4 py-3 flex items-center gap-3">
                <Clock size={18} className="text-teal-300 shrink-0" />
                <p className="text-white text-sm">
                  <strong>{nearbyCount}</strong> caregivers in your area are ready to apply.
                </p>
              </div>
            )}
            <p className="text-indigo-200 text-sm">
              In the meantime, feel free to explore Evia.
            </p>
            {hasEmailOnFile ? null : emailSaved ? (
              <div className="w-full bg-white/15 rounded-2xl px-4 py-3 flex items-center gap-2 text-white text-sm">
                <Check size={16} className="text-teal-300 shrink-0" /> Recovery email saved — thanks!
              </div>
            ) : (
              <div className="w-full bg-white/10 rounded-2xl px-4 py-3 text-left">
                <p className="text-white text-sm font-semibold mb-1">Add a recovery email (optional)</p>
                <p className="text-indigo-200 text-xs mb-2.5">
                  Your phone number is how you sign in — an email gives you a way back in if you ever lose access to it.
                </p>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={recoveryEmail}
                  onChange={e => { setRecoveryEmail(e.target.value); setEmailError(null); }}
                  className="w-full border border-white/30 bg-white/10 rounded-xl px-3 py-2 text-white placeholder-indigo-300 text-sm focus:outline-none focus:border-white mb-2"
                />
                {emailError && <p className="text-red-200 text-xs mb-2">{emailError}</p>}
                <button
                  onClick={handleSaveRecoveryEmail}
                  disabled={emailSaving || !recoveryEmail.trim()}
                  className="w-full bg-white/20 text-white text-sm font-semibold py-2 rounded-xl hover:bg-white/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {emailSaving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : 'Save email'}
                </button>
              </div>
            )}
            <button
              onClick={onComplete}
              className="w-full bg-white text-indigo-700 font-semibold py-3 rounded-full hover:bg-indigo-50 transition-colors"
            >
              Explore now
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  // ── Outer shell ───────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`w-full max-w-md rounded-3xl shadow-2xl overflow-hidden ${cardBg} transition-colors duration-300`}>
        {/* Progress bar + back button row */}
        {step > 1 && (
          <div className="flex items-center gap-2 px-4 pt-4">
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
          </div>
        )}

        {/* Step content */}
        <div className="px-6 py-6">
          {renderStep()}
        </div>
      </div>
    </div>
  );
};
