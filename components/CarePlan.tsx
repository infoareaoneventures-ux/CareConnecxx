
import React, { useState, useEffect, useMemo } from 'react';
import {
  Phone, FileText, ChevronLeft, Plus, Trash2, Loader2, User,
  Check, X, Pencil, MapPin, ClipboardList, StickyNote, PhoneCall,
  Heart,
} from 'lucide-react';
import { ViewType, AddToastFunction, CarePlan as CarePlanType } from '../types';
import { dbService, authService } from '../services/api';
import { db } from '../lib/firebase';
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

const FAV_ACTIVITIES = ['Walk', 'Reading', 'Cooking', 'Gardening', 'Watching TV', 'Socializing', 'Other'];
const HELP_ACTIVITIES = ['Going outside', 'Exercise', 'Hobbies', 'Transportation', 'Other'];
const ENTERTAINMENT = ['Music', 'Movies', 'TV Shows', 'Theater', 'Other'];
const FREQ_OPTIONS = ['Daily', 'Weekly', 'Monthly', 'Occasionally'];
const PET_TYPES = ['Dog', 'Cat', 'Fish', 'Other'];

interface LocationEntry { street: string; city: string; state: string; zipCode: string; }

interface LifestyleData {
  favoriteActivities: string[]; favoriteActivitiesOther: string;
  helpActivities: string[]; helpActivitiesOther: string;
  entertainment: string[]; entertainmentOther: string;
  enjoysConversation: boolean | null; prefersQuiet: boolean | null;
  familyInArea: boolean | null; familyVisitFreq: string;
  friendsVisitors: boolean | null; friendsVisitFreq: string;
  petsInHome: boolean | null; petTypes: string[]; petName: string;
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

interface RecipientEntry { firstName: string; lastName: string; name: string; relationship: string; age?: string; }

const getKey = (firstName: string, lastName: string) =>
  `${firstName.toLowerCase()}_${(lastName || 'noname').toLowerCase()}`.replace(/\s+/g, '_');

const emptyLocation = (): LocationEntry => ({ street: '', city: '', state: '', zipCode: '' });

const emptyLifestyle = (): LifestyleData => ({
  favoriteActivities: [], favoriteActivitiesOther: '',
  helpActivities: [], helpActivitiesOther: '',
  entertainment: [], entertainmentOther: '',
  enjoysConversation: null, prefersQuiet: null,
  familyInArea: null, familyVisitFreq: '',
  friendsVisitors: null, friendsVisitFreq: '',
  petsInHome: null, petTypes: [], petName: '',
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
  ls.friendsVisitors !== null || ls.petsInHome !== null || ls.hasAppointments !== null;


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
  const [editingRecipientInfo, setEditingRecipientInfo] = useState(false);
  const [recipientInfoDraft, setRecipientInfoDraft] = useState({ firstName: '', lastName: '', relationship: '', age: '' });
  const [savingRecipientInfo, setSavingRecipientInfo] = useState(false);

  const currentUser = authService.getCurrentUser();
  const isReadOnly = !!targetUserId && targetUserId !== currentUser?.uid;
  const currentPlanId = targetUserId || currentUser?.uid || null;

  useEffect(() => {
    if (!currentPlanId) { setLoading(false); onNavigate('client-login'); return; }
    const unsub = dbService.subscribeToCarePlan(currentPlanId, updated => { setPlan(updated); setLoading(false); });
    return () => unsub();
  }, [currentPlanId]);

  useEffect(() => {
    const load = async () => {
      if (!currentPlanId || !db) return;
      try {
        const snap = await db.collection('job_postings').doc(currentPlanId).get();
        if (snap.exists) setWizardData(snap.data());
      } catch {}
    };
    load();
  }, [currentPlanId]);

  useEffect(() => {
    if (!currentPlanId || !db) return;
    const unsub = db.collection('carePlans').doc(currentPlanId).onSnapshot(snap => {
      const data = snap.data() as any;
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
    }, () => {});
    return () => unsub();
  }, [currentPlanId]);

  const recipients = useMemo((): RecipientEntry[] => {
    if (!wizardData) return [];
    const list: RecipientEntry[] = [];
    const pFirst = wizardData.careRecipientFirstName || '';
    const pLast = wizardData.careRecipientLastName || '';
    list.push({ firstName: pFirst, lastName: pLast, name: [pFirst, pLast].filter(Boolean).join(' ') || 'Primary Recipient', relationship: wizardData.relationship || '', age: wizardData.careRecipientAge || '' });
    (wizardData.additionalRecipients || []).forEach((r: any, i: number) => {
      list.push({ firstName: r.firstName || '', lastName: r.lastName || '', name: [r.firstName, r.lastName].filter(Boolean).join(' ') || `Recipient ${i + 2}`, relationship: r.relationship || '', age: r.age || '' });
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
      return { lifestyle: emptyLifestyle(), tasks: emptyTasks(), careNeedDetails: {}, ...stored };
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
    // Strip any blank pool entries before saving
    const cleanPool = draftLocPool.filter(l => l.street.trim() || l.city.trim());
    try {
      const key = getKey(recipient.firstName, recipient.lastName);
      const updated = { ...getPlan(recipient), ...draftPlan };
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

  const handleTabChange = (i: number) => {
    setActiveRecipient(i);
    cancelEdit();
    setEditingContactIdx(null);
    setEditingSetupContact(false);
    setEditingRecipientInfo(false);
    setConfirmDeleteRecipient(false);
  };

  const addContact = () => {
    const newContacts = [...plan.emergencyContacts, { id: crypto.randomUUID(), name: '', relation: '', phone: '', isPrimary: false }];
    setPlan(prev => ({ ...prev, emergencyContacts: newContacts }));
    setEditingContactIdx(newContacts.length - 1);
  };

  const updateContact = (idx: number, field: string, value: any) => {
    if (isReadOnly) return;
    setPlan(prev => { const list = [...prev.emergencyContacts]; list[idx] = { ...list[idx], [field]: value }; return { ...prev, emergencyContacts: list }; });
  };

  const deleteContact = async (idx: number) => {
    if (isReadOnly || !currentPlanId) return;
    const updatedList = plan.emergencyContacts.filter((_, i) => i !== idx);
    const updatedPlan = { ...plan, emergencyContacts: updatedList };
    setPlan(updatedPlan);
    setEditingContactIdx(null);
    try { await dbService.updateCarePlan(currentPlanId, updatedPlan); } catch {}
  };

  const handlePhoneInput = (idx: number, value: string) => {
    updateContact(idx, 'phone', value.replace(/[^\d+\-() ]/g, '').slice(0, 16));
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
      setEditingContactIdx(null);
      onShowToast('Contact saved', 'success');
    } catch { onShowToast('Failed to save contact', 'error'); }
    finally { setSavingContacts(false); }
  };

  const saveNewLoc = async () => {
    if (newLocEditIdx === null || !newLocEditDraft || !db || !currentPlanId) return;
    if (!newLocEditDraft.street.trim()) { onShowToast('Street address is required', 'error'); return; }
    const base = locationPool.length > 0 ? [...locationPool] : [...wizardLocations];
    const newPool = base.map((l, i) => i === newLocEditIdx ? newLocEditDraft : l);
    const wasSelected = newDraft.locations[0]?.street === effectivePool[newLocEditIdx]?.street && newDraft.locations[0]?.zipCode === effectivePool[newLocEditIdx]?.zipCode;
    if (wasSelected) setNewDraft(p => ({ ...p, locations: [newLocEditDraft] }));
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
    if (!newRecipient.relationship) { onShowToast('Please select a relationship', 'error'); return; }
    const loc = newDraft.locations[0];
    if (!loc || !loc.street.trim()) { onShowToast('Please select or enter a care location with a street address', 'error'); return; }
    if (!currentPlanId || !db) return;
    setSavingRecipient(true);
    try {
      const entry = { firstName: newRecipient.firstName.trim(), lastName: newRecipient.lastName.trim(), relationship: newRecipient.relationship, age: newRecipient.age.trim() };

      await db.collection('job_postings').doc(currentPlanId).set(
        { additionalRecipients: firebase.firestore.FieldValue.arrayUnion(entry) },
        { merge: true }
      );

      // Save the plan the user filled in during add (never inherits wizard defaults)
      const key = getKey(entry.firstName, entry.lastName);
      const blankPlan: RecipientPlanData = { ...newDraft };

      // Merge new recipient's address into the shared locationPool
      const newLoc = newDraft.locations.find(l => l.street || l.city);
      const currentPool = locationPool.length > 0 ? [...locationPool] : [...wizardLocations];
      let updatedPool = currentPool;
      if (newLoc) {
        const locKey = `${newLoc.street?.toLowerCase()}${newLoc.zipCode}`;
        const alreadyInPool = currentPool.some(l => `${l.street?.toLowerCase()}${l.zipCode}` === locKey);
        if (!alreadyInPool) updatedPool = [...currentPool, newLoc];
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

      const newIndex = recipients.length; // will be the tab index after state update
      setRecipientPlans(prev => ({ ...prev, [key]: blankPlan }));
      setWizardData((prev: any) => ({ ...prev, additionalRecipients: [...(prev?.additionalRecipients || []), entry] }));
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
    if (!currentPlanId || !db || activeRecipient === 0) return;
    const r = recipients[activeRecipient];
    try {
      const updatedAdditional = (wizardData?.additionalRecipients || []).filter(
        (ar: any) => !(ar.firstName === r.firstName && ar.lastName === r.lastName)
      );
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

      await db.collection('job_postings').doc(currentPlanId).update({
        additionalRecipients: updatedAdditional,
        deletedRecipients: firebase.firestore.FieldValue.arrayUnion(archived),
      });
      setWizardData((prev: any) => ({ ...prev, additionalRecipients: updatedAdditional }));
      setActiveRecipient(Math.max(0, activeRecipient - 1));
      setConfirmDeleteRecipient(false);
      cancelEdit();
      onShowToast('Recipient removed', 'success');
    } catch { onShowToast('Failed to remove recipient', 'error'); }
  };

  const saveRecipientInfo = async () => {
    if (!recipientInfoDraft.firstName.trim()) { onShowToast('First name is required', 'error'); return; }
    if (!recipientInfoDraft.relationship) { onShowToast('Please select a relationship', 'error'); return; }
    if (!currentPlanId || !db) return;
    setSavingRecipientInfo(true);
    try {
      const oldKey = getKey(recipient!.firstName, recipient!.lastName);
      const newFirstName = recipientInfoDraft.firstName.trim();
      const newLastName = recipientInfoDraft.lastName.trim();
      const newKey = getKey(newFirstName, newLastName || 'noname');

      if (activeRecipient === 0) {
        await db.collection('job_postings').doc(currentPlanId).set({
          careRecipientFirstName: newFirstName,
          careRecipientLastName: newLastName,
          relationship: recipientInfoDraft.relationship,
          careRecipientAge: recipientInfoDraft.age.trim(),
        }, { merge: true });
        setWizardData((prev: any) => ({ ...prev, careRecipientFirstName: newFirstName, careRecipientLastName: newLastName, relationship: recipientInfoDraft.relationship, careRecipientAge: recipientInfoDraft.age.trim() }));
      } else {
        const updatedAdditional = (wizardData?.additionalRecipients || []).map((r: any, i: number) =>
          i === activeRecipient - 1 ? { ...r, firstName: newFirstName, lastName: newLastName, relationship: recipientInfoDraft.relationship, age: recipientInfoDraft.age.trim() } : r
        );
        await db.collection('job_postings').doc(currentPlanId).set({ additionalRecipients: updatedAdditional }, { merge: true });
        setWizardData((prev: any) => ({ ...prev, additionalRecipients: updatedAdditional }));
      }

      // If name changed, migrate the care plan key
      if (oldKey !== newKey) {
        const oldPlan = recipientPlans[oldKey];
        if (oldPlan) {
          const cpRef = db.collection('carePlans').doc(currentPlanId);
          await cpRef.set({ [`recipientPlans.${newKey}`]: oldPlan }, { merge: true });
          await cpRef.update({ [`recipientPlans.${oldKey}`]: firebase.firestore.FieldValue.delete() });
          setRecipientPlans(prev => { const u = { ...prev }; u[newKey] = oldPlan; delete u[oldKey]; return u; });
        }
      }

      setEditingRecipientInfo(false);
      onShowToast('Recipient info updated', 'success');
    } catch { onShowToast('Failed to save', 'error'); }
    finally { setSavingRecipientInfo(false); }
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
      await db.collection('job_postings').doc(currentPlanId).update({
        emergencyFirstName: setupDraft.firstName,
        emergencyLastName: setupDraft.lastName,
        emergencyPhone: setupDraft.phone,
        emergencyRelationship: setupDraft.relationship,
      });
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
          <button onClick={() => onNavigate('client')} className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="ml-2">
            <h1 className="text-2xl font-bold text-slate-900 leading-tight">Care Plan</h1>
            <p className="text-sm text-slate-400 mt-0.5">Manage care details for each recipient</p>
          </div>
        </div>

        {recipients.length > 0 ? (
          <>
            {/* Tabs */}
            <div className="flex gap-2 overflow-x-auto pb-1 mb-5 items-center">
              {recipients.map((r, i) => (
                <button key={i} onClick={() => handleTabChange(i)}
                  className={`flex items-center gap-2.5 px-4 py-2.5 rounded-2xl text-sm font-semibold whitespace-nowrap border-2 transition-all ${
                    activeRecipient === i
                      ? 'bg-primary-600 border-primary-600 text-white shadow-sm'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-600'
                  }`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${activeRecipient === i ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {initials(r.name) || <User className="w-3.5 h-3.5" />}
                  </div>
                  <div className="text-left leading-tight">
                    <p className="text-sm font-semibold">{r.firstName || r.name.split(' ')[0]}</p>
                    {(r.relationship || r.age) && (
                      <p className={`text-[10px] font-medium ${activeRecipient === i ? 'text-white/70' : 'text-slate-400'}`}>
                        {[r.relationship, r.age ? `Age ${r.age}` : ''].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </button>
              ))}
              {!isReadOnly && recipients.length < 4 && !showAddRecipient && (
                <button onClick={() => setShowAddRecipient(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap border-2 border-dashed border-slate-300 text-slate-400 hover:border-primary-400 hover:text-primary-600 transition-all bg-white">
                  <Plus className="w-4 h-4" /> Add
                </button>
              )}
            </div>

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
                      <option value="Myself">Myself</option>
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
                {/* Care details card */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm mb-4 overflow-hidden">

                  {/* ── Recipient header ── */}
                  <div className="px-5 py-4 border-b border-slate-100">
                    {editingRecipientInfo ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Edit Recipient Info</p>
                        <div className="grid grid-cols-2 gap-2 mb-3">
                          <input className={inputCls} placeholder="First name *" value={recipientInfoDraft.firstName} onChange={e => setRecipientInfoDraft(p => ({ ...p, firstName: e.target.value }))} />
                          <input className={inputCls} placeholder="Last name" value={recipientInfoDraft.lastName} onChange={e => setRecipientInfoDraft(p => ({ ...p, lastName: e.target.value }))} />
                          <select className={`${inputCls} ${!recipientInfoDraft.relationship ? 'text-slate-400' : 'text-slate-700'}`} value={recipientInfoDraft.relationship} onChange={e => setRecipientInfoDraft(p => ({ ...p, relationship: e.target.value }))}>
                            <option value="">Relationship *</option>
                            <option value="Myself">Myself</option>
                            <option value="Parent">Parent</option>
                            <option value="Spouse or Partner">Spouse or Partner</option>
                            <option value="Other">Other</option>
                          </select>
                          <input className={inputCls} placeholder="Age (optional)" value={recipientInfoDraft.age} onChange={e => setRecipientInfoDraft(p => ({ ...p, age: e.target.value.replace(/\D/g, '') }))} />
                        </div>
                        <div className="flex gap-2">
                          <button onClick={saveRecipientInfo} disabled={savingRecipientInfo} className="flex items-center gap-1 text-sm bg-primary-600 hover:bg-primary-700 text-white font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
                            {savingRecipientInfo && <Loader2 className="w-3 h-3 animate-spin" />} Save
                          </button>
                          <button onClick={() => setEditingRecipientInfo(false)} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-1.5 rounded-lg">Cancel</button>
                        </div>
                      </div>
                    ) : confirmDeleteRecipient ? (
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-red-700">Remove <span className="font-bold">{recipient.name}</span> from the care plan?</p>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={deleteRecipient} className="bg-red-600 hover:bg-red-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors">Yes, remove</button>
                          <button onClick={() => setConfirmDeleteRecipient(false)} className="bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors">No, keep</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-base shrink-0" style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)' }}>
                          {initials(recipient.name) || <User className="w-5 h-5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-slate-900 leading-tight truncate">{recipient.name}</p>
                          <div className="flex gap-1.5 flex-wrap mt-1">
                            {recipient.relationship && <span className="text-xs font-semibold text-primary-700 bg-primary-50 px-2.5 py-0.5 rounded-full capitalize border border-primary-100">{recipient.relationship}</span>}
                            {recipient.age && <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full border border-slate-200">Age {recipient.age}</span>}
                          </div>
                        </div>
                        {!isReadOnly && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => { setRecipientInfoDraft({ firstName: recipient.firstName, lastName: recipient.lastName, relationship: recipient.relationship, age: recipient.age || '' }); setEditingRecipientInfo(true); }} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-300 hover:text-primary-500 hover:bg-primary-50 transition-colors" title="Edit info">
                              <Pencil size={14} />
                            </button>
                            {activeRecipient > 0 && (
                              <button onClick={() => setConfirmDeleteRecipient(true)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors" title="Remove recipient">
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

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
                              <div className="space-y-1">
                                {rPlan.locations.filter(l => l.street || l.city).map((loc, i) => (
                                  <div key={i}>
                                    {loc.street && <p className="text-sm font-medium text-slate-800">{loc.street}</p>}
                                    <p className="text-sm text-slate-500">{[loc.city, [loc.state, loc.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</p>
                                  </div>
                                ))}
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
                              ? <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{rPlan.notes}</p>
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

                          <SubSec title="Favorite Activities (Currently Able to Do)">
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

                          <SubSec title="Activities They Enjoy but Need Help With">
                            <div className="flex flex-wrap gap-2">
                              {HELP_ACTIVITIES.map(a => (
                                <CheckPill key={a} label={a} selected={draft.lifestyle.helpActivities.includes(a)}
                                  onClick={() => setLS({ helpActivities: toggleArr(draft.lifestyle.helpActivities, a) })} />
                              ))}
                            </div>
                            {draft.lifestyle.helpActivities.includes('Other') && (
                              <input className={`mt-2 ${inputCls}`} placeholder="Describe other activity"
                                value={draft.lifestyle.helpActivitiesOther}
                                onChange={e => setLS({ helpActivitiesOther: e.target.value })} />
                            )}
                          </SubSec>

                          <SubSec title="Entertainment Preferences">
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

                          <SubSec title="Social Preferences">
                            <div className="space-y-2.5">
                              <YesNo label="Enjoys conversation" value={draft.lifestyle.enjoysConversation} onChange={v => setLS({ enjoysConversation: v })} />
                              <YesNo label="Prefers quiet environment" value={draft.lifestyle.prefersQuiet} onChange={v => setLS({ prefersQuiet: v })} />
                            </div>
                          </SubSec>

                          <SubSec title="Family in the Area">
                            <YesNo value={draft.lifestyle.familyInArea}
                              onChange={v => setLS({ familyInArea: v, familyVisitFreq: v ? draft.lifestyle.familyVisitFreq : '' })} />
                            {draft.lifestyle.familyInArea && (
                              <div className="mt-3">
                                <p className="text-xs text-slate-500 mb-2">Visit frequency</p>
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
                                <p className="text-xs text-slate-500 mb-2">Visit frequency</p>
                                <div className="flex flex-wrap gap-2">
                                  {FREQ_OPTIONS.map(f => (
                                    <CheckPill key={f} label={f} selected={draft.lifestyle.friendsVisitFreq === f}
                                      onClick={() => setLS({ friendsVisitFreq: draft.lifestyle.friendsVisitFreq === f ? '' : f })} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </SubSec>

                          <SubSec title="Pets in the Home">
                            <YesNo value={draft.lifestyle.petsInHome}
                              onChange={v => setLS({ petsInHome: v, petTypes: v ? draft.lifestyle.petTypes : [], petName: v ? draft.lifestyle.petName : '' })} />
                            {draft.lifestyle.petsInHome && (
                              <div className="mt-3 space-y-2">
                                <div className="flex flex-wrap gap-2">
                                  {PET_TYPES.map(t => (
                                    <CheckPill key={t} label={t} selected={draft.lifestyle.petTypes.includes(t)}
                                      onClick={() => setLS({ petTypes: toggleArr(draft.lifestyle.petTypes, t) })} />
                                  ))}
                                </div>
                                <input className={inputCls} placeholder="Pet name (optional)"
                                  value={draft.lifestyle.petName}
                                  onChange={e => setLS({ petName: e.target.value })} />
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
                                <ReadChips label="Favorite Activities" items={rPlan.lifestyle.favoriteActivities.map(a => a === 'Other' && rPlan.lifestyle.favoriteActivitiesOther ? rPlan.lifestyle.favoriteActivitiesOther : a)} color="bg-rose-50 border-rose-100 text-rose-700" />
                                <ReadChips label="Needs Help With" items={rPlan.lifestyle.helpActivities.map(a => a === 'Other' && rPlan.lifestyle.helpActivitiesOther ? rPlan.lifestyle.helpActivitiesOther : a)} color="bg-orange-50 border-orange-100 text-orange-700" />
                                <ReadChips label="Entertainment" items={rPlan.lifestyle.entertainment.map(a => a === 'Other' && rPlan.lifestyle.entertainmentOther ? rPlan.lifestyle.entertainmentOther : a)} color="bg-purple-50 border-purple-100 text-purple-700" />
                                <ReadChips label="Social"
                                  items={[
                                    rPlan.lifestyle.enjoysConversation === true ? 'Enjoys conversation' : '',
                                    rPlan.lifestyle.prefersQuiet === true ? 'Prefers quiet' : '',
                                  ].filter(Boolean)}
                                  color="bg-blue-50 border-blue-100 text-blue-700" />
                                {(rPlan.lifestyle.familyInArea === true || rPlan.lifestyle.friendsVisitors === true) && (
                                  <ReadChips label="Visitors"
                                    items={[
                                      rPlan.lifestyle.familyInArea === true ? `Family nearby${rPlan.lifestyle.familyVisitFreq ? ` · ${rPlan.lifestyle.familyVisitFreq}` : ''}` : '',
                                      rPlan.lifestyle.friendsVisitors === true ? `Friends visit${rPlan.lifestyle.friendsVisitFreq ? ` · ${rPlan.lifestyle.friendsVisitFreq}` : ''}` : '',
                                    ].filter(Boolean)}
                                    color="bg-green-50 border-green-100 text-green-700" />
                                )}
                                {rPlan.lifestyle.petsInHome === true && (
                                  <ReadChips label="Pets"
                                    items={rPlan.lifestyle.petTypes.length > 0
                                      ? rPlan.lifestyle.petTypes.map(t => rPlan.lifestyle.petName ? `${t} (${rPlan.lifestyle.petName})` : t)
                                      : rPlan.lifestyle.petName ? [rPlan.lifestyle.petName] : ['Yes']}
                                    color="bg-amber-50 border-amber-100 text-amber-700" />
                                )}
                                {rPlan.lifestyle.hasAppointments === true && (
                                  <div>
                                    <p className="text-xs text-slate-400 mb-1.5">Appointments</p>
                                    <p className="text-sm text-slate-700">{rPlan.lifestyle.appointmentsDetails || 'Has regular appointments'}</p>
                                  </div>
                                )}
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
            {!showAddRecipient && <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
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
              <FileText className="w-7 h-7 text-slate-400" />
            </div>
            <p className="font-semibold text-slate-700">No care recipients found.</p>
            <p className="text-sm text-slate-400 mt-1">Complete the care setup wizard to populate this page.</p>
          </div>
        )}
      </div>
    </div>
  );
};
