import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ChevronLeft, Star, Loader2,
  CheckCircle, MapPin, Car, AlertCircle
} from 'lucide-react';
import { AvatarUpload } from './ui/AvatarUpload';
import { Badge } from './ui/Badge';
import { ViewType, AddToastFunction, Review, Caregiver } from '../types';
import { dbService, authService, uploadCaregiverProfilePhoto, CAREGIVER_PHOTO_FIELDS } from '../services/api';
import { useCareConnex } from '../context/CareConnexContext';
import { useSearchParams } from 'react-router-dom';
import { blocksToWeeklySlots, weeklySlotsToBl } from '../services/availabilityService';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';
import {
  PRIMARY_SERVICES,
  CareKind, CARE_KIND_LABEL, normalizeCareKinds, serviceListsForKinds,
  serviceLabel,
  EXPERIENCE_LEVELS,
  TIME_BLOCKS,
  DAYS,
  JOB_TYPES,
  MAX_CLIENTS_OPTIONS,
  BIO_MIN_CHARS,
  BIO_MAX_CHARS,
} from './caregiver/signup/constants';

interface CaregiverProfileProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

const LANGUAGES = ['English', 'Spanish', 'French', 'Mandarin', 'Vietnamese', 'Tagalog'];

export const CaregiverProfile: React.FC<CaregiverProfileProps> = ({ onNavigate, onShowToast }) => {
  const { refreshCaregiverProfile } = useCareConnex();
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [profile, setProfile] = useState<Partial<Caregiver> & Record<string, any>>({});

  // Editable state mirroring wizard fields
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editBio, setEditBio] = useState('');
  const [editLanguages, setEditLanguages] = useState<string[]>(['English']);
  const [editServices, setEditServices] = useState<string[]>([]);
  // What care they provide — senior / child / both (caregivers.careKinds; missing = senior). Child care, 2026-10-18.
  const [editCareKinds, setEditCareKinds] = useState<CareKind[]>(['senior']);
  const [editExperience, setEditExperience] = useState('');
  const [editRate, setEditRate] = useState('');
  const [editRateTwo, setEditRateTwo] = useState('');
  const [editRateThree, setEditRateThree] = useState('');
  const [editMaxClients, setEditMaxClients] = useState('1');
  const [editRadius, setEditRadius] = useState('10');
  const [editJobTypes, setEditJobTypes] = useState<string[]>([]);
  const [editAvailability, setEditAvailability] = useState<Record<string, string[]>>({});

  const currentUser = authService.getCurrentUser();

  useEffect(() => {
    let unsubscribeReviews: (() => void) | undefined;

    const fetchData = async () => {
      try {
        if (currentUser) {
          const userData = await dbService.getUser(currentUser.uid);
          if (userData) {
            const p = userData as any;
            setProfile(p);
            setEditBio(p.bio || '');
            setEditLanguages(p.languages || ['English']);
            setEditServices(p.services || p.skills || []);
            setEditExperience(p.yearsExperience || p.experience || '');
            setEditRate(String(p.hourlyRate || ''));
            setEditRateTwo(String(p.rateFor2Seniors || p.rateForTwo || ''));
            setEditRateThree(String(p.rateFor3PlusSeniors || p.rateForThree || ''));
            setEditMaxClients(String(p.maxClients || '1'));
            setEditRadius(String(p.serviceRadius || '10'));
            setEditJobTypes(p.jobTypes || []);
            // Normalize to block IDs regardless of whether Firestore has TimeSlots (Evia) or block IDs (onboarding/profile)
            setEditAvailability(weeklySlotsToBl(p.weeklyAvailability || {}) as Record<string, string[]>);
          }
        }

        if (currentUser?.uid) {
          unsubscribeReviews = dbService.subscribeToReviews(currentUser.uid, setReviews);
        }
      } catch {
        onShowToast('Failed to load profile data', 'error');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    return () => { if (unsubscribeReviews) unsubscribeReviews(); };
  }, [currentUser]);

  const averageRating = useMemo(() =>
    reviews.length > 0
      ? (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1)
      : null
  , [reviews]);

  const saveSection = useCallback(async (data: Record<string, any>) => {
    if (currentUser) {
      try {
        await dbService.updateUser('caregivers', currentUser.uid, data);
        setProfile(prev => ({ ...prev, ...data }));
        refreshCaregiverProfile();
        onShowToast('Profile updated', 'success');
      } catch {
        onShowToast('Failed to update', 'error');
        return;
      }
    }
    setEditingSection(null);
  }, [currentUser, onShowToast]);

  const handleImageUpdate = useCallback(async (url: string) => {
    setProfile(prev => ({ ...prev, ...CAREGIVER_PHOTO_FIELDS(url), imageUrl: url }));
    if (currentUser) {
      try {
        // photo + its mirrors photoURL / profilePhoto — the same three Evia writes (sweep C7, 2026-10-11).
        await dbService.updateUser('caregivers', currentUser.uid, CAREGIVER_PHOTO_FIELDS(url) as any);
      } catch {
        onShowToast('Photo saved locally but failed to sync', 'error');
      }
    }
  }, [currentUser, onShowToast]);

  // Derived display values from profile
  const displayServices: string[] = profile.services || profile.skills || editServices;

  // ?edit=services (Set Up Transportation → "Add Transportation to my services", and the Settings
  // driver card's link, 2026-10-06): open the Care Services editor once the record is loaded.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (loading || searchParams.get('edit') !== 'services') return;
    setEditServices(displayServices);
    setEditingSection('services');
    setSearchParams({}, { replace: true });
    setTimeout(() => document.getElementById('care-services')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  // ?section=reviews (the bell's New Review and Evia's review text, 2026-10-07): scroll to the Reviews card.
  useEffect(() => {
    if (loading || searchParams.get('section') !== 'reviews') return;
    setSearchParams({}, { replace: true });
    setTimeout(() => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  // Location is always derived from the city/state saved in Account Settings — never from free-text input
  const displayLocation: string = (profile.city && profile.state)
    ? `${profile.city}, ${profile.state}`
    : profile.city || profile.location || '';
  const displayRadius: string = String(profile.serviceRadius || editRadius);
  const displayAvailability: Record<string, string[]> = weeklySlotsToBl((profile.weeklyAvailability || {}) as Record<string, any[]>) as Record<string, string[]> || editAvailability;
  const displayLanguages: string[] = profile.languages || editLanguages;
  const displayJobTypes: string[] = profile.jobTypes || editJobTypes;
  const displayExperience: string = profile.yearsExperience || String(profile.experience || '') || editExperience;
  const displayRate: string = String(profile.hourlyRate || editRate || '');
  const displayRateTwo: string = String(profile.rateFor2Seniors || profile.rateForTwo || editRateTwo || '');
  const displayRateThree: string = String(profile.rateFor3PlusSeniors || profile.rateForThree || editRateThree || '');
  const displayMaxClients: string = String(profile.maxClients || editMaxClients);

  const SectionActions = ({ section, onEdit, onSave }: { section: string; onEdit: () => void; onSave: () => void }) =>
    editingSection === section ? (
      <div className="flex gap-3">
        <button onClick={() => setEditingSection(null)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
        <button onClick={onSave} className="text-xs text-primary-600 font-semibold hover:text-primary-700">Save</button>
      </div>
    ) : (
      <button onClick={onEdit} className="text-xs text-primary-600 font-semibold hover:text-primary-700">Edit</button>
    );

  if (loading) return (
    <div className="flex justify-center p-10">
      <Loader2 className="animate-spin text-primary-500 w-8 h-8" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24 animate-slide-in">
      <CaregiverTopNav />

      <div className="max-w-5xl mx-auto px-4 py-6">

        <div className="flex items-center mb-4 md:hidden">
          <button
            onClick={() => onNavigate('caregiver')}
            className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <h1 className="text-2xl font-bold text-slate-900 ml-2">My Profile</h1>
        </div>

        {/* Hero card */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-6">
          <div className="bg-gradient-to-r from-primary-500 to-primary-600 h-24" />
          <div className="px-6 pb-5">
            <div className="flex items-end justify-between -mt-10 mb-4">
              {/* ONE photo path on the site + Evia (sweep C7, 2026-10-11): profile-photos/caregivers/{uid}
                  (services/api.ts uploadCaregiverProfilePhoto — the wizard and Evia's /upload/photo
                  write the same object) and ONE field set: photo + photoURL / profilePhoto mirrors. */}
              <AvatarUpload
                currentUrl={profile.photo || profile.imageUrl || (profile as any).profilePhoto || (profile as any).photoURL}
                onImageSelected={handleImageUpdate}
                upload={currentUser ? (file) => uploadCaregiverProfilePhoto(currentUser.uid, file) : undefined}
                onUploadError={msg => onShowToast(msg, 'error')}
              />
              <div className="mb-1">
                {profile.verified
                  ? <Badge variant="success">Background check complete</Badge>
                  : <Badge variant="neutral">Background check pending</Badge>
                }
              </div>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-1">{profile.name}</h2>
            <div className="flex items-center gap-1 mb-2">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-4 h-4 ${averageRating && i < Math.floor(parseFloat(averageRating)) ? 'text-accent-400' : 'text-slate-200'}`}
                  fill="currentColor"
                />
              ))}
              {averageRating
                ? <span className="text-sm font-medium text-slate-700 ml-1">{averageRating} ({reviews.length} {reviews.length === 1 ? 'review' : 'reviews'})</span>
                : <span className="text-sm text-slate-400 ml-1">No reviews yet</span>
              }
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
              {displayLocation && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {displayLocation}
                </span>
              )}
              {displayRate && <span className="font-semibold text-primary-600">${displayRate}/hr</span>}
            </div>
          </div>
        </div>

        <div className="lg:flex lg:gap-6">

          {/* Main content */}
          <div className="flex-1 space-y-4">

            {/* About / Bio */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">About {(profile.name || '').split(' ')[0] || 'Me'}</h3>
                <SectionActions
                  section="about"
                  onEdit={() => { setEditBio(profile.bio || ''); setEditLanguages(displayLanguages); setEditingSection('about'); }}
                  onSave={() => {
                    // ONE bio rule (sweep C7, 2026-10-11): the wizard's — at least 150 characters, same words.
                    if (editBio.trim().length < BIO_MIN_CHARS) {
                      onShowToast(`Please write at least ${BIO_MIN_CHARS} characters (${BIO_MIN_CHARS - editBio.trim().length} more needed)`, 'error');
                      return;
                    }
                    saveSection({ bio: editBio.trim(), languages: editLanguages });
                  }}
                />
              </div>
              {editingSection === 'about' ? (
                <div className="space-y-4">
                  <p className="text-xs text-slate-500">
                    Highlight your experience, personality, and what makes you a great care provider. Min {BIO_MIN_CHARS} characters.
                  </p>
                  <textarea
                    className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-400 min-h-[110px] resize-none"
                    value={editBio}
                    onChange={e => { if (e.target.value.length <= BIO_MAX_CHARS) setEditBio(e.target.value); }}
                    placeholder={`Describe your care background... at least ${BIO_MIN_CHARS} characters required.`}
                  />
                  <div className="flex justify-between -mt-3">
                    <span className={`text-xs ${editBio.length < BIO_MIN_CHARS ? 'text-indigo-500' : 'text-slate-400'}`}>{BIO_MAX_CHARS - editBio.length} left</span>
                    <span className={`text-xs font-medium ${editBio.length < BIO_MIN_CHARS ? 'text-indigo-500' : 'text-teal-600'}`}>{editBio.length}/{BIO_MIN_CHARS} min</span>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-600 mb-2">Languages spoken</p>
                    <div className="flex flex-wrap gap-2">
                      {LANGUAGES.map(lang => (
                        <button
                          key={lang}
                          onClick={() => setEditLanguages(prev =>
                            prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang]
                          )}
                          className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                            editLanguages.includes(lang)
                              ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {lang}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-slate-600 leading-relaxed mb-3 break-all">
                    {profile.bio?.trim()
                      ? profile.bio.trim()
                      : <span className="text-slate-400 italic">Add a bio to introduce yourself to families.</span>
                    }
                  </p>
                  {displayLanguages.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {displayLanguages.map(lang => (
                        <span key={lang} className="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">{lang}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Care Services */}
            <div id="care-services" className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Care Services</h3>
                <SectionActions
                  section="services"
                  onEdit={() => { setEditServices(displayServices); setEditCareKinds(normalizeCareKinds((profile as any).careKinds)); setEditingSection('services'); }}
                  onSave={() => {
                    saveSection({
                      careKinds: editCareKinds,
                      services: editServices,
                      skills: editServices,
                    });
                  }}
                />
              </div>
              {editingSection === 'services' ? (
                <div>
                <p className="text-xs font-semibold text-slate-500 mb-2">What care do you provide?</p>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {([{ value: ['senior'] as CareKind[], label: CARE_KIND_LABEL.senior }, { value: ['child'] as CareKind[], label: CARE_KIND_LABEL.child }, { value: ['senior', 'child'] as CareKind[], label: 'Both' }]).map(choice => {
                    const on = editCareKinds.length === choice.value.length && choice.value.every(k => editCareKinds.includes(k));
                    return (
                      <button key={choice.label} type="button"
                        onClick={() => { setEditCareKinds(choice.value); setEditServices(prev => prev.filter(s => serviceListsForKinds(choice.value).some(l => (l.services as readonly string[]).includes(s)))); }}
                        className={`text-sm px-3 py-2.5 rounded-xl border font-medium transition-all ${on ? 'bg-primary-50 border-primary-400 text-primary-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
                {serviceListsForKinds(editCareKinds).map(list => (
                <div key={list.kind} className="mb-3">
                {serviceListsForKinds(editCareKinds).length > 1 && <p className="text-xs font-semibold text-slate-500 mb-2">{CARE_KIND_LABEL[list.kind]}</p>}
                <div className="grid grid-cols-2 gap-2">
                  {list.services.map(service => (
                    <button
                      key={service}
                      onClick={() => setEditServices(prev =>
                        prev.includes(service) ? prev.filter(s => s !== service) : [...prev, service]
                      )}
                      className={`text-sm px-3 py-2.5 rounded-xl border text-left transition-all flex items-center gap-2 ${
                        editServices.includes(service)
                          ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
                        editServices.includes(service) ? 'bg-primary-500 border-primary-500' : 'border-slate-300'
                      }`}>
                        {editServices.includes(service) && <CheckCircle className="w-3 h-3 text-white" />}
                      </div>
                      {serviceLabel(service)}
                    </button>
                  ))}
                </div>
                </div>
                ))}
                </div>
              ) : (
                // Read view grouped by kind when the profile offers both (founder, 2026-10-18): Transportation shows under each.
                <div className="space-y-3">
                  {displayServices.length > 0
                    ? serviceListsForKinds((profile as any).careKinds).map(list => ({ kind: list.kind, services: list.services.filter(s => displayServices.includes(s)) })).filter(g => g.services.length > 0).map(g => (
                        <div key={g.kind}>
                          {serviceListsForKinds((profile as any).careKinds).length > 1 && <p className="text-xs font-semibold text-slate-500 mb-1.5">{CARE_KIND_LABEL[g.kind]}</p>}
                          <div className="flex flex-wrap gap-2">
                            {g.services.map((s: string) => (
                              <span key={`${g.kind}-${s}`} className="text-sm bg-primary-50 text-primary-700 px-3 py-1.5 rounded-full font-medium">{serviceLabel(s)}</span>
                            ))}
                          </div>
                        </div>
                      ))
                    : <p className="text-sm text-slate-400 italic">No services added yet. Tap Edit to add.</p>
                  }
                </div>
              )}
            </div>


            {/* Rates */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Rates</h3>
                <SectionActions
                  section="rates"
                  onEdit={() => {
                    setEditRate(displayRate);
                    setEditRateTwo(displayRateTwo);
                    setEditRateThree(displayRateThree);
                    setEditExperience(displayExperience);
                    setEditMaxClients(displayMaxClients);
                    setEditingSection('rates');
                  }}
                  onSave={() => {
                    // The wizard's one rule: the 1-person rate is more than $0 (founder 2026-10-04 — no floor, no ceiling).
                    if (!(Number(editRate) > 0)) { onShowToast('Your rate has to be more than $0', 'error'); return; }
                    saveSection({
                    hourlyRate: Number(editRate) || 0,
                    rateFor2Seniors: Number(editRateTwo) || 0,
                    rateFor3PlusSeniors: Number(editRateThree) || 0,
                    yearsExperience: editExperience,
                    experience: editExperience,
                    maxClients: editMaxClients,
                    });
                  }}
                />
              </div>
              {editingSection === 'rates' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      { label: '1 Person', value: editRate, setter: setEditRate },
                      { label: '2 People', value: editRateTwo, setter: setEditRateTwo },
                      { label: '3+ People', value: editRateThree, setter: setEditRateThree },
                    ] as { label: string; value: string; setter: (v: string) => void }[]).map(({ label, value, setter }) => (
                      <div key={label}>
                        <label className="text-xs text-slate-500 block mb-1">{label}</label>
                        <div className="flex items-center border border-slate-200 rounded-xl overflow-hidden">
                          <span className="px-2 py-2.5 text-slate-400 text-sm bg-slate-50 border-r border-slate-200">$</span>
                          <input
                            type="number"
                            className="flex-1 py-2.5 px-2 text-sm focus:outline-none min-w-0"
                            value={value}
                            min={1}
                            placeholder="0"
                            onChange={e => setter(e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Years of experience</label>
                      <select
                        className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-400 bg-white"
                        value={editExperience}
                        onChange={e => setEditExperience(e.target.value)}
                      >
                        <option value="">Select</option>
                        {EXPERIENCE_LEVELS.map(level => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Max clients at once</label>
                      <select
                        className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-400 bg-white"
                        value={editMaxClients}
                        onChange={e => setEditMaxClients(e.target.value)}
                      >
                        {MAX_CLIENTS_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="divide-y divide-slate-100">
                    {[
                      { label: '1 Person', rate: displayRate },
                      { label: '2 People', rate: displayRateTwo },
                      { label: '3+ People', rate: displayRateThree },
                    ].filter(({ rate }) => rate && Number(rate) > 0).map(({ label, rate }) => (
                      <div key={label} className="flex items-center justify-between py-2.5">
                        <span className="text-sm text-slate-600">{label}</span>
                        <span className="text-sm font-bold text-slate-900">${rate}/hr</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-4 pt-1 text-xs text-slate-500">
                    {displayExperience && <span><span className="font-medium text-slate-700">{displayExperience}</span> experience</span>}
                    {displayMaxClients && <span>Up to <span className="font-medium text-slate-700">{displayMaxClients}</span> client{displayMaxClients !== '1' ? 's' : ''} at once</span>}
                  </div>
                </div>
              )}
            </div>

            {/* Weekly Availability */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-bold text-slate-900">Weekly Availability</h3>
                <div className="flex items-center gap-3">
                  <SectionActions
                    section="availability"
                    onEdit={() => {
                      setEditJobTypes(displayJobTypes);
                      setEditAvailability({ ...displayAvailability });
                      setEditingSection('availability');
                    }}
                    onSave={() => saveSection({ jobTypes: editJobTypes, weeklyAvailability: blocksToWeeklySlots(editAvailability) })}
                  />
                </div>
              </div>

              {editingSection === 'availability' ? (
                <div className="space-y-5">
                  {/* Job type pills */}
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Looking for</p>
                    <div className="flex flex-wrap gap-2">
                      {JOB_TYPES.map(jt => (
                        <button
                          key={jt.id}
                          onClick={() => setEditJobTypes([jt.id])}
                          className={`px-4 py-2 rounded-full border-2 text-sm font-semibold transition-all ${
                            editJobTypes.includes(jt.id)
                              ? 'border-primary-500 text-slate-800 bg-white'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {jt.label}
                          {editJobTypes.includes(jt.id) && (
                            <span className="font-normal text-slate-400 ml-1 text-xs">{jt.subtitle}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Weekly schedule grid */}
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Weekly Schedule</p>
                    <div className="overflow-x-auto -mx-1">
                      <table className="w-full min-w-[400px]">
                        <thead>
                          <tr>
                            <th className="w-28" />
                            {DAYS.map(d => {
                              const allOn = TIME_BLOCKS.every(b => (editAvailability[d.id] || []).includes(b.id));
                              return (
                                <th key={d.id} className="text-center pb-2">
                                  <button
                                    onClick={() => setEditAvailability(prev => ({
                                      ...prev,
                                      [d.id]: allOn ? [] : TIME_BLOCKS.map(b => b.id),
                                    }))}
                                    className="text-xs font-semibold text-slate-500 hover:text-primary-600 transition-colors"
                                  >
                                    {d.id.slice(0, 1).toUpperCase() + d.id.slice(1, 3)}
                                  </button>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {TIME_BLOCKS.map(block => (
                            <tr key={block.id}>
                              <td className="py-1 pr-2">
                                <div>
                                  <p className="text-sm font-medium text-slate-600">{block.label}</p>
                                  <p className="text-xs text-slate-400">{block.time}</p>
                                </div>
                              </td>
                              {DAYS.map(d => {
                                const on = (editAvailability[d.id] || []).includes(block.id);
                                return (
                                  <td key={d.id} className="py-1 text-center">
                                    <button
                                      onClick={() => setEditAvailability(prev => {
                                        const cur = prev[d.id] || [];
                                        return {
                                          ...prev,
                                          [d.id]: cur.includes(block.id)
                                            ? cur.filter(t => t !== block.id)
                                            : [...cur, block.id],
                                        };
                                      })}
                                      className={`w-9 h-9 rounded-xl mx-auto block transition-all ${
                                        on ? 'bg-primary-500 hover:bg-primary-600' : 'bg-slate-100 hover:bg-slate-200'
                                      }`}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Job type display */}
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Looking for</p>
                    <div className="flex flex-wrap gap-2">
                      {displayJobTypes.length > 0
                        ? JOB_TYPES.filter(jt => displayJobTypes.includes(jt.id)).map(jt => (
                            <span key={jt.id} className="px-4 py-2 rounded-full border-2 border-primary-500 text-sm font-semibold text-slate-800">
                              {jt.label}
                              <span className="font-normal text-slate-400 ml-1 text-xs">{jt.subtitle}</span>
                            </span>
                          ))
                        : <span className="text-sm text-slate-400 italic">No job types selected.</span>
                      }
                    </div>
                  </div>

                  {/* Read-only grid */}
                  {(() => {
                    const hasAny = Object.values(displayAvailability).some(slots => slots.length > 0);
                    if (!hasAny) return (
                      <p className="text-sm text-slate-400 italic">No availability set yet.</p>
                    );
                    return (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Weekly Schedule</p>
                        <div className="overflow-x-auto -mx-1">
                          <table className="w-full min-w-[400px]">
                            <thead>
                              <tr>
                                <th className="w-28" />
                                {DAYS.map(d => (
                                  <th key={d.id} className="text-xs font-semibold text-slate-500 text-center pb-2">
                                    {d.id.slice(0, 1).toUpperCase() + d.id.slice(1, 3)}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {TIME_BLOCKS.map(block => (
                                <tr key={block.id}>
                                  <td className="py-1 pr-2">
                                    <div>
                                      <p className="text-sm font-medium text-slate-600">{block.label}</p>
                                      <p className="text-xs text-slate-400">{block.time}</p>
                                    </div>
                                  </td>
                                  {DAYS.map(d => {
                                    const on = (displayAvailability[d.id] || []).includes(block.id);
                                    return (
                                      <td key={d.id} className="py-1 text-center">
                                        <div className={`w-9 h-9 rounded-xl mx-auto ${on ? 'bg-primary-500' : 'bg-slate-100'}`} />
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Location & Travel */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-slate-900">Location &amp; Travel</h3>
                <SectionActions
                  section="location"
                  onEdit={() => { setEditRadius(displayRadius); setEditingSection('location'); }}
                  onSave={() => saveSection({ serviceRadius: parseInt(editRadius) || 10 })}
                />
              </div>
              {editingSection === 'location' ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 rounded-xl px-3 py-2.5">
                    <MapPin className="w-4 h-4 text-primary-400 flex-shrink-0" />
                    <span>
                      {displayLocation
                        ? <>Lives in <span className="font-medium text-slate-700">{displayLocation}</span></>
                        : <span className="italic">Update your address in Account Settings to set your location.</span>
                      }
                    </span>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-2">Willing to travel within</label>
                    <div className="flex flex-wrap gap-2">
                      {['5', '10', '15', '25', '50'].map(r => (
                        <button
                          key={r}
                          onClick={() => setEditRadius(r)}
                          className={`text-sm px-3 py-1.5 rounded-full border transition-all ${
                            editRadius === r
                              ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                              : 'border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {r} mi
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {displayLocation ? (
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <MapPin className="w-4 h-4 text-primary-500 flex-shrink-0" />
                      Lives in {displayLocation}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 italic">Add your address in Account Settings.</p>
                  )}
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <MapPin className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    Willing to travel within {displayRadius} miles
                  </div>
                </div>
              )}
            </div>

            {/* Reviews */}
            <div id="reviews" className="bg-white border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <h3 className="font-bold text-slate-900">Reviews</h3>
                {reviews.length > 0 && (
                  <span className="text-sm text-slate-500">
                    · {averageRating} <Star className="w-3.5 h-3.5 text-accent-400 inline -mt-0.5" fill="currentColor" /> ({reviews.length})
                  </span>
                )}
              </div>
              {reviews.length > 0 && (() => {
                const withAnswer = reviews.filter(r => (r as any).wouldRecommend !== null && (r as any).wouldRecommend !== undefined);
                const pct = withAnswer.length > 0 ? Math.round((withAnswer.filter(r => (r as any).wouldRecommend).length / withAnswer.length) * 100) : null;
                const catKeys = ['punctuality','professionalism','communication','careQuality'];
                const catLabels: Record<string, string> = { punctuality:'Punctuality', professionalism:'Professionalism', communication:'Communication', careQuality:'Quality of Care' };
                const catAvgs = catKeys.map(k => {
                  const vals = reviews.map(r => (r as any).categories?.[k]).filter((v: any) => v > 0);
                  return { key: k, label: catLabels[k], avg: vals.length > 0 ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : null };
                }).filter(c => c.avg !== null);
                const overallAvg = reviews.length > 0 ? reviews.reduce((sum: number, r: any) => sum + (r.rating || 0), 0) / reviews.length : null;
                if (!pct && catAvgs.length === 0 && overallAvg === null) return null;
                return (
                  <div className="mb-4 pb-4 border-b border-slate-100 space-y-2">
                    {overallAvg !== null && (
                      <div className="flex items-center gap-2">
                        <div className="flex gap-0.5">
                          {[1,2,3,4,5].map(s => (
                            <Star key={s} className={`w-4 h-4 ${s <= Math.round(overallAvg) ? 'fill-yellow-400 text-yellow-400' : 'fill-current text-slate-200'}`} />
                          ))}
                        </div>
                        <span className="text-sm font-semibold text-slate-700">{overallAvg.toFixed(1)}</span>
                        <span className="text-xs text-slate-400">overall ({reviews.length} {reviews.length === 1 ? 'review' : 'reviews'})</span>
                      </div>
                    )}
                    {pct !== null && (
                      <p className="text-xs text-slate-500">
                        <span className="font-semibold text-green-600">{pct}%</span> of clients would recommend
                      </p>
                    )}
                    {catAvgs.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {catAvgs.map(c => (
                          <div key={c.key} className="flex items-center gap-3">
                            <span className="text-xs text-slate-500 w-32 shrink-0">{c.label}</span>
                            <div className="flex gap-0.5">
                              {[1,2,3,4,5].map(s => (
                                <Star key={s} className={`w-3 h-3 ${s <= Math.round(c.avg!) ? 'text-accent-400' : 'text-slate-200'}`} fill="currentColor" />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              {reviews.length === 0 ? (
                <div className="text-center py-6">
                  <Star className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                  <p className="font-medium text-slate-600 text-sm mb-0.5">No reviews yet</p>
                  <p className="text-xs text-slate-400">Reviews from families will appear here after completed jobs.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {reviews.map(review => (
                    <div key={review.id} className="flex items-start gap-3 pt-4 first:pt-0 border-t border-slate-100 first:border-0">
                      <div className="w-9 h-9 rounded-full bg-primary-100 overflow-hidden flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                        {(review as any).clientPhotoURL
                          ? <img src={(review as any).clientPhotoURL} alt={review.clientName} className="w-full h-full object-cover" />
                          : (review.clientName || 'F').charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <p className="font-semibold text-slate-900 text-sm">{review.clientName || 'Family'}</p>
                        </div>
                        <div className="flex gap-0.5 mb-1">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star key={i} className={`w-3.5 h-3.5 ${i < review.rating ? 'text-accent-400' : 'text-slate-200'}`} fill="currentColor" />
                          ))}
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed">{review.comment}</p>
                        {review.date && (
                          <p className="text-xs text-slate-400 mt-1.5">
                            {new Date(review.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

        </div>

      </div>
    </div>
  );
};
