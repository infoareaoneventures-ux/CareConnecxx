
import React, { useState, useEffect, useMemo } from 'react';
import {
  Phone, FileText, ChevronLeft, Plus, Trash2, Loader2, User,
  Check, X, Pencil, MapPin, ClipboardList, StickyNote, PhoneCall,
} from 'lucide-react';
import { ViewType, AddToastFunction, CarePlan as CarePlanType } from '../types';
import { dbService, authService } from '../services/api';
import { db } from '../lib/firebase';
import { ClientNavigation } from './client/ClientNavigation';

const CARE_TYPES = [
  'Mobility Assistance', 'Dementia / Memory Care', 'Medication Reminders',
  'Personal Care (Bathing & Dressing)', 'Companionship', 'Transportation',
  'Meal Preparation', 'Light Housekeeping',
];

interface LocationEntry { street: string; city: string; state: string; zipCode: string; }
interface RecipientPlanData { careNeeds: string[]; locations: LocationEntry[]; notes: string; }
interface RecipientEntry { firstName: string; lastName: string; name: string; relationship: string; age?: string; }

const getKey = (firstName: string, lastName: string) =>
  `${firstName.toLowerCase()}_${(lastName || 'noname').toLowerCase()}`.replace(/\s+/g, '_');

const emptyLocation = (): LocationEntry => ({ street: '', city: '', state: '', zipCode: '' });
const locLabel = (l: LocationEntry) =>
  [l.street, l.city, [l.state, l.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');

const initials = (name: string) =>
  name.trim().split(/\s+/).map(p => p[0]?.toUpperCase() || '').slice(0, 2).join('');

const inputCls = 'border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-400 bg-white';

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

  const [editingSection, setEditingSection] = useState<'careNeeds' | 'locations' | 'notes' | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const [draftPlan, setDraftPlan] = useState<RecipientPlanData | null>(null);

  const [draftLocPool, setDraftLocPool] = useState<LocationEntry[]>([]);
  const [editingPoolIdx, setEditingPoolIdx] = useState<number | null>(null);
  const [editingPoolDraft, setEditingPoolDraft] = useState<LocationEntry | null>(null);

  const [editingContactIdx, setEditingContactIdx] = useState<number | null>(null);
  const [savingContacts, setSavingContacts] = useState(false);

  const [editingSetupContact, setEditingSetupContact] = useState(false);
  const [setupDraft, setSetupDraft] = useState({ firstName: '', lastName: '', phone: '', relationship: '' });
  const [savingSetup, setSavingSetup] = useState(false);

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
    if (recipientPlans[key]) return recipientPlans[key];
    return { careNeeds: wizardData?.careNeeds || [], locations: wizardLocations.slice(0, 1), notes: wizardData?.jobDescription || '' };
  };

  const startEdit = (section: 'careNeeds' | 'locations' | 'notes') => {
    if (!recipient) return;
    setDraftPlan({ ...getPlan(recipient) });
    if (section === 'locations') {
      setDraftLocPool([...effectivePool]);
      setEditingPoolIdx(null);
      setEditingPoolDraft(null);
    }
    setEditingSection(section);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setDraftPlan(null);
    setDraftLocPool([]);
    setEditingPoolIdx(null);
    setEditingPoolDraft(null);
  };

  const saveSection = async () => {
    if (!recipient || !draftPlan || !currentPlanId || !db) return;
    setSavingSection(true);
    try {
      const key = getKey(recipient.firstName, recipient.lastName);
      const updated = { ...getPlan(recipient), ...draftPlan };
      const docRef = db.collection('carePlans').doc(currentPlanId);
      const updatePayload: Record<string, any> = { [`recipientPlans.${key}`]: updated };
      if (editingSection === 'locations') updatePayload.locationPool = draftLocPool;
      try {
        await docRef.update(updatePayload);
      } catch (e: any) {
        if (e.code === 'not-found') {
          const payload: Record<string, any> = { recipientPlans: { [key]: updated } };
          if (editingSection === 'locations') payload.locationPool = draftLocPool;
          await docRef.set(payload);
        } else throw e;
      }
      setRecipientPlans(prev => ({ ...prev, [key]: updated }));
      if (editingSection === 'locations') setLocationPool(draftLocPool);
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

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {!targetUserId && <ClientNavigation />}
      <div className="max-w-3xl mx-auto p-4 md:p-6 animate-slide-in">

        {/* Page header */}
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
            {/* Recipient tabs */}
            <div className="flex gap-2 overflow-x-auto pb-1 mb-6 scrollbar-hide">
              {recipients.map((r, i) => (
                <button key={i} onClick={() => handleTabChange(i)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap border-2 transition-all ${
                    activeRecipient === i
                      ? 'bg-primary-600 border-primary-600 text-white shadow-sm'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-600'
                  }`}>
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${activeRecipient === i ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {initials(r.name) || <User className="w-3 h-3" />}
                  </div>
                  {r.name}
                </button>
              ))}
            </div>

            {recipient && rPlan && (
              <>
                {/* Recipient info banner */}
                <div className="bg-gradient-to-r from-primary-600 to-primary-500 rounded-2xl px-5 py-4 mb-4 flex items-center gap-4 shadow-sm">
                  <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-lg shrink-0">
                    {initials(recipient.name) || <User className="w-6 h-6" />}
                  </div>
                  <div>
                    <p className="font-bold text-white text-lg leading-tight">{recipient.name}</p>
                    <div className="flex gap-2 flex-wrap mt-1">
                      {recipient.relationship && (
                        <span className="text-xs text-white/80 bg-white/20 px-2.5 py-0.5 rounded-full capitalize font-medium">
                          {recipient.relationship}
                        </span>
                      )}
                      {recipient.age && (
                        <span className="text-xs text-white/70 font-medium">Age {recipient.age}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Care details card */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm mb-4 overflow-hidden">

                  {/* Care Needs */}
                  <div className={`px-5 py-5 border-b border-slate-100 ${editingSection === 'careNeeds' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'careNeeds' && draft ? (
                      <>
                        <div className="flex items-center gap-2 mb-4">
                          <ClipboardList className="w-4 h-4 text-primary-500" />
                          <p className="text-sm font-semibold text-slate-700">Care Needs</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mb-4">
                          {CARE_TYPES.map(need => {
                            const selected = draft.careNeeds.includes(need);
                            return (
                              <button key={need} type="button"
                                onClick={() => setDraftPlan(prev => prev ? { ...prev, careNeeds: selected ? prev.careNeeds.filter(n => n !== need) : [...prev.careNeeds, need] } : prev)}
                                className={`flex items-center justify-between px-3 py-2.5 rounded-xl border-2 text-xs font-medium transition-all text-left ${selected ? 'bg-primary-50 border-primary-500 text-primary-700' : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'}`}>
                                <span>{need}</span>
                                {selected && <Check size={12} className="flex-shrink-0 text-primary-600 ml-1" />}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <button onClick={saveSection} disabled={savingSection} className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
                            {savingSection && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                          </button>
                          <button onClick={cancelEdit} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg font-medium">Cancel</button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
                            <ClipboardList className="w-4 h-4 text-blue-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Care Needs</p>
                            {rPlan.careNeeds.length > 0 ? (
                              <div className="flex flex-wrap gap-1.5">
                                {rPlan.careNeeds.map(need => (
                                  <span key={need} className="inline-flex items-center text-xs font-medium bg-primary-50 text-primary-700 border border-primary-100 px-2.5 py-1 rounded-full">
                                    {need}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-slate-400 italic">No care needs specified</p>
                            )}
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

                  {/* Care Location */}
                  <div className={`px-5 py-5 border-b border-slate-100 ${editingSection === 'locations' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'locations' && draft ? (() => {
                      const selPoolIdx = draftLocPool.findIndex(wl =>
                        draft.locations[0]?.street === wl.street &&
                        draft.locations[0]?.city === wl.city &&
                        draft.locations[0]?.zipCode === wl.zipCode
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
                                          <input className={inputCls} placeholder="City" value={editingPoolDraft.city} onChange={e => setEditingPoolDraft(p => p ? { ...p, city: e.target.value } : p)} />
                                          <input className={inputCls} placeholder="State" value={editingPoolDraft.state} onChange={e => setEditingPoolDraft(p => p ? { ...p, state: e.target.value } : p)} />
                                          <input className={inputCls} placeholder="Zip code" value={editingPoolDraft.zipCode} onChange={e => setEditingPoolDraft(p => p ? { ...p, zipCode: e.target.value } : p)} />
                                        </div>
                                        <div className="flex gap-2">
                                          <button onClick={() => {
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
                                  return (
                                    <div key={i} className={`flex items-center gap-1 rounded-xl border-2 text-sm transition-all ${selected ? 'bg-primary-50 border-primary-500' : 'bg-white border-slate-200'}`}>
                                      <button type="button" onClick={() => setDraftPlan(prev => prev ? { ...prev, locations: selected ? [] : [wl] } : prev)}
                                        className="flex-1 flex items-center justify-between px-3 py-2.5 gap-2 text-left">
                                        <span className={selected ? 'text-primary-700' : 'text-slate-600'}>{locLabel(wl) || 'New address'}</span>
                                        {selected && <Check size={14} className="flex-shrink-0 text-primary-600" />}
                                      </button>
                                      <button type="button" onClick={() => { setEditingPoolIdx(i); setEditingPoolDraft({ ...wl }); }}
                                        className="p-2 text-slate-400 hover:text-primary-600 transition-colors" title="Edit address">
                                        <Pencil size={13} />
                                      </button>
                                      <button type="button" onClick={() => {
                                        setDraftLocPool(prev => prev.filter((_, idx) => idx !== i));
                                        if (selected) setDraftPlan(prev => prev ? { ...prev, locations: [] } : prev);
                                      }} className="p-2 pr-3 text-slate-400 hover:text-red-500 transition-colors" title="Delete address">
                                        <X size={13} />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {hasCustom && (
                            <div className="p-4 rounded-xl border border-slate-200 bg-white relative mb-2">
                              <button onClick={() => setDraftPlan(prev => prev ? { ...prev, locations: [] } : prev)} className="absolute top-2 right-2 text-slate-400 hover:text-red-500 transition-colors"><X size={14} /></button>
                              <div className="grid grid-cols-2 gap-2">
                                <input className={`col-span-2 ${inputCls}`} placeholder="Street address" value={customLoc.street} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...customLoc, street: e.target.value }] } : prev)} />
                                <input className={inputCls} placeholder="City" value={customLoc.city} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...customLoc, city: e.target.value }] } : prev)} />
                                <input className={inputCls} placeholder="State" value={customLoc.state} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...customLoc, state: e.target.value }] } : prev)} />
                                <input className={inputCls} placeholder="Zip code" value={customLoc.zipCode} onChange={e => setDraftPlan(prev => prev ? { ...prev, locations: [{ ...customLoc, zipCode: e.target.value }] } : prev)} />
                              </div>
                            </div>
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

                          <div className="flex gap-2 mt-4">
                            <button onClick={saveSection} disabled={savingSection} className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
                              {savingSection && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                            </button>
                            <button onClick={cancelEdit} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg font-medium">Cancel</button>
                          </div>
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
                                  <div key={i} className="flex items-start gap-2">
                                    <div className="flex-1">
                                      {loc.street && <p className="text-sm font-medium text-slate-800">{loc.street}</p>}
                                      <p className="text-sm text-slate-500">{[loc.city, [loc.state, loc.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-slate-400 italic">No location assigned</p>
                            )}
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

                  {/* Notes */}
                  <div className={`px-5 py-5 ${editingSection === 'notes' ? 'bg-slate-50' : ''}`}>
                    {editingSection === 'notes' && draft ? (
                      <>
                        <div className="flex items-center gap-2 mb-3">
                          <StickyNote className="w-4 h-4 text-primary-500" />
                          <p className="text-sm font-semibold text-slate-700">Notes</p>
                        </div>
                        <textarea rows={4} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-primary-400 resize-none mb-3"
                          placeholder="Add notes specific to this care recipient…" value={draft.notes}
                          onChange={e => setDraftPlan(prev => prev ? { ...prev, notes: e.target.value } : prev)} />
                        <div className="flex gap-2">
                          <button onClick={saveSection} disabled={savingSection} className="flex items-center gap-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60 transition-colors">
                            {savingSection && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                          </button>
                          <button onClick={cancelEdit} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg font-medium">Cancel</button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center shrink-0 mt-0.5">
                            <StickyNote className="w-4 h-4 text-amber-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Notes</p>
                            {rPlan.notes ? (
                              <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{rPlan.notes}</p>
                            ) : (
                              <p className="text-sm text-slate-400 italic">No notes added yet</p>
                            )}
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
                </div>
              </>
            )}

            {/* Emergency Contacts */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
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

              {/* Setup contact — editable */}
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
                          {wizardData.emergencyRelationship && (
                            <span className="text-xs text-slate-500 capitalize">{wizardData.emergencyRelationship}</span>
                          )}
                          {wizardData.emergencyPhone && (
                            <>
                              {wizardData.emergencyRelationship && <span className="text-slate-300">·</span>}
                              <span className="text-xs text-slate-500 flex items-center gap-1">
                                <Phone className="w-3 h-3" />{wizardData.emergencyPhone}
                              </span>
                            </>
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

              {/* Manually added contacts */}
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
                            <>
                              {contact.relation && <span className="text-slate-300">·</span>}
                              <span className="text-xs text-slate-500 flex items-center gap-1">
                                <Phone className="w-3 h-3" />{contact.phone}
                              </span>
                            </>
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
            </div>
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
