
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Phone, FileText, ChevronLeft, Plus, Trash2, Loader2, User,
  Check, X, Pencil, MapPin, ClipboardList, StickyNote, PhoneCall,
  Heart, Camera,
} from 'lucide-react';
import { ViewType, AddToastFunction, CarePlan as CarePlanType } from '../types';
import { dbService, authService } from '../services/api';
import { db, storage } from '../lib/firebase';
import { geocodeToLatLng } from '../utils/geocode';
import firebase from '../lib/firebase';
import { ClientNavigation } from './client/ClientNavigation';

const CARE_TYPES = [
  'Mobility Assistance', 'Dementia / Memory Care', 'Medication Reminders',
  'Personal Care', 'Companionship', 'Transportation',
  'Meal Preparation', 'Light Housekeeping',
];

const CARE_NEED_COLORS: Record<string, { border: string; chip: string; title: string }> = {
  'Mobility Assistance':               { border: 'border-l-blue-400',   chip: 'bg-blue-50 border-blue-100 text-blue-700',     title: 'text-blue-800' },
  'Dementia / Memory Care':            { border: 'border-l-violet-400', chip: 'bg-violet-50 border-violet-100 text-violet-700', title: 'text-violet-800' },
  'Medication Reminders':              { border: 'border-l-cyan-400',   chip: 'bg-cyan-50 border-cyan-100 text-cyan-700',     title: 'text-cyan-800' },
  'Personal Care':{ border: 'border-l-pink-400',   chip: 'bg-pink-50 border-pink-100 text-pink-700',     title: 'text-pink-800' },
  'Companionship':                     { border: 'border-l-rose-400',   chip: 'bg-rose-50 border-rose-100 text-rose-700',     title: 'text-rose-800' },
  'Transportation':                    { border: 'border-l-orange-400', chip: 'bg-orange-50 border-orange-100 text-orange-700', title: 'text-orange-800' },
  'Meal Preparation':                  { border: 'border-l-amber-400',  chip: 'bg-amber-50 border-amber-100 text-amber-700',  title: 'text-amber-800' },
  'Light Housekeeping':                { border: 'border-l-teal-400',   chip: 'bg-teal-50 border-teal-100 text-teal-700',     title: 'text-teal-800' },
};

const CARE_NEED_SUBS: Record<string, string[]> = {
  'Mobility Assistance': ['Ambulation', 'Transfer Assist'],
  'Dementia / Memory Care': ['Supervision / Safety monitoring', 'Memory support', 'Redirection / cueing'],
  'Medication Reminders': ['Morning', 'Afternoon', 'Evening', 'Bedtime'],
  'Personal Care': ['Bathing', 'Dressing Assistance', 'Toileting', 'Feeding', 'Comb Hair', 'Oral Hygiene', 'Skin Care', 'Physical Activity'],
  'Companionship': [],
  'Transportation': ['Doctor appointments', 'Grocery shopping', 'Pharmacy visits', 'Hairdresser / barber'],
  'Meal Preparation': ['Breakfast', 'Lunch', 'Snack', 'Dinner'],
  'Light Housekeeping': ['Light housekeeping (dusting, vacuuming, mopping)', 'Change bed linens', 'Change bath towels', 'Take out trash'],
};

const FAV_ACTIVITIES = ['Walk', 'Reading', 'Cooking', 'Gardening', 'Watching TV', 'Socializing', 'Going outside', 'Exercise', 'Hobbies', 'Other'];
const HELP_ACTIVITIES: string[] = [];
const ENTERTAINMENT = ['Music', 'Movies', 'TV Shows', 'Theater', 'Other'];
const FREQ_OPTIONS = ['Daily', 'Weekly', 'Monthly', 'Occasionally'];
const PET_TYPES = ['Dog', 'Cat', 'Fish', 'Other'];

interface LocationEntry { street: string; city: string; state: string; zipCode: string; petsInHome?: boolean; petTypes?: string[]; petName?: string; smokingHousehold?: boolean; lat?: number; lng?: number; }

interface LifestyleData {
  favoriteActivities: string[]; favoriteActivitiesOther: string;
  helpActivities: string[]; helpActivitiesOther: string;
  entertainment: string[]; entertainmentOther: string;
  enjoysConversation: boolean | null; prefersQuiet: boolean | null;
  familyInArea: boolean | null; familyVisitFreq: string;
  friendsVisitors: boolean | null; friendsVisitFreq: string;
  hasAppointments: boolean | null; appointmentsDetails: string;
}

interface TasksData {
  adls: string[]; medicationReminders: string[]; mealPrep: string[];
  personalCare: string[]; householdTasks: string[]; transportation: string[];
}

interface RecipientPlanData {
  careNeeds: string[];
  careNeedDetails: Record<string, string[]>;
  locations: LocationEntry[]; notes: string;
  lifestyle: LifestyleData; tasks: TasksData;
}

interface RecipientEntry { firstName: string; lastName: string; name: string; relationship: string; age?: string; photoURL?: string; }

const getKey = (firstName: string, lastName: string) =>
  `${firstName.toLowerCase()}_${(lastName || 'noname').toLowerCase()}`
    .replace(/\s+/g, '_')
    .replace(/[~*/\[\].]/g, '');

const emptyLocation = (): LocationEntry => ({ street: '', city: '', state: '', zipCode: '' });

const emptyLifestyle = (): LifestyleData => ({
  favoriteActivities: [], favoriteActivitiesOther: '',
  helpActivities: [], helpActivitiesOther: '',
  entertainment: [], entertainmentOther: '',
  enjoysConversation: null, prefersQuiet: null,
  familyInArea: null, familyVisitFreq: '',
  friendsVisitors: null, friendsVisitFreq: '',
  hasAppointments: null, appointmentsDetails: '',
});

const emptyTasks = (): TasksData => ({
  adls: [], medicationReminders: [], mealPrep: [],
  personalCare: [], householdTasks: [], transportation: [],
});

const locLabel = (l: LocationEntry) =>
  [l.street, l.city, [l.state, l.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');

const initials = (name: string) =>
  name.trim().split(/\s+/).map(p => p[0]?.toUpperCase() || '').slice(0, 2).join('');

const LEGACY_NAMES: Record<string, string> = {
  'Personal Care (Bathing & Dressing)': 'Personal Care',
};
const displayName = (need: string) => LEGACY_NAMES[need] || need;

const toggleArr = (arr: string[], item: string) =>
  arr.includes(item) ? arr.filter(i => i !== item) : [...arr, item];

const hasLifestyle = (ls: LifestyleData) =>
  ls.favoriteActivities.length > 0 || ls.helpActivities.length > 0 || ls.entertainment.length > 0 ||
  ls.enjoysConversation !== null || ls.prefersQuiet !== null || ls.familyInArea !== null ||
  ls.friendsVisitors !== null || ls.hasAppointments !== null;


const inputCls = 'border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-400 bg-white';

const lookupZip = async (zip: string): Promise<{ city: string; state: string } | null> => {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!res.ok) return null;
    const data = await res.json();
    const place = data.places?.[0];
    return place ? { city: place['place name'], state: place['state abbreviation'] } : null;
  } catch { return null; }
};

// ── Mini sub-components ───────────────────────────────────

const CheckPill: React.FC<{ label: string; selected: boolean; onClick: () => void }> = ({ label, selected, onClick }) => (
  <button type="button" onClick={onClick}
    className={`flex items-center gap-1 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
      selected ? 'bg-primary-50 border-primary-400 text-primary-700' : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
    }`}>
    {selected && <Check size={10} className="flex-shrink-0" />}{label}
  </button>
);

const YesNo: React.FC<{ value: boolean | null; onChange: (v: boolean) => void; label?: string }> = ({ value, onChange, label }) => (
  <div className="flex items-center justify-between gap-3">
    {label && <span className="text-sm text-slate-600">{label}</span>}
    <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold shrink-0">
      <button type="button" onClick={() => onChange(true)}
        className={`px-4 py-1.5 transition-colors ${value === true ? 'bg-primary-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>Yes</button>
      <button type="button" onClick={() => onChange(false)}
        className={`px-4 py-1.5 border-l border-slate-200 transition-colors ${value === false ? 'bg-slate-500 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>No</button>
    </div>
  </div>
);

const SubSec: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2">
    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{title}</p>
    {children}
  </div>
);

const ReadChips: React.FC<{ label: string; items: string[]; color: string }> = ({ label, items, color }) =>
  items.length === 0 ? null : (
    <div>
      <p className="text-xs text-slate-400 mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map(i => <span key={i} className={`text-xs px-2.5 py-1 rounded-full border font-medium ${color}`}>{i}</span>)}
      </div>
    </div>
  );

const SaveBar: React.FC<{ onSave: () => void; onCancel: () => void; saving: boolean }> = ({ onSave, onCancel, saving }) => (
  <div className="flex gap-2 mt-5 pt-4 border-t border-slate-100">
    <button onClick={onSave} disabled={saving}
      className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
    </button>
    <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg font-medium">Cancel</button>
  </div>
);

// ── Main component ────────────────────────────────────────

interface CarePlanProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
  targetUserId?: string | null;
}

export const CarePlan: React.FC<CarePlanProps> = ({ onNavigate, onShowToast, targetUserId }) => {
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<CarePlanType>({ medications: [], emergencyContacts: [], dailyRoutine: [] });
  const [wizardData, setWizardData] = useState<any>(null);
  const [recipientPlans, setRecipientPlans] = useState<Record<string, RecipientPlanData>>({});
  const [locationPool, setLocationPool] = useState<LocationEntry[]>([]);
  const [activeRecipient, setActiveRecipient] = useState(0);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [recipientPhotos, setRecipientPhotos] = useState<Record<number, string>>({});
  const [profilePhotoURL, setProfilePhotoURL] = useState<string | null>(null);

  const [editingSection, setEditingSection] = useState<'careNeeds' | 'locations' | 'notes' | 'lifestyle' | 'tasks' | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const [draftPlan, setDraftPlan] = useState<RecipientPlanData | null>(null);

  const [draftLocPool, setDraftLocPool] = useState<LocationEntry[]>([]);
  const [editingPoolIdx, setEditingPoolIdx] = useState<number | null>(null);
  const [editingPoolDraft, setEditingPoolDraft] = useState<LocationEntry | null>(null);
  const [editingCustomLoc, setEditingCustomLoc] = useState(false);

  const [editingContactIdx, setEditingContactIdx] = useState<number | null>(null);
  const [savingContacts, setSavingContacts] = useState(false);

  const [editingSetupContact, setEditingSetupContact] = useState(false);
  const [setupDraft, setSetupDraft] = useState({ firstName: '', lastName: '', phone: '', relationship: '' });
  const [savingSetup, setSavingSetup] = useState(false);

  const [showAddRecipient, setShowAddRecipient] = useState(false);
  const [newRecipient, setNewRecipient] = useState({ firstName: '', lastName: '', relationship: '', age: '' });
  const [newDraft, setNewDraft] = useState<RecipientPlanData>({ careNeeds: [], careNeedDetails: {}, locations: [], notes: '', lifestyle: emptyLifestyle(), tasks: emptyTasks() });
  const [newCustomLoc, setNewCustomLoc] = useState(false);
  const [newLocEditIdx, setNewLocEditIdx] = useState<number | null>(null);
  const [newLocEditDraft, setNewLocEditDraft] = useState<LocationEntry | null>(null);
  const [newLocConfirmDeleteIdx, setNewLocConfirmDeleteIdx] = useState<number | null>(null);
  const [savingRecipient, setSavingRecipient] = useState(false);
  const [confirmDeleteRecipient, setConfirmDeleteRecipient] = useState(false);
  const [confirmDeletePoolIdx, setConfirmDeletePoolIdx] = useState<number | null>(null);
  const [carePlanReviewedAt, setCarePlanReviewedAt] = useState<boolean>(false);
  const [savingReview, setSavingReview] = useState(false);

  const dirtyContactsRef = useRef(false);

  const currentUser = authService.getCurrentUser();
  const isReadOnly = !!targetUserId && targetUserId !== currentUser?.uid;
  const currentPlanId = targetUserId || currentUser?.uid || null;

  // Load profile photo for "myself" recipient
  useEffect(() => {
    if (!currentUser?.uid || !db) return;
    db.collection('users').doc(currentUser.uid).get()
      .then(snap => {
        const d = snap.data() as any;
        const url = d?.photoURL || d?.photo || d?.profilePhoto || null;
        if (url) setProfilePhotoURL(url);
      }).catch(() => {});
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!currentPlanId) { setLoading(false); onNavigate('login'); return; }
    const unsub = dbService.subscribeToCarePlan(currentPlanId, updated => {
      setPlan(prev => dirtyContactsRef.current
        ? { ...updated, emergencyContacts: prev.emergencyContacts }
        : updated
      );
      setLoading(false);
    });
    return () => unsub();
  }, [currentPlanId]);

  useEffect(() => {
    const load = async () => {
      if (!currentPlanId || !db) return;
      try {
        const snap = await db.collection('job_postings').doc(currentPlanId).get();
        const data = snap.exists ? snap.data() as any : {};
        setWizardData(data);
        // Pre-populate recipient photos from stored data
        const photos: Record<number, string> = {};
        if (data?.careRecipientPhotoURL) photos[0] = data.careRecipientPhotoURL;
        (data?.additionalRecipients || []).forEach((r: any, i: number) => {
          if (r?.photoURL) photos[i + 1] = r.photoURL;
        });
        setRecipientPhotos(photos);
      } catch {}
    };
    load();
  }, [currentPlanId]);

  const [carePlanDocLoaded, setCarePlanDocLoaded] = useState(false);

  useEffect(() => {
    if (!currentPlanId || !db) return;
    const unsub = db.collection('carePlans').doc(currentPlanId).onSnapshot(snap => {
      const data = snap.data() as any;
      setCarePlanDocLoaded(true);
      if (!data) return;
      const plans: Record<string, RecipientPlanData> = { ...(data.recipientPlans || {}) };
      Object.keys(data).forEach(k => {
        if (k.startsWith('recipientPlans.')) {
          const key = k.slice('recipientPlans.'.length);
          if (!plans[key]) plans[key] = data[k];
        }
      });
      if (Object.keys(plans).length > 0) setRecipientPlans(plans);
      if (data.locationPool) setLocationPool(data.locationPool);
      setCarePlanReviewedAt(!!data.carePlanReviewedAt);
    }, () => { setCarePlanDocLoaded(true); });
    return () => unsub();
  }, [currentPlanId]);




  const recipients = useMemo((): RecipientEntry[] => {
    if (!wizardData || !wizardData.careRecipientFirstName) return [];
    const list: RecipientEntry[] = [];
    const seenKeys = new Set<string>();
    const pFirst = wizardData.careRecipientFirstName || '';
    const pLast = wizardData.careRecipientLastName || '';
    seenKeys.add(getKey(pFirst, pLast));
    list.push({ firstName: pFirst, lastName: pLast, name: [pFirst, pLast].filter(Boolean).join(' ') || 'Primary Recipient', relationship: wizardData.relationship || '', age: wizardData.careRecipientAge || '', photoURL: wizardData.careRecipientPhotoURL || '' });
    (wizardData.additionalRecipients || []).forEach((r: any, i: number) => {
      const rFirst = (r.firstName || '').trim();
      const rLast = (r.lastName || '').trim();
      if (!rFirst) return; // skip blank entries
      const rKey = getKey(rFirst, rLast);
      if (seenKeys.has(rKey)) return; // skip duplicates
      seenKeys.add(rKey);
      list.push({ firstName: rFirst, lastName: rLast, name: [rFirst, rLast].filter(Boolean).join(' '), relationship: r.relationship || '', age: r.age || '', photoURL: r.photoURL || '' });
    });
    return list;
  }, [wizardData]);

  const wizardLocations = useMemo((): LocationEntry[] => {
    if (!wizardData) return [];
    const all: LocationEntry[] = [];
    if (wizardData.street || wizardData.city) all.push({ street: wizardData.street || '', city: wizardData.city || '', state: wizardData.state || '', zipCode: wizardData.zipCode || '' });
    (wizardData.savedLocations || []).forEach((loc: any) => {
      const dupe = all.some(l => l.street?.toLowerCase() === loc.street?.toLowerCase() && l.zipCode === loc.zipCode);
      if (!dupe && (loc.street || loc.city)) all.push({ street: loc.street || '', city: loc.city || '', state: loc.state || '', zipCode: loc.zipCode || '' });
    });
    return all;
  }, [wizardData]);

  const effectivePool = locationPool.length > 0 ? locationPool : wizardLocations;

  const getPlan = (r: RecipientEntry): RecipientPlanData => {
    const key = getKey(r.firstName, r.lastName);
    const stored = recipientPlans[key];
    if (stored) {
      return {
        ...stored,
        careNeeds: stored.careNeeds ?? wizardData?.careNeeds ?? [],
        locations: stored.locations ?? wizardLocations.slice(0, 1),
        notes: stored.notes ?? wizardData?.jobDescription ?? '',
        careNeedDetails: stored.careNeedDetails ?? {},
        lifestyle: { ...emptyLifestyle(), ...(stored.lifestyle || {}) },
        tasks: { ...emptyTasks(), ...(stored.tasks || {}) },
      };
    }
    return {
      careNeeds: wizardData?.careNeeds || [],
      careNeedDetails: {},
      locations: wizardLocations.slice(0, 1),
      notes: wizardData?.jobDescription || '',
      lifestyle: emptyLifestyle(),
      tasks: emptyTasks(),
    };
  };

  // Auto-seed recipientPlans in Firestore from wizard data so checks pass without needing a manual save
  useEffect(() => {
    if (!carePlanDocLoaded || !currentPlanId || !db || recipients.length === 0 || !wizardData) return;
    const missing = recipients.filter(r => !recipientPlans[getKey(r.firstName, r.lastName)]);
    if (missing.length === 0) return;
    const updatePayload: Record<string, any> = {};
    missing.forEach(r => {
      const key = getKey(r.firstName, r.lastName);
      updatePayload[`recipientPlans.${key}`] = JSON.parse(JSON.stringify(getPlan(r)));
    });
    const docRef = db.collection('carePlans').doc(currentPlanId);
    docRef.update(updatePayload).catch(() =>
      docRef.set({ recipientPlans: Object.fromEntries(missing.map(r => [getKey(r.firstName, r.lastName), JSON.parse(JSON.stringify(getPlan(r)))])) }, { merge: true })
    );
  }, [carePlanDocLoaded, recipients, wizardData]);

  const startEdit = (section: typeof editingSection) => {
    if (!recipient) return;
    setDraftPlan({ ...getPlan(recipient) });
    if (section === 'locations') {
      setDraftLocPool([...effectivePool]);
      setEditingPoolIdx(null);
      setEditingPoolDraft(null);
      setEditingCustomLoc(false);
    }
    setEditingSection(section);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setDraftPlan(null);
    setDraftLocPool([]);
    setEditingPoolIdx(null);
    setEditingPoolDraft(null);
    setConfirmDeletePoolIdx(null);
    setEditingCustomLoc(false);
  };

  const saveSection = async () => {
    if (!recipient || !draftPlan || !currentPlanId || !db) return;
    if (editingSection === 'locations') {
      if (editingPoolIdx !== null) { onShowToast('Please save or cancel the address you\'re editing first', 'error'); return; }
      const hasLocation = draftPlan.locations.some(l => l.street || l.city);
      if (!hasLocation) { onShowToast('Please select or add a care location', 'error'); return; }
    }
    setSavingSection(true);
    // Strip blank entries and undefined fields — Firestore rejects undefined values
    // Geocode each location so lat/lng travels with the address everywhere it's used
    const rawPool = draftLocPool.filter(l => l.street.trim() || l.city.trim());
    const cleanPool: LocationEntry[] = await Promise.all(rawPool.map(async (l): Promise<LocationEntry> => {
      const entry: LocationEntry = { street: l.street, city: l.city, state: l.state, zipCode: l.zipCode };
      if (l.petsInHome !== undefined) entry.petsInHome = l.petsInHome;
      if (l.smokingHousehold !== undefined) entry.smokingHousehold = l.smokingHousehold;
      if (l.petTypes?.length) entry.petTypes = l.petTypes;
      if (l.petName) entry.petName = l.petName;
      // Always geocode on save; fall back to existing coords if Nominatim fails
      const coords = await geocodeToLatLng(l.street, l.city, l.state, l.zipCode);
      if (coords) { entry.lat = coords.lat; entry.lng = coords.lng; }
      else if (l.lat != null && l.lng != null) { entry.lat = l.lat; entry.lng = l.lng; }
      return entry;
    }));
    try {
      const key = getKey(recipient.firstName, recipient.lastName);
      // JSON round-trip strips any remaining undefined values before writing to Firestore
      const updated = JSON.parse(JSON.stringify({ ...getPlan(recipient), ...draftPlan }));
      const docRef = db.collection('carePlans').doc(currentPlanId);
      const updatePayload: Record<string, any> = { [`recipientPlans.${key}`]: updated };
      if (editingSection === 'locations') updatePayload.locationPool = cleanPool;
      try {
        await docRef.update(updatePayload);
      } catch (e: any) {
        if (e.code === 'not-found') {
          const payload: Record<string, any> = { recipientPlans: { [key]: updated } };
          if (editingSection === 'locations') payload.locationPool = cleanPool;
          await docRef.set(payload);
        } else throw e;
      }
      setRecipientPlans(prev => ({ ...prev, [key]: updated }));
      if (editingSection === 'locations') setLocationPool(cleanPool);
      cancelEdit();
      onShowToast('Saved', 'success');
    } catch (err) {
      console.error('Care plan save error:', err);
      onShowToast('Failed to save', 'error');
    } finally { setSavingSection(false); }
  };

  const handleRecipientPhotoUpload = async (file: File, recipientIndex: number) => {
    if (!currentPlanId || !db) { onShowToast('Not ready — please try again', 'error'); return; }
    if (!storage) { onShowToast('Photo uploads unavailable — storage not configured', 'error'); return; }
    setUploadingPhoto(true);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `clients/${currentPlanId}/recipients/recipient_${recipientIndex}_${Date.now()}.${ext}`;
      const ref = storage.ref().child(path);
      const snap = await ref.put(file, { contentType: file.type });
      const url = await snap.ref.getDownloadURL();
      if (recipientIndex === 0) {
        await db.collection('job_postings').doc(currentPlanId).set({ careRecipientPhotoURL: url }, { merge: true });
      } else {
        const additionals = [...(wizardData?.additionalRecipients || [])];
        if (additionals[recipientIndex - 1]) {
          additionals[recipientIndex - 1] = { ...additionals[recipientIndex - 1], photoURL: url };
          await db.collection('job_postings').doc(currentPlanId).set({ additionalRecipients: additionals }, { merge: true });
        }
      }
      setRecipientPhotos(prev => ({ ...prev, [recipientIndex]: url }));
      onShowToast('Photo saved', 'success');
    } catch (err) {
      console.error('Recipient photo upload failed:', err);
      onShowToast('Photo upload failed — check console for details', 'error');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleTabChange = (i: number) => {
    setActiveRecipient(i);
    cancelEdit();
    setEditingContactIdx(null);
    setEditingSetupContact(false);
  };

  const addContact = () => {
    dirtyContactsRef.current = true;
    const newContacts = [...plan.emergencyContacts, { id: crypto.randomUUID(), name: '', relation: '', phone: '', isPrimary: false }];
    setPlan(prev => ({ ...prev, emergencyContacts: newContacts }));
    setEditingContactIdx(newContacts.length - 1);
  };

  const updateContact = (idx: number, field: string, value: any) => {
    if (isReadOnly) return;
    dirtyContactsRef.current = true;
    setPlan(prev => { const list = [...prev.emergencyContacts]; list[idx] = { ...list[idx], [field]: value }; return { ...prev, emergencyContacts: list }; });
  };

  const deleteContact = async (idx: number) => {
    if (isReadOnly || !currentPlanId) return;
    const updatedList = plan.emergencyContacts.filter((_, i) => i !== idx);
    const updatedPlan = { ...plan, emergencyContacts: updatedList };
    setPlan(updatedPlan);
    setEditingContactIdx(null);
    try {
      await dbService.updateCarePlan(currentPlanId, updatedPlan);
      dirtyContactsRef.current = false;
    } catch {}
  };

  const handlePhoneInput = (idx: number, value: string) => {
    updateContact(idx, 'phone', value.replace(/[^\d+\-() ]/g, '').slice(0, 16));
  };

  const handleReview = async () => {
    if (!currentPlanId || !db || savingReview) return;
    setSavingReview(true);
    try {
      const cpRef = db.collection('carePlans').doc(currentPlanId);
      const update: Record<string, any> = {
        carePlanReviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      // Migrate wizard emergency contact if not yet in carePlans
      const cpSnap = await cpRef.get();
      const existingContacts: any[] = (cpSnap.data() as any)?.emergencyContacts || [];
      if (existingContacts.length === 0 && wizardData?.emergencyFirstName) {
        update.emergencyContacts = [{
          id: 'wizard',
          name: [wizardData.emergencyFirstName, wizardData.emergencyLastName].filter(Boolean).join(' '),
          relation: wizardData.emergencyRelationship || '',
          phone: wizardData.emergencyPhone || '',
          isPrimary: true,
        }];
      }
      await cpRef.set(update, { merge: true });
      setCarePlanReviewedAt(true);
      onShowToast('Care plan confirmed!', 'success');
    } catch {
      onShowToast('Could not save. Please try again.', 'error');
    } finally {
      setSavingReview(false);
    }
  };

  const saveContacts = async () => {
    if (!currentPlanId) return;
    const editing = plan.emergencyContacts[editingContactIdx ?? -1];
    if (editing?.phone && editing.phone.replace(/\D/g, '').length < 10) {
      onShowToast('Phone number must be at least 10 digits', 'error');
      return;
    }
    setSavingContacts(true);
    try {
      await dbService.updateCarePlan(currentPlanId, plan);
      dirtyContactsRef.current = false;
      setEditingContactIdx(null);
      onShowToast('Contact saved', 'success');
    } catch { onShowToast('Failed to save contact', 'error'); }
    finally { setSavingContacts(false); }
  };

  const saveNewLoc = async () => {
    if (newLocEditIdx === null || !newLocEditDraft || !db || !currentPlanId) return;
    if (!newLocEditDraft.street.trim()) { onShowToast('Street address is required', 'error'); return; }
    // Geocode the edited address before saving
    const coords = await geocodeToLatLng(newLocEditDraft.street, newLocEditDraft.city, newLocEditDraft.state, newLocEditDraft.zipCode);
    const geocodedDraft: LocationEntry = coords
      ? { ...newLocEditDraft, lat: coords.lat, lng: coords.lng }
      : newLocEditDraft;
    const base = locationPool.length > 0 ? [...locationPool] : [...wizardLocations];
    const newPool = base.map((l, i) => i === newLocEditIdx ? geocodedDraft : l);
    const wasSelected = newDraft.locations[0]?.street === effectivePool[newLocEditIdx]?.street && newDraft.locations[0]?.zipCode === effectivePool[newLocEditIdx]?.zipCode;
    if (wasSelected) setNewDraft(p => ({ ...p, locations: [geocodedDraft] }));
    try { await db.collection('carePlans').doc(currentPlanId).set({ locationPool: newPool }, { merge: true }); setLocationPool(newPool); } catch {}
    setNewLocEditIdx(null); setNewLocEditDraft(null);
  };

  const deleteNewLoc = async (idx: number) => {
    if (!db || !currentPlanId) return;
    const base = locationPool.length > 0 ? [...locationPool] : [...wizardLocations];
    const newPool = base.filter((_, i) => i !== idx);
    const wasSelected = newDraft.locations[0]?.street === effectivePool[idx]?.street && newDraft.locations[0]?.zipCode === effectivePool[idx]?.zipCode;
    if (wasSelected) setNewDraft(p => ({ ...p, locations: [] }));
    try { await db.collection('carePlans').doc(currentPlanId).set({ locationPool: newPool }, { merge: true }); setLocationPool(newPool); } catch {}
    setNewLocConfirmDeleteIdx(null);
  };

  const saveNewRecipient = async () => {
    if (!newRecipient.firstName.trim()) { onShowToast('First name is required', 'error'); return; }
    if (/[~*/\[\]]/.test(newRecipient.firstName) || /[~*/\[\]]/.test(newRecipient.lastName)) {
      onShowToast('Names cannot contain special characters like / * [ ]', 'error'); return;
    }
    if (!newRecipient.relationship) { onShowToast('Please select a relationship', 'error'); return; }
    if (newRecipient.relationship.toLowerCase() === 'myself' && recipients.some(r => r.relationship?.toLowerCase() === 'myself')) {
      onShowToast('You can only add yourself once', 'error'); return;
    }
    const loc = newDraft.locations[0];
    if (!loc || !loc.street.trim()) { onShowToast('Please select or enter a care location with a street address', 'error'); return; }
    if (!currentPlanId || !db) return;
    setSavingRecipient(true);
    try {
      const entry = { firstName: newRecipient.firstName.trim(), lastName: newRecipient.lastName.trim(), relationship: newRecipient.relationship, age: newRecipient.age.trim() };

      const isFirstRecipient = !wizardData?.careRecipientFirstName;
      if (isFirstRecipient) {
        await db.collection('job_postings').doc(currentPlanId).set({
          careRecipientFirstName: entry.firstName,
          careRecipientLastName: entry.lastName,
          relationship: entry.relationship,
          careRecipientAge: entry.age,
        }, { merge: true });
      } else {
        await db.collection('job_postings').doc(currentPlanId).set(
          { additionalRecipients: firebase.firestore.FieldValue.arrayUnion(entry) },
          { merge: true }
        );
      }

      // Save the plan the user filled in during add (never inherits wizard defaults)
      const key = getKey(entry.firstName, entry.lastName);
      const blankPlan: RecipientPlanData = { ...newDraft };

      // Merge new recipient's address into the shared locationPool (with geocoding)
      const newLoc = newDraft.locations.find(l => l.street || l.city);
      const currentPool = locationPool.length > 0 ? [...locationPool] : [...wizardLocations];
      let updatedPool = currentPool;
      if (newLoc) {
        const locKey = `${newLoc.street?.toLowerCase()}${newLoc.zipCode}`;
        const alreadyInPool = currentPool.some(l => `${l.street?.toLowerCase()}${l.zipCode}` === locKey);
        if (!alreadyInPool) {
          const coords = await geocodeToLatLng(newLoc.street, newLoc.city, newLoc.state, newLoc.zipCode);
          const geocodedLoc = coords ? { ...newLoc, lat: coords.lat, lng: coords.lng } : newLoc;
          updatedPool = [...currentPool, geocodedLoc];
        }
      }

      const cpRef = db.collection('carePlans').doc(currentPlanId);
      const cpPayload: Record<string, any> = { [`recipientPlans.${key}`]: blankPlan };
      if (updatedPool !== currentPool) cpPayload.locationPool = updatedPool;
      try {
        await cpRef.update(cpPayload);
      } catch (e: any) {
        if (e.code === 'not-found') await cpRef.set({ recipientPlans: { [key]: blankPlan }, ...(updatedPool !== currentPool ? { locationPool: updatedPool } : {}) });
      }

      if (updatedPool !== currentPool) setLocationPool(updatedPool);

      const newIndex = isFirstRecipient ? 0 : recipients.length;
      setRecipientPlans(prev => ({ ...prev, [key]: blankPlan }));
      if (isFirstRecipient) {
        setWizardData((prev: any) => ({ ...(prev || {}), careRecipientFirstName: entry.firstName, careRecipientLastName: entry.lastName, relationship: entry.relationship, careRecipientAge: entry.age }));
      } else {
        setWizardData((prev: any) => ({ ...prev, additionalRecipients: [...(prev?.additionalRecipients || []), entry] }));
      }
      setNewRecipient({ firstName: '', lastName: '', relationship: '', age: '' });
      setNewDraft({ careNeeds: [], careNeedDetails: {}, locations: [], notes: '', lifestyle: emptyLifestyle(), tasks: emptyTasks() });
      setNewCustomLoc(false);
      setNewLocEditIdx(null); setNewLocEditDraft(null); setNewLocConfirmDeleteIdx(null);
      setShowAddRecipient(false);
      setActiveRecipient(newIndex);
      onShowToast('Recipient added', 'success');
    } catch { onShowToast('Failed to add recipient', 'error'); }
    finally { setSavingRecipient(false); }
  };

  const deleteRecipient = async () => {
    if (!currentPlanId || !db) return;
    const r = recipients[activeRecipient];
    try {
      const archived = { firstName: r.firstName, lastName: r.lastName, relationship: r.relationship, age: r.age || '', deletedAt: new Date().toISOString() };

      // Preserve the deleted recipient's locations in the shared pool
      const key = getKey(r.firstName, r.lastName);
      const recipientLocs = (recipientPlans[key]?.locations || []).filter((l: LocationEntry) => l.street || l.city);
      if (recipientLocs.length > 0) {
        const currentPool = locationPool.length > 0 ? [...locationPool] : [...wizardLocations];
        const seenKeys = new Set(currentPool.map(l => `${l.street?.toLowerCase()}${l.zipCode}`));
        const toAdd = recipientLocs.filter(l => !seenKeys.has(`${l.street?.toLowerCase()}${l.zipCode}`));
        if (toAdd.length > 0) {
          const updatedPool = [...currentPool, ...toAdd];
          await db.collection('carePlans').doc(currentPlanId).set({ locationPool: updatedPool }, { merge: true });
          setLocationPool(updatedPool);
        }
      }

      if (activeRecipient === 0) {
        // Promote first additional to primary, or clear primary if none
        const additionals = wizardData?.additionalRecipients || [];
        const next = additionals[0];
        const remainingAdditionals = additionals.slice(1);
        if (next) {
          await db.collection('job_postings').doc(currentPlanId).update({
            careRecipientFirstName: next.firstName,
            careRecipientLastName: next.lastName || '',
            relationship: next.relationship || '',
            careRecipientAge: next.age || '',
            additionalRecipients: remainingAdditionals,
            deletedRecipients: firebase.firestore.FieldValue.arrayUnion(archived),
          });
          setWizardData((prev: any) => ({ ...prev, careRecipientFirstName: next.firstName, careRecipientLastName: next.lastName || '', relationship: next.relationship || '', careRecipientAge: next.age || '', additionalRecipients: remainingAdditionals }));
        } else {
          await db.collection('job_postings').doc(currentPlanId).update({
            careRecipientFirstName: firebase.firestore.FieldValue.delete(),
            careRecipientLastName: firebase.firestore.FieldValue.delete(),
            relationship: firebase.firestore.FieldValue.delete(),
            careRecipientAge: firebase.firestore.FieldValue.delete(),
            deletedRecipients: firebase.firestore.FieldValue.arrayUnion(archived),
          });
          setWizardData((prev: any) => {
            const u = { ...prev };
            delete u.careRecipientFirstName; delete u.careRecipientLastName;
            delete u.relationship; delete u.careRecipientAge;
            return u;
          });
        }
      } else {
        const updatedAdditional = (wizardData?.additionalRecipients || []).filter(
          (ar: any) => !(ar.firstName === r.firstName && ar.lastName === r.lastName)
        );
        await db.collection('job_postings').doc(currentPlanId).update({
          additionalRecipients: updatedAdditional,
          deletedRecipients: firebase.firestore.FieldValue.arrayUnion(archived),
        });
        setWizardData((prev: any) => ({ ...prev, additionalRecipients: updatedAdditional }));
      }

      setActiveRecipient(Math.max(0, activeRecipient - 1));
      setConfirmDeleteRecipient(false);
      cancelEdit();
      onShowToast('Recipient removed', 'success');
    } catch { onShowToast('Failed to remove recipient', 'error'); }
  };



  const startEditSetup = () => {
    setSetupDraft({
      firstName: wizardData?.emergencyFirstName || '',
      lastName: wizardData?.emergencyLastName || '',
      phone: wizardData?.emergencyPhone || '',
      relationship: wizardData?.emergencyRelationship || '',
    });
    setEditingSetupContact(true);
  };

  const saveSetupContact = async () => {
    if (!currentPlanId || !db) return;
    if (setupDraft.phone.replace(/\D/g, '').length < 10) {
      onShowToast('Phone number must be at least 10 digits', 'error');
      return;
    }
    setSavingSetup(true);
    try {
      const normalizedContact = {
        id: 'wizard',
        name: [setupDraft.firstName, setupDraft.lastName].filter(Boolean).join(' '),
        relation: setupDraft.relationship,
        phone: setupDraft.phone,
        isPrimary: true,
      };
      await Promise.all([
        db.collection('job_postings').doc(currentPlanId).update({
          emergencyFirstName: setupDraft.firstName,
          emergencyLastName: setupDraft.lastName,
          emergencyPhone: setupDraft.phone,
          emergencyRelationship: setupDraft.relationship,
        }),
        dbService.updateCarePlan(currentPlanId, { ...plan, emergencyContacts: [normalizedContact] }),
      ]);
      setPlan(prev => ({ ...prev, emergencyContacts: [normalizedContact] }));
      setWizardData((prev: any) => ({ ...prev, emergencyFirstName: setupDraft.firstName, emergencyLastName: setupDraft.lastName, emergencyPhone: setupDraft.phone, emergencyRelationship: setupDraft.relationship }));
      setEditingSetupContact(false);
      onShowToast('Contact updated', 'success');
    } catch { onShowToast('Failed to save', 'error'); }
    finally { setSavingSetup(false); }
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
    </div>
  );

  const recipient = recipients[activeRecipient];
  const rPlan = recipient ? getPlan(recipient) : null;
  const draft = draftPlan;

  // helpers for lifestyle draft updates
  const setLS = (patch: Partial<LifestyleData>) =>
    setDraftPlan(prev => prev ? { ...prev, lifestyle: { ...prev.lifestyle, ...patch } } : prev);
  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {!targetUserId && <ClientNavigation />}
      <div className="max-w-3xl mx-auto p-4 md:p-6 animate-slide-in">

        <div className="flex items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 leading-tight">Care Plan</h1>
            <p className="text-sm text-slate-400 mt-0.5">Manage care details for each recipient</p>
          </div>
        </div>

        {!isReadOnly && !carePlanReviewedAt && recipients.length > 0 && (
          <div className="mb-6 bg-primary-50 border border-primary-200 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-primary-800">Review your care plan</p>
              <p className="text-xs text-primary-600 mt-0.5">Look everything over and confirm it looks correct.</p>
            </div>
            <button
              onClick={handleReview}
              disabled={savingReview}
              className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-2 rounded-xl shrink-0 disabled:opacity-60 transition-colors"
            >
              {savingReview ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Looks good
            </button>
          </div>
        )}

        {recipients.length > 0 || showAddRecipient ? (
          <>
            {/* Recipient cards */}
            {recipients.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-2 mb-4 items-start">
                {recipients.map((r, i) => {
                  const active = activeRecipient === i;
                  return (
                    <div
                      key={i}
                      onClick={() => handleTabChange(i)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-2xl border-2 cursor-pointer transition-all select-none shrink-0 ${
                        active
                          ? 'bg-primary-600 border-primary-600 text-white shadow-sm'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
                      }`}>
                      {(() => {
                        const isMyself = r.relationship?.toLowerCase() === 'myself';
                        const photo = isMyself ? (profilePhotoURL || recipientPhotos[i]) : recipientPhotos[i];
                        return (
                          <div className="relative shrink-0 group/photo">
                            <div className={`w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center text-xs font-bold shrink-0 ${active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}>
                              {photo
                                ? <img src={photo} alt={r.name} className="w-full h-full object-cover" />
                                : (initials(r.name) || <User className="w-4 h-4" />)
                              }
                            </div>
                            {!isReadOnly && !isMyself && (
                              <label className="absolute inset-0 rounded-xl flex items-center justify-center bg-black/40 opacity-0 group-hover/photo:opacity-100 transition-opacity cursor-pointer"
                                onClick={e => e.stopPropagation()}>
                                {uploadingPhoto && activeRecipient === i
                                  ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                                  : <Camera className="w-3.5 h-3.5 text-white" />
                                }
                                <input type="file" accept="image/*" className="hidden"
                                  onChange={e => { const f = e.target.files?.[0]; if (f) handleRecipientPhotoUpload(f, i); e.target.value = ''; }}
                                />
                              </label>
                            )}
                          </div>
                        );
                      })()}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold whitespace-nowrap">{r.name}</p>
                          {active && recipients.length > 1 && (
                            <span className="text-xs font-medium bg-white/20 text-white px-2 py-0.5 rounded-full shrink-0">Selected</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          {r.relationship && <span className={`text-xs capitalize ${active ? 'text-white/75' : 'text-slate-400'}`}>{r.relationship}</span>}
                          {r.relationship && r.age && <span className={`text-xs ${active ? 'text-white/50' : 'text-slate-300'}`}>·</span>}
                          {r.age && <span className={`text-xs ${active ? 'text-white/75' : 'text-slate-400'}`}>Age {r.age}</span>}
                        </div>
                      </div>
                      {!isReadOnly && recipients.length > 1 && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleTabChange(i); setConfirmDeleteRecipient(true); }}
                          className={`p-1 rounded-lg transition-colors shrink-0 ${active ? 'text-white/60 hover:text-white hover:bg-white/20' : 'text-slate-300 hover:text-red-500 hover:bg-red-50'}`}
                          title="Remove recipient">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {!isReadOnly && recipients.length < 4 && !showAddRecipient && (
                  <button onClick={() => setShowAddRecipient(true)}
                    className="flex items-center gap-1.5 px-4 py-3 rounded-2xl text-sm font-semibold border-2 border-dashed border-slate-300 text-slate-400 hover:border-primary-400 hover:text-primary-600 transition-all bg-white shrink-0 self-stretch">
                    <Plus className="w-4 h-4" /> Add
                  </button>
                )}
              </div>
            )}

            {showAddRecipient && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm mb-4 overflow-hidden">
                {/* Basic info */}
                <div className="px-5 pt-5 pb-4 border-b border-slate-100">
                  <p className="text-sm font-semibold text-slate-700 mb-3">New Care Recipient</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input className={inputCls} placeholder="First name *" value={newRecipient.firstName} onChange={e => setNewRecipient(p => ({ ...p, firstName: e.target.value }))} />
                    <input className={inputCls} placeholder="Last name" value={newRecipient.lastName} onChange={e => setNewRecipient(p => ({ ...p, lastName: e.target.value }))} />
                    <select
                      className={`${inputCls} ${!newRecipient.relationship ? 'text-slate-400' : 'text-slate-700'}`}
                      value={newRecipient.relationship}
                      onChange={e => {
                        const rel = e.target.value;
                        if (rel === 'Myself') {
                          const dn = currentUser?.displayName || '';
                          const parts = dn.trim().split(/\s+/);
                          setNewRecipient(p => ({ ...p, relationship: rel, firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' }));
                        } else {
                          setNewRecipient(p => ({ ...p, relationship: rel }));
                        }
                      }}>
                      <option value="" disabled>Relationship *</option>
                      {!recipients.some(r => r.relationship?.toLowerCase() === 'myself') && <option value="Myself">Myself</option>}
                      <option value="Parent">Parent</option>
                      <option value="Spouse or Partner">Spouse or Partner</option>
                      <option value="Other">Other</option>
                    </select>
                    <input className={inputCls} placeholder="Age (optional)" value={newRecipient.age} onChange={e => setNewRecipient(p => ({ ...p, age: e.target.value.replace(/\D/g, '').slice(0, 3) }))} />
                  </div>
                </div>

                {/* Care Needs */}
                <div className="px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2 mb-3">
                    <ClipboardList className="w-4 h-4 text-primary-500" />
                    <p className="text-sm font-semibold text-slate-700">Care Needs & Tasks</p>
                  </div>
                  <div className="space-y-2">
                    {CARE_TYPES.map(need => {
                      const selected = newDraft.careNeeds.includes(need);
                      const subs = CARE_NEED_SUBS[need] || [];
                      const selectedSubs = newDraft.careNeedDetails?.[need] || [];
                      return (
                        <div key={need} className={`rounded-xl overflow-hidden transition-all ${selected ? 'border-2 border-primary-300' : 'border border-slate-200 hover:border-slate-300'}`}>
                          <button type="button"
                            onClick={() => {
                              const newNeeds = toggleArr(newDraft.careNeeds, need);
                              const newDetails = { ...newDraft.careNeedDetails };
                              if (!newNeeds.includes(need)) delete newDetails[need];
                              setNewDraft(p => ({ ...p, careNeeds: newNeeds, careNeedDetails: newDetails }));
                            }}
                            className="w-full px-4 py-3 text-left transition-colors"
                            style={selected ? { backgroundColor: '#dbeafe' } : undefined}>
                            <span className={`text-sm font-bold ${selected ? 'text-primary-700' : 'text-slate-500'}`}>{need}</span>
                          </button>
                          {selected && subs.length > 0 && (
                            <div className="px-4 py-3 flex flex-wrap gap-2" style={{ backgroundColor: '#f5f9ff' }}>
                              {subs.map(sub => {
                                const subSel = selectedSubs.includes(sub);
                                return (
                                  <button key={sub} type="button"
                                    onClick={() => setNewDraft(p => ({ ...p, careNeedDetails: { ...p.careNeedDetails, [need]: toggleArr(selectedSubs, sub) } }))}
                                    className="px-3 py-1 rounded-full border text-xs font-medium transition-all flex items-center gap-1"
                                    style={subSel ? { backgroundColor: '#dbeafe', borderColor: '#93c5fd', color: '#1d4ed8' } : { backgroundColor: '#ffffff', borderColor: '#e2e8f0', color: '#64748b' }}>
                                    {subSel && <Check size={10} className="flex-shrink-0" />}{sub}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Care Location */}
                <div className="px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2 mb-3">
                    <MapPin className="w-4 h-4 text-primary-500" />
                    <p className="text-sm font-semibold text-slate-700">Care Location</p>
                  </div>
                  {effectivePool.length > 0 && (
                    <div className="space-y-2 mb-2">
                      {effectivePool.map((wl, i) => {
                        const sel = newDraft.locations[0]?.street === wl.street && newDraft.locations[0]?.zipCode === wl.zipCode;

                        if (newLocConfirmDeleteIdx === i) {
                          return (
                            <div key={i} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2.5">
                              <p className="text-sm font-semibold text-red-700">Remove <span className="font-bold">"{locLabel(wl)}"</span>?</p>
                              <div className="flex gap-2 shrink-0">
                                <button type="button" onClick={() => deleteNewLoc(i)} className="text-xs bg-red-600 hover:bg-red-700 text-white font-semibold px-3 py-1.5 rounded-lg">Yes, remove</button>
                                <button type="button" onClick={() => setNewLocConfirmDeleteIdx(null)} className="text-xs bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg hover:bg-slate-50">Cancel</button>
                              </div>
                            </div>
                          );
                        }

                        if (newLocEditIdx === i && newLocEditDraft) {
                          return (
                            <div key={i} className="p-3 rounded-xl border-2 border-primary-300 bg-white">
                              <div className="grid grid-cols-2 gap-2 mb-2">
                                <input className={`col-span-2 ${inputCls}`} placeholder="Street address *" value={newLocEditDraft.street} onChange={e => setNewLocEditDraft(p => p ? { ...p, street: e.target.value } : p)} />
                                <input className={`col-span-2 ${inputCls}`} placeholder="Zip code" value={newLocEditDraft.zipCode}
                                  onChange={async e => {
                                    const zip = e.target.value.replace(/\D/g, '').slice(0, 5);
                                    setNewLocEditDraft(p => p ? { ...p, zipCode: zip } : p);
                                    if (zip.length === 5) {
                                      const result = await lookupZip(zip);
                                      if (result) setNewLocEditDraft(p => p ? { ...p, city: result.city, state: result.state } : p);
                                    }
                                  }} />
                                <input className={inputCls} placeholder="City" value={newLocEditDraft.city} onChange={e => setNewLocEditDraft(p => p ? { ...p, city: e.target.value } : p)} />
                                <input className={inputCls} placeholder="State" value={newLocEditDraft.state} onChange={e => setNewLocEditDraft(p => p ? { ...p, state: e.target.value } : p)} />
                              </div>
                              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
                                <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-medium transition-all ${newLocEditDraft.petsInHome ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                  <input type="checkbox" checked={!!newLocEditDraft.petsInHome} onChange={e => setNewLocEditDraft(p => p ? { ...p, petsInHome: e.target.checked } : p)} className="w-3.5 h-3.5 accent-primary-600" />
                                  Pets in the home
                                </label>
                                <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-medium transition-all ${newLocEditDraft.smokingHousehold ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                  <input type="checkbox" checked={!!newLocEditDraft.smokingHousehold} onChange={e => setNewLocEditDraft(p => p ? { ...p, smokingHousehold: e.target.checked } : p)} className="w-3.5 h-3.5 accent-primary-600" />
                                  Smoking household
                                </label>
                              </div>
                              <div className="flex gap-2">
                                <button type="button" onClick={saveNewLoc} className="text-xs bg-primary-600 hover:bg-primary-700 text-white font-semibold px-3 py-1.5 rounded-lg">Save</button>
                                <button type="button" onClick={() => { setNewLocEditIdx(null); setNewLocEditDraft(null); }} className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg">Cancel</button>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div key={i} className={`flex items-center gap-1 rounded-xl border-2 text-sm transition-all ${sel ? 'bg-primary-50 border-primary-500' : 'bg-white border-slate-200'}`}>
                            <button type="button" onClick={() => { setNewDraft(p => ({ ...p, locations: sel ? [] : [wl] })); setNewCustomLoc(false); }}
                              className="flex-1 flex items-center justify-between px-3 py-2.5 gap-2 text-left">
                              <span className={sel ? 'text-primary-700' : 'text-slate-600'}>{locLabel(wl)}</span>
                              {sel && <Check size={14} className="flex-shrink-0 text-primary-600" />}
                            </button>
                            <button type="button" onClick={() => { setNewLocEditIdx(i); setNewLocEditDraft({ ...wl }); setNewLocConfirmDeleteIdx(null); }}
                              className="p-2 text-slate-400 hover:text-primary-600 transition-colors"><Pencil size={13} /></button>
                            <button type="button" onClick={() => { setNewLocConfirmDeleteIdx(i); setNewLocEditIdx(null); setNewLocEditDraft(null); }}
                              className="p-2 pr-3 text-slate-400 hover:text-red-500 transition-colors"><Trash2 size={13} /></button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!newCustomLoc ? (
                    <button type="button" onClick={() => { setNewCustomLoc(true); setNewDraft(p => ({ ...p, locations: [] })); setNewLocEditIdx(null); setNewLocEditDraft(null); setNewLocConfirmDeleteIdx(null); }}
                      className="text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1 mt-1">
                      <Plus className="w-4 h-4" /> Use a different address
                    </button>
                  ) : (
                    <div className="p-3 rounded-xl border border-slate-200 bg-white mt-1">
                      <div className="grid grid-cols-2 gap-2">
                        <input className={`col-span-2 ${inputCls}`} placeholder="Street address *" value={newDraft.locations[0]?.street || ''}
                          onChange={e => setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), street: e.target.value }] }))} />
                        <input className={`col-span-2 ${inputCls}`} placeholder="Zip code"
                          value={newDraft.locations[0]?.zipCode || ''}
                          onChange={async e => {
                            const zip = e.target.value.replace(/\D/g, '').slice(0, 5);
                            setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), zipCode: zip }] }));
                            if (zip.length === 5) {
                              const result = await lookupZip(zip);
                              if (result) setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), city: result.city, state: result.state }] }));
                            }
                          }} />
                        <input className={inputCls} placeholder="City" value={newDraft.locations[0]?.city || ''}
                          onChange={e => setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), city: e.target.value }] }))} />
                        <input className={inputCls} placeholder="State" value={newDraft.locations[0]?.state || ''}
                          onChange={e => setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), state: e.target.value }] }))} />
                      </div>
                      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
                        <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-medium transition-all ${newDraft.locations[0]?.petsInHome ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                          <input type="checkbox" checked={!!newDraft.locations[0]?.petsInHome} onChange={e => setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), petsInHome: e.target.checked }] }))} className="w-3.5 h-3.5 accent-primary-600" />
                          Pets in the home
                        </label>
                        <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-medium transition-all ${newDraft.locations[0]?.smokingHousehold ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                          <input type="checkbox" checked={!!newDraft.locations[0]?.smokingHousehold} onChange={e => setNewDraft(p => ({ ...p, locations: [{ ...(p.locations[0] || emptyLocation()), smokingHousehold: e.target.checked }] }))} className="w-3.5 h-3.5 accent-primary-600" />
                          Smoking household
                        </label>
                      </div>
                      <button type="button" onClick={() => { setNewCustomLoc(false); setNewDraft(p => ({ ...p, locations: [] })); }}
                        className="text-xs text-slate-400 hover:text-slate-600 mt-2">Clear</button>
                    </div>
                  )}
                </div>

                {/* Notes */}
                <div className="px-5 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2 mb-3">
                    <StickyNote className="w-4 h-4 text-amber-500" />
                    <p className="text-sm font-semibold text-slate-700">Notes</p>
                  </div>
                  <textarea rows={3} className={`w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-primary-400 resize-none`}
                    placeholder="Any specific care instructions or notes…"
                    value={newDraft.notes}
                    onChange={e => setNewDraft(p => ({ ...p, notes: e.target.value }))} />
                </div>

                {/* Actions */}
                <div className="px-5 py-4 flex gap-2">
                  <button onClick={saveNewRecipient} disabled={savingRecipient}
                    className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-5 py-2 rounded-lg disabled:opacity-60 transition-colors">
                    {savingRecipient && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save Recipient
                  </button>
                  <button onClick={() => {
                    setShowAddRecipient(false);
                    setNewRecipient({ firstName: '', lastName: '', relationship: '', age: '' });
                    setNewDraft({ careNeeds: [], careNeedDetails: {}, locations: [], notes: '', lifestyle: emptyLifestyle(), tasks: emptyTasks() });
                    setNewCustomLoc(false);
                  setNewLocEditIdx(null); setNewLocEditDraft(null); setNewLocConfirmDeleteIdx(null);
                  }} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-2 rounded-lg font-medium">Cancel</button>
                </div>
              </div>
            )}

            {!showAddRecipient && recipient && rPlan && (
              <>
                {confirmDeleteRecipient && (
                  <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-red-700">Remove <span className="font-bold">{recipient.name}</span> from the care plan?</p>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={deleteRecipient} className="bg-red-600 hover:bg-red-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors">Yes, remove</button>
                      <button onClick={() => setConfirmDeleteRecipient(false)} className="bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors">No, keep</button>
                    </div>
                  </div>
                )}

                {/* Care details card */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm mb-4 overflow-hidden">

                  {/* ── Care Needs & Tasks ── */}
                  <div className={`px-5 py-5 border-b border-slate-100 ${editingSection === 'careNeeds' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'careNeeds' && draft ? (
                      <>
                        <div className="flex items-center gap-2 mb-4">
                          <ClipboardList className="w-4 h-4 text-primary-500" />
                          <p className="text-sm font-semibold text-slate-700">Care Needs & Tasks</p>
                        </div>
                        <div className="space-y-2 mb-4">
                          {CARE_TYPES.map(need => {
                            const selected = draft.careNeeds.includes(need);
                            const subs = CARE_NEED_SUBS[need] || [];
                            const selectedSubs = draft.careNeedDetails?.[need] || [];
                            return (
                              <div key={need} className={`rounded-xl overflow-hidden transition-all ${selected ? 'border-2 border-primary-300' : 'border border-slate-200 hover:border-slate-300'}`}>
                                <button type="button"
                                  onClick={() => {
                                    const newNeeds = toggleArr(draft.careNeeds, need);
                                    const newDetails = { ...draft.careNeedDetails };
                                    if (!newNeeds.includes(need)) delete newDetails[need];
                                    setDraftPlan(prev => prev ? { ...prev, careNeeds: newNeeds, careNeedDetails: newDetails } : prev);
                                  }}
                                  className="w-full px-4 py-3 text-left transition-colors"
                                  style={selected ? { backgroundColor: '#dbeafe' } : undefined}>
                                  <span className={`text-sm font-bold ${selected ? 'text-primary-700' : 'text-slate-500'}`}>{need}</span>
                                </button>
                                {selected && subs.length > 0 && (
                                  <div className="px-4 py-3 flex flex-wrap gap-2" style={{ backgroundColor: '#f5f9ff' }}>
                                    {subs.map(sub => {
                                      const subSelected = selectedSubs.includes(sub);
                                      return (
                                        <button key={sub} type="button"
                                          onClick={() => setDraftPlan(prev => prev ? {
                                            ...prev,
                                            careNeedDetails: { ...prev.careNeedDetails, [need]: toggleArr(selectedSubs, sub) }
                                          } : prev)}
                                          className="px-3 py-1 rounded-full border text-xs font-medium transition-all flex items-center gap-1"
                                          style={subSelected
                                            ? { backgroundColor: '#dbeafe', borderColor: '#93c5fd', color: '#1d4ed8' }
                                            : { backgroundColor: '#ffffff', borderColor: '#e2e8f0', color: '#64748b' }
                                          }>
                                          {subSelected && <Check size={10} className="flex-shrink-0" />}
                                          {sub}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <SaveBar onSave={saveSection} onCancel={cancelEdit} saving={savingSection} />
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
                            <ClipboardList className="w-4 h-4 text-blue-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Care Needs & Tasks</p>
                            {rPlan.careNeeds.length > 0 ? (
                              <div className="space-y-2">
                                {rPlan.careNeeds.map(need => {
                                  const subs = rPlan.careNeedDetails?.[need] || [];
                                  return (
                                    <div key={need} className="rounded-xl border-2 border-primary-300 overflow-hidden">
                                      <div className="px-4 py-3" style={{ backgroundColor: '#dbeafe' }}>
                                        <p className="text-sm font-bold text-primary-700">{displayName(need)}</p>
                                      </div>
                                      {subs.length > 0 && (
                                        <div className="px-4 py-3 flex flex-wrap gap-2" style={{ backgroundColor: '#f5f9ff' }}>
                                          {subs.map(sub => (
                                            <span key={sub} className="px-3 py-1 rounded-full border border-slate-200 bg-white text-xs font-medium text-slate-600">{sub}</span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : <p className="text-sm text-slate-400 italic">No care needs specified</p>}
                          </div>
                        </div>
                        {!isReadOnly && (
                          <button onClick={() => startEdit('careNeeds')} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-primary-600 hover:bg-primary-50 transition-colors shrink-0">
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Care Location ── */}
                  <div className={`px-5 py-5 border-b border-slate-100 ${editingSection === 'locations' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'locations' && draft ? (() => {
                      const selPoolIdx = draftLocPool.findIndex(wl =>
                        draft.locations[0]?.street === wl.street && draft.locations[0]?.city === wl.city && draft.locations[0]?.zipCode === wl.zipCode
                      );
                      const hasCustom = draft.locations.length > 0 && selPoolIdx === -1;
                      const customLoc = hasCustom ? draft.locations[0] : emptyLocation();
                      return (
                        <>
                          <div className="flex items-center gap-2 mb-4">
                            <MapPin className="w-4 h-4 text-primary-500" />
                            <p className="text-sm font-semibold text-slate-700">Care Location</p>
                          </div>
                          {draftLocPool.length > 0 && (
                            <div className="mb-3">
                              <p className="text-xs text-slate-500 mb-2">Select a saved location</p>
                              <div className="space-y-2">
                                {draftLocPool.map((wl, i) => {
                                  const selected = selPoolIdx === i;
                                  if (editingPoolIdx === i && editingPoolDraft) {
                                    return (
                                      <div key={i} className="p-3 rounded-xl border-2 border-primary-300 bg-white">
                                        <div className="grid grid-cols-2 gap-2 mb-2">
                                          <input className={`col-span-2 ${inputCls}`} placeholder="Street address" value={editingPoolDraft.street} onChange={e => setEditingPoolDraft(p => p ? { ...p, street: e.target.value } : p)} />
                                          <input className={`col-span-2 ${inputCls}`} placeholder="Zip code" value={editingPoolDraft.zipCode}
                                            onChange={async e => {
                                              const zip = e.target.value.replace(/\D/g, '').slice(0, 5);
                                              setEditingPoolDraft(p => p ? { ...p, zipCode: zip } : p);
                                              if (zip.length === 5) {
                                                const result = await lookupZip(zip);
                                                if (result) setEditingPoolDraft(p => p ? { ...p, city: result.city, state: result.state } : p);
                                              }
                                            }} />
                                          <input className={inputCls} placeholder="City" value={editingPoolDraft.city} onChange={e => setEditingPoolDraft(p => p ? { ...p, city: e.target.value } : p)} />
                                          <input className={inputCls} placeholder="State" value={editingPoolDraft.state} onChange={e => setEditingPoolDraft(p => p ? { ...p, state: e.target.value } : p)} />
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 mb-2 pt-2 border-t border-slate-100">
                                          <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs font-medium ${editingPoolDraft.petsInHome ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                            <input type="checkbox" checked={!!editingPoolDraft.petsInHome} onChange={e => setEditingPoolDraft(p => p ? { ...p, petsInHome: e.target.checked, petTypes: e.target.checked ? p.petTypes : [], petName: e.target.checked ? p.petName : '' } : p)} className="w-3.5 h-3.5 accent-primary-600" />
                                            Pets in the home
                                          </label>
                                          <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs font-medium ${editingPoolDraft.smokingHousehold ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                            <input type="checkbox" checked={!!editingPoolDraft.smokingHousehold} onChange={e => setEditingPoolDraft(p => p ? { ...p, smokingHousehold: e.target.checked } : p)} className="w-3.5 h-3.5 accent-primary-600" />
                                            Smoking household
                                          </label>
                                          {editingPoolDraft.petsInHome && (
                                            <div className="col-span-2 flex flex-wrap gap-1.5">
                                              {PET_TYPES.map(t => (
                                                <CheckPill key={t} label={t} selected={(editingPoolDraft.petTypes || []).includes(t)}
                                                  onClick={() => setEditingPoolDraft(p => p ? { ...p, petTypes: toggleArr(p.petTypes || [], t) } : p)} />
                                              ))}
                                              <input className={`w-full mt-1 ${inputCls}`} placeholder="Pet name (optional)" value={editingPoolDraft.petName || ''} onChange={e => setEditingPoolDraft(p => p ? { ...p, petName: e.target.value } : p)} />
                                            </div>
                                          )}
                                        </div>
                                        <div className="flex gap-2">
                                          <button onClick={() => {
                                            if (!editingPoolDraft!.street.trim()) {
                                              onShowToast('Please enter a street address', 'error'); return;
                                            }
                                            const newPool = [...draftLocPool]; newPool[i] = editingPoolDraft!;
                                            setDraftLocPool(newPool);
                                            if (selected) setDraftPlan(prev => prev ? { ...prev, locations: [editingPoolDraft!] } : prev);
                                            setEditingPoolIdx(null); setEditingPoolDraft(null);
                                          }} className="text-xs bg-primary-600 hover:bg-primary-700 text-white font-semibold px-3 py-1 rounded-lg">Save</button>
                                          <button onClick={() => {
                                            if (!wl.street && !wl.city) setDraftLocPool(prev => prev.filter((_, idx) => idx !== i));
                                            setEditingPoolIdx(null); setEditingPoolDraft(null);
                                          }} className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1 rounded-lg">Cancel</button>
                                        </div>
                                      </div>
                                    );
                                  }
                                  if (confirmDeletePoolIdx === i) {
                                    return (
                                      <div key={i} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border-2 border-red-200 bg-red-50 px-3 py-2.5">
                                        <p className="text-sm font-semibold text-red-700">Remove <span className="font-bold">"{locLabel(wl)}"</span>?</p>
                                        <div className="flex gap-2 shrink-0">
                                          <button type="button" onClick={() => { setDraftLocPool(prev => prev.filter((_, idx) => idx !== i)); if (selected) setDraftPlan(prev => prev ? { ...prev, locations: [] } : prev); setConfirmDeletePoolIdx(null); }}
                                            className="text-xs bg-red-600 hover:bg-red-700 text-white font-semibold px-3 py-1.5 rounded-lg">Yes, remove</button>
                                          <button type="button" onClick={() => setConfirmDeletePoolIdx(null)} className="text-xs bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg hover:bg-slate-50">Cancel</button>
                                        </div>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div key={i} className={`flex items-center gap-1 rounded-xl border-2 text-sm transition-all ${selected ? 'bg-primary-50 border-primary-500' : 'bg-white border-slate-200'}`}>
                                      <button type="button" onClick={() => setDraftPlan(prev => prev ? { ...prev, locations: selected ? [] : [wl] } : prev)}
                                        className="flex-1 flex items-center justify-between px-3 py-2.5 gap-2 text-left">
                                        <span className={selected ? 'text-primary-700' : 'text-slate-600'}>{locLabel(wl) || 'New address'}</span>
                                        {selected && <Check size={14} className="flex-shrink-0 text-primary-600" />}
                                      </button>
                                      <button type="button" onClick={() => { setEditingPoolIdx(i); setEditingPoolDraft({ ...wl }); setConfirmDeletePoolIdx(null); }}
                                        className="p-2 text-slate-400 hover:text-primary-600 transition-colors"><Pencil size={13} /></button>
                                      <button type="button" onClick={() => { setConfirmDeletePoolIdx(i); setEditingPoolIdx(null); setEditingPoolDraft(null); }}
                                        className="p-2 pr-3 text-slate-400 hover:text-red-500 transition-colors"><X size={13} /></button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          {hasCustom && (
                            customLoc.street && !editingCustomLoc ? (
                              <div className="flex items-center gap-1 rounded-xl border-2 bg-primary-50 border-primary-500 text-sm mb-2">
                                <div className="flex-1 flex items-center gap-2 px-3 py-2.5">
                                  <div className="flex-1">
                                    <p className="text-xs text-primary-500 font-medium mb-0.5">Current address</p>
                                    <span className="text-primary-700">{locLabel(customLoc)}</span>
                                  </div>
                                  <Check size={14} className="flex-shrink-0 text-primary-600" />
                                </div>
                                <button type="button" onClick={() => setEditingCustomLoc(true)} className="p-2 text-slate-400 hover:text-primary-600 transition-colors"><Pencil size={13} /></button>
                                <button type="button" onClick={() => setDraftPlan(prev => prev ? { ...prev, locations: [] } : prev)} className="p-2 pr-3 text-slate-400 hover:text-red-500 transition-colors"><X size={13} /></button>
                              </div>
                            ) : (
                              <div className="p-3 rounded-xl border-2 border-primary-300 bg-white mb-2">
                                <div className="grid grid-cols-2 gap-2 mb-2">
                                  <input className={`col-span-2 ${inputCls}`} placeholder="Street address *" value={customLoc.street} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), street: e.target.value }] } : prev)} />
                                  <input className={`col-span-2 ${inputCls}`} placeholder="Zip code" value={customLoc.zipCode}
                                    onChange={async e => {
                                      const zip = e.target.value.replace(/\D/g, '').slice(0, 5);
                                      setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), zipCode: zip }] } : prev);
                                      if (zip.length === 5) {
                                        const result = await lookupZip(zip);
                                        if (result) setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), city: result.city, state: result.state }] } : prev);
                                      }
                                    }} />
                                  <input className={inputCls} placeholder="City" value={customLoc.city} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), city: e.target.value }] } : prev)} />
                                  <input className={inputCls} placeholder="State" value={customLoc.state} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), state: e.target.value }] } : prev)} />
                                </div>
                                <div className="grid grid-cols-2 gap-2 mt-1 pt-2 border-t border-slate-100">
                                  <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-medium transition-all ${customLoc.petsInHome ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                    <input type="checkbox" checked={!!customLoc.petsInHome} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), petsInHome: e.target.checked }] } : prev)} className="w-3.5 h-3.5 accent-primary-600" />
                                    Pets in the home
                                  </label>
                                  <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs font-medium transition-all ${customLoc.smokingHousehold ? 'border-primary-400 bg-primary-50 text-primary-700' : 'border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                    <input type="checkbox" checked={!!customLoc.smokingHousehold} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...(prev.locations[0] || emptyLocation()), smokingHousehold: e.target.checked }] } : prev)} className="w-3.5 h-3.5 accent-primary-600" />
                                    Smoking household
                                  </label>
                                </div>
                                <div className="flex gap-2">
                                  {editingCustomLoc && (
                                    <button type="button" onClick={() => {
                                      if (!customLoc.street.trim()) { onShowToast('Street address is required', 'error'); return; }
                                      setEditingCustomLoc(false);
                                    }} className="text-xs bg-primary-600 hover:bg-primary-700 text-white font-semibold px-3 py-1.5 rounded-lg">Save</button>
                                  )}
                                  <button type="button" onClick={() => {
                                    if (editingCustomLoc && customLoc.street) {
                                      setEditingCustomLoc(false);
                                    } else {
                                      setDraftPlan(prev => prev ? { ...prev, locations: [] } : prev);
                                    }
                                  }} className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg">Cancel</button>
                                </div>
                              </div>
                            )
                          )}
                          {!hasCustom && draftLocPool.length < 4 && editingPoolIdx === null && (
                            <button onClick={() => {
                              const newIdx = draftLocPool.length;
                              setDraftLocPool(prev => [...prev, emptyLocation()]);
                              setEditingPoolIdx(newIdx);
                              setEditingPoolDraft(emptyLocation());
                            }} className="text-sm text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1 mt-1">
                              <Plus className="w-4 h-4" /> Add a different address
                            </button>
                          )}
                          <SaveBar onSave={saveSection} onCancel={cancelEdit} saving={savingSection} />
                        </>
                      );
                    })() : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center shrink-0 mt-0.5">
                            <MapPin className="w-4 h-4 text-emerald-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Care Location</p>
                            {rPlan.locations.filter(l => l.street || l.city).length > 0 ? (
                              <div className="space-y-2.5">
                                {rPlan.locations.filter(l => l.street || l.city).map((loc, i) => {
                                  const poolEntry = effectivePool.find(p =>
                                    p.street?.toLowerCase() === loc.street?.toLowerCase() && p.zipCode === loc.zipCode
                                  );
                                  const enriched = { ...loc, ...(poolEntry || {}) };
                                  return (
                                    <div key={i}>
                                      {enriched.street && <p className="text-sm font-medium text-slate-800">{enriched.street}</p>}
                                      <p className="text-sm text-slate-500">{[enriched.city, [enriched.state, enriched.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</p>
                                      {(enriched.petsInHome || enriched.smokingHousehold) && (
                                        <div className="flex flex-wrap gap-1.5 mt-1">
                                          {enriched.petsInHome && (
                                            <span className="text-xs px-2.5 py-1 rounded-full border bg-amber-50 border-amber-100 text-amber-700 font-medium">
                                              {enriched.petTypes?.length ? enriched.petTypes.join(', ') : 'Pets in home'}{enriched.petName ? ` · ${enriched.petName}` : ''}
                                            </span>
                                          )}
                                          {enriched.smokingHousehold && (
                                            <span className="text-xs px-2.5 py-1 rounded-full border bg-slate-100 border-slate-200 text-slate-600 font-medium">Smoking household</span>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : <p className="text-sm text-slate-400 italic">No location assigned</p>}
                          </div>
                        </div>
                        {!isReadOnly && (
                          <button onClick={() => startEdit('locations')} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-primary-600 hover:bg-primary-50 transition-colors shrink-0">
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Notes ── */}
                  <div className={`px-5 py-5 border-b border-slate-100 ${editingSection === 'notes' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'notes' && draft ? (
                      <>
                        <div className="flex items-center gap-2 mb-3">
                          <StickyNote className="w-4 h-4 text-primary-500" />
                          <p className="text-sm font-semibold text-slate-700">Notes</p>
                        </div>
                        <textarea rows={4} className={`w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-primary-400 resize-none mb-1 ${inputCls}`}
                          placeholder="Add notes specific to this care recipient…" value={draft.notes}
                          onChange={e => setDraftPlan(prev => prev ? { ...prev, notes: e.target.value } : prev)} />
                        <SaveBar onSave={saveSection} onCancel={cancelEdit} saving={savingSection} />
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center shrink-0 mt-0.5">
                            <StickyNote className="w-4 h-4 text-amber-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Notes</p>
                            {rPlan.notes
                              ? <p className="text-sm text-slate-700 whitespace-pre-wrap break-words leading-relaxed">{rPlan.notes}</p>
                              : <p className="text-sm text-slate-400 italic">No notes added yet</p>}
                          </div>
                        </div>
                        {!isReadOnly && (
                          <button onClick={() => startEdit('notes')} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-primary-600 hover:bg-primary-50 transition-colors shrink-0">
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Lifestyle & Preferences ── */}
                  <div className={`px-5 py-5 border-b border-slate-100 ${editingSection === 'lifestyle' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'lifestyle' && draft ? (
                      <>
                        <div className="flex items-center gap-2 mb-5">
                          <Heart className="w-4 h-4 text-rose-500" />
                          <p className="text-sm font-semibold text-slate-700">Lifestyle & Preferences</p>
                        </div>
                        <div className="space-y-6">

                          <SubSec title="Favorite Activities">
                            <div className="flex flex-wrap gap-2">
                              {FAV_ACTIVITIES.map(a => (
                                <CheckPill key={a} label={a} selected={draft.lifestyle.favoriteActivities.includes(a)}
                                  onClick={() => setLS({ favoriteActivities: toggleArr(draft.lifestyle.favoriteActivities, a) })} />
                              ))}
                            </div>
                            {draft.lifestyle.favoriteActivities.includes('Other') && (
                              <input className={`mt-2 ${inputCls}`} placeholder="Describe other activity"
                                value={draft.lifestyle.favoriteActivitiesOther}
                                onChange={e => setLS({ favoriteActivitiesOther: e.target.value })} />
                            )}
                          </SubSec>

                          <SubSec title="Entertainment">
                            <div className="flex flex-wrap gap-2">
                              {ENTERTAINMENT.map(a => (
                                <CheckPill key={a} label={a} selected={draft.lifestyle.entertainment.includes(a)}
                                  onClick={() => setLS({ entertainment: toggleArr(draft.lifestyle.entertainment, a) })} />
                              ))}
                            </div>
                            {draft.lifestyle.entertainment.includes('Other') && (
                              <input className={`mt-2 ${inputCls}`} placeholder="Describe other preference"
                                value={draft.lifestyle.entertainmentOther}
                                onChange={e => setLS({ entertainmentOther: e.target.value })} />
                            )}
                          </SubSec>

                          <div className="space-y-2.5">
                            <YesNo label="Enjoys Conversation" value={draft.lifestyle.enjoysConversation} onChange={v => setLS({ enjoysConversation: v })} />
                            <YesNo label="Prefers Quiet" value={draft.lifestyle.prefersQuiet} onChange={v => setLS({ prefersQuiet: v })} />
                          </div>

                          <SubSec title="Family in Area">
                            <YesNo value={draft.lifestyle.familyInArea}
                              onChange={v => setLS({ familyInArea: v, familyVisitFreq: v ? draft.lifestyle.familyVisitFreq : '' })} />
                            {draft.lifestyle.familyInArea && (
                              <div className="mt-3">
                                <p className="text-xs text-slate-500 mb-2">Family Visit Frequency</p>
                                <div className="flex flex-wrap gap-2">
                                  {FREQ_OPTIONS.map(f => (
                                    <CheckPill key={f} label={f} selected={draft.lifestyle.familyVisitFreq === f}
                                      onClick={() => setLS({ familyVisitFreq: draft.lifestyle.familyVisitFreq === f ? '' : f })} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </SubSec>

                          <SubSec title="Friends or Visitors">
                            <YesNo value={draft.lifestyle.friendsVisitors}
                              onChange={v => setLS({ friendsVisitors: v, friendsVisitFreq: v ? draft.lifestyle.friendsVisitFreq : '' })} />
                            {draft.lifestyle.friendsVisitors && (
                              <div className="mt-3">
                                <p className="text-xs text-slate-500 mb-2">Friends Visit Frequency</p>
                                <div className="flex flex-wrap gap-2">
                                  {FREQ_OPTIONS.map(f => (
                                    <CheckPill key={f} label={f} selected={draft.lifestyle.friendsVisitFreq === f}
                                      onClick={() => setLS({ friendsVisitFreq: draft.lifestyle.friendsVisitFreq === f ? '' : f })} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </SubSec>

                          <SubSec title="Schedule / Appointments">
                            <YesNo value={draft.lifestyle.hasAppointments}
                              onChange={v => setLS({ hasAppointments: v, appointmentsDetails: v ? draft.lifestyle.appointmentsDetails : '' })} />
                            {draft.lifestyle.hasAppointments && (
                              <textarea rows={3} className={`mt-2 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-primary-400 resize-none`}
                                placeholder="e.g. Doctor every Tuesday, church on Sundays"
                                value={draft.lifestyle.appointmentsDetails}
                                onChange={e => setLS({ appointmentsDetails: e.target.value })} />
                            )}
                          </SubSec>

                        </div>
                        <SaveBar onSave={saveSection} onCancel={cancelEdit} saving={savingSection} />
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-xl bg-rose-50 flex items-center justify-center shrink-0 mt-0.5">
                            <Heart className="w-4 h-4 text-rose-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Lifestyle & Preferences</p>
                            {hasLifestyle(rPlan.lifestyle) ? (
                              <div className="space-y-3">
                                <div>
                                  <ReadChips label="Favorite Activities" items={rPlan.lifestyle.favoriteActivities} color="bg-rose-50 border-rose-100 text-rose-700" />
                                  {rPlan.lifestyle.favoriteActivities.includes('Other') && rPlan.lifestyle.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-1 ml-0.5"><span className="font-medium text-slate-400">Other:</span> {rPlan.lifestyle.favoriteActivitiesOther}</p>}
                                </div>
                                <div>
                                  <ReadChips label="Needs Help With" items={rPlan.lifestyle.helpActivities} color="bg-orange-50 border-orange-100 text-orange-700" />
                                  {rPlan.lifestyle.helpActivities.includes('Other') && rPlan.lifestyle.helpActivitiesOther && <p className="text-xs text-slate-500 mt-1 ml-0.5"><span className="font-medium text-slate-400">Other:</span> {rPlan.lifestyle.helpActivitiesOther}</p>}
                                </div>
                                <div>
                                  <ReadChips label="Entertainment" items={rPlan.lifestyle.entertainment} color="bg-purple-50 border-purple-100 text-purple-700" />
                                  {rPlan.lifestyle.entertainment.includes('Other') && rPlan.lifestyle.entertainmentOther && <p className="text-xs text-slate-500 mt-1 ml-0.5"><span className="font-medium text-slate-400">Other:</span> {rPlan.lifestyle.entertainmentOther}</p>}
                                </div>
                                <div className="space-y-1">
                                  {([
                                    { label: 'Enjoys conversation', key: 'enjoysConversation' as const },
                                    { label: 'Prefers quiet', key: 'prefersQuiet' as const },
                                    { label: 'Family in area', key: 'familyInArea' as const },
                                    { label: 'Friends or visitors', key: 'friendsVisitors' as const },
                                    { label: 'Has appointments', key: 'hasAppointments' as const },
                                  ]).filter(({ key }) => rPlan.lifestyle[key] !== null && rPlan.lifestyle[key] !== undefined).map(({ label, key }) => (
                                    <React.Fragment key={key}>
                                      <div className="flex items-center justify-between text-xs">
                                        <span className="text-slate-500 font-medium">{label}</span>
                                        <span className={`px-2.5 py-0.5 rounded-full font-semibold ${rPlan.lifestyle[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{rPlan.lifestyle[key] === true ? 'Yes' : 'No'}</span>
                                      </div>
                                      {key === 'familyInArea' && rPlan.lifestyle.familyInArea === true && rPlan.lifestyle.familyVisitFreq && (
                                        <div className="flex items-center justify-between text-xs"><span className="text-slate-400">Family visit frequency</span><span className="text-slate-600 font-medium">{rPlan.lifestyle.familyVisitFreq}</span></div>
                                      )}
                                      {key === 'friendsVisitors' && rPlan.lifestyle.friendsVisitors === true && rPlan.lifestyle.friendsVisitFreq && (
                                        <div className="flex items-center justify-between text-xs"><span className="text-slate-400">Friends visit frequency</span><span className="text-slate-600 font-medium">{rPlan.lifestyle.friendsVisitFreq}</span></div>
                                      )}
                                      {key === 'hasAppointments' && rPlan.lifestyle.hasAppointments === true && rPlan.lifestyle.appointmentsDetails && (
                                        <p className="text-xs text-slate-500"><span className="font-medium text-slate-400">Details:</span> {rPlan.lifestyle.appointmentsDetails}</p>
                                      )}
                                    </React.Fragment>
                                  ))}
                                </div>
                              </div>
                            ) : <p className="text-sm text-slate-400 italic">Not specified</p>}
                          </div>
                        </div>
                        {!isReadOnly && (
                          <button onClick={() => startEdit('lifestyle')} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-primary-600 hover:bg-primary-50 transition-colors shrink-0">
                            <Pencil size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>


                </div>

              </>
            )}

            {/* Emergency Contacts */}
            {recipients.length > 0 && !showAddRecipient && <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/60">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-green-50 flex items-center justify-center">
                    <PhoneCall className="w-4 h-4 text-green-500" />
                  </div>
                  <h3 className="font-bold text-slate-900 text-sm">Emergency Contacts</h3>
                </div>
                {!isReadOnly && (plan.emergencyContacts.length + (wizardData?.emergencyFirstName ? 1 : 0)) < 2 && (
                  <button onClick={addContact} className="flex items-center gap-1 text-sm font-semibold text-primary-600 hover:text-primary-700 bg-primary-50 hover:bg-primary-100 px-3 py-1.5 rounded-lg transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Add
                  </button>
                )}
              </div>

              {wizardData?.emergencyFirstName && (
                <div className={`px-5 py-4 border-b border-slate-100 ${editingSetupContact ? 'bg-slate-50' : ''}`}>
                  {editingSetupContact ? (
                    <>
                      <div className="space-y-2 mb-3">
                        <div className="grid grid-cols-2 gap-2">
                          <input className={inputCls} placeholder="First name" value={setupDraft.firstName} onChange={e => setSetupDraft(p => ({ ...p, firstName: e.target.value }))} />
                          <input className={inputCls} placeholder="Last name" value={setupDraft.lastName} onChange={e => setSetupDraft(p => ({ ...p, lastName: e.target.value }))} />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input className={inputCls} placeholder="Relationship" value={setupDraft.relationship} onChange={e => setSetupDraft(p => ({ ...p, relationship: e.target.value }))} />
                          <input type="tel" className={inputCls} placeholder="Phone number" value={setupDraft.phone} onChange={e => setSetupDraft(p => ({ ...p, phone: e.target.value.replace(/[^\d+\-() ]/g, '').slice(0, 16) }))} />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={saveSetupContact} disabled={savingSetup} className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
                          {savingSetup && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                        </button>
                        <button onClick={() => setEditingSetupContact(false)} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg font-medium">Cancel</button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
                        {initials(`${wizardData.emergencyFirstName} ${wizardData.emergencyLastName || ''}`) || <User className="w-4 h-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-800">
                          {wizardData.emergencyFirstName}{wizardData.emergencyLastName ? ` ${wizardData.emergencyLastName}` : ''}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          {wizardData.emergencyRelationship && <span className="text-xs text-slate-500 capitalize">{wizardData.emergencyRelationship}</span>}
                          {wizardData.emergencyPhone && (
                            <><span className="text-slate-300">·</span><span className="text-xs text-slate-500 flex items-center gap-1"><Phone className="w-3 h-3" />{wizardData.emergencyPhone}</span></>
                          )}
                        </div>
                      </div>
                      {!isReadOnly && (
                        <button onClick={startEditSetup} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-primary-600 hover:bg-primary-50 transition-colors shrink-0">
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {plan.emergencyContacts.map((contact, idx) => (
                <div key={contact.id} className={`px-5 py-4 border-b border-slate-100 last:border-b-0 ${editingContactIdx === idx ? 'bg-slate-50' : ''}`}>
                  {editingContactIdx === idx ? (
                    <>
                      <div className="space-y-2 mb-3">
                        <div className="flex items-center gap-3">
                          <input className={`flex-grow ${inputCls}`} value={contact.name} onChange={e => updateContact(idx, 'name', e.target.value)} placeholder="Full name" />
                          <label className="flex items-center text-xs text-slate-500 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" checked={contact.isPrimary} onChange={e => updateContact(idx, 'isPrimary', e.target.checked)} className="mr-1 accent-primary-600 rounded" /> Primary
                          </label>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input className={inputCls} value={contact.relation} onChange={e => updateContact(idx, 'relation', e.target.value)} placeholder="Relation" />
                          <input type="tel" className={inputCls} value={contact.phone} onChange={e => handlePhoneInput(idx, e.target.value)} placeholder="Phone number" />
                        </div>
                      </div>
                      <div className="flex gap-2 items-center">
                        <button onClick={saveContacts} disabled={savingContacts} className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
                          {savingContacts && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                        </button>
                        <button onClick={() => setEditingContactIdx(null)} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg font-medium">Cancel</button>
                        <button onClick={() => deleteContact(idx)} className="ml-auto text-xs text-red-500 hover:text-red-700 font-medium flex items-center gap-1">
                          <Trash2 size={13} /> Remove
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-400 to-purple-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
                        {initials(contact.name) || <User className="w-4 h-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-slate-800">{contact.name || '—'}</p>
                          {contact.isPrimary && <span className="text-xs font-medium text-primary-600 bg-primary-50 px-2 py-0.5 rounded-full">Primary</span>}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          {contact.relation && <span className="text-xs text-slate-500 capitalize">{contact.relation}</span>}
                          {contact.phone && (
                            <><span className="text-slate-300">·</span><span className="text-xs text-slate-500 flex items-center gap-1"><Phone className="w-3 h-3" />{contact.phone}</span></>
                          )}
                        </div>
                      </div>
                      {!isReadOnly && (
                        <button onClick={() => setEditingContactIdx(idx)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-primary-600 hover:bg-primary-50 transition-colors shrink-0">
                          <Pencil size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {plan.emergencyContacts.length === 0 && !wizardData?.emergencyFirstName && (
                <div className="px-5 py-10 text-center">
                  <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
                    <PhoneCall className="w-5 h-5 text-slate-400" />
                  </div>
                  <p className="text-sm font-medium text-slate-500">No emergency contacts added yet.</p>
                  <p className="text-xs text-slate-400 mt-1">Add up to 2 contacts for emergencies.</p>
                </div>
              )}
            </div>}

          </>
        ) : (
          <div className="text-center py-20 bg-white rounded-2xl border border-slate-100">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <User className="w-7 h-7 text-slate-400" />
            </div>
            <p className="font-semibold text-slate-700">No care recipients yet.</p>
            <p className="text-sm text-slate-400 mt-1 mb-5">Add your first care recipient to get started.</p>
            {!isReadOnly && (
              <button onClick={() => setShowAddRecipient(true)}
                className="inline-flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-5 py-2.5 rounded-xl shadow-sm transition-colors">
                <Plus className="w-4 h-4" /> Add Care Recipient
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
