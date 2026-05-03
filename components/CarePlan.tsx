
import React, { useState, useEffect } from 'react';
import { Pill, Phone, Clock, FileText, ChevronLeft, Plus, Trash2, Save, Loader2, AlertCircle, CheckSquare, Square, User, Heart, Home, Calendar, MapPin, DollarSign } from 'lucide-react';
import { Button } from './ui/Button';
import { ViewType, AddToastFunction, CarePlan as CarePlanType, Medication, EmergencyContact, RoutineTask, ClientIntakeData } from '../types';
import { dbService, authService } from '../services/api';
import { db } from '../lib/firebase';
import { ClientNavigation } from './client/ClientNavigation';

interface CarePlanProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
  targetUserId?: string | null; // If provided, we are viewing another user (e.g. Caregiver viewing Client)
}

export const CarePlan: React.FC<CarePlanProps> = ({ onNavigate, onShowToast, targetUserId }) => {
  const [activeTab, setActiveTab] = useState<'meds' | 'contacts' | 'routine' | 'intake'>('meds');
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<CarePlanType>({
    medications: [],
    emergencyContacts: [],
    dailyRoutine: []
  });

  // Intake data state
  const [intakeData, setIntakeData] = useState<ClientIntakeData | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(true);

  // Senior profile from signup
  const [seniorProfile, setSeniorProfile] = useState<{
    firstName?: string;
    ageGroup?: string;
    gender?: string;
    relationship?: string;
    conditions?: string[];
  } | null>(null);

  // Wizard data from job_postings
  const [wizardData, setWizardData] = useState<any>(null);

  const currentUser = authService.getCurrentUser();
  const isReadOnly = !!targetUserId && targetUserId !== currentUser?.uid; // If viewing someone else, it's read-only (mostly)
  const currentPlanId = targetUserId || currentUser?.uid || null;

  // Use Real-time Subscription
  useEffect(() => {
    if (!currentPlanId) {
      setLoading(false);
      onNavigate('client-login');
      return;
    }
    const unsubscribe = dbService.subscribeToCarePlan(currentPlanId, (updatedPlan) => {
        setPlan(updatedPlan);
        setLoading(false);
    });
    return () => unsubscribe();
  }, [currentPlanId]);
  
  // Fetch intake data
  useEffect(() => {
    const fetchIntakeData = async () => {
      if (!currentPlanId || !db) return;

      setIntakeLoading(true);
      try {
        const intakeDoc = await db.collection('clientIntakes').doc(currentPlanId).get();
        if (intakeDoc.exists) {
          setIntakeData(intakeDoc.data() as ClientIntakeData);
        }
      } catch (error) {
        console.warn('Could not load intake data:', error);
      } finally {
        setIntakeLoading(false);
      }
    };

    fetchIntakeData();
  }, [currentPlanId]);

  // Fetch senior profile from signup step 2
  useEffect(() => {
    const fetchSeniorProfile = async () => {
      if (!currentPlanId || !db) return;
      try {
        const userDoc = await db.collection('users').doc(currentPlanId).get();
        const profile = (userDoc.data() as any)?.seniorProfile;
        if (profile?.firstName || profile?.conditions?.length) {
          setSeniorProfile(profile);
        }
      } catch {
        // non-critical
      }
    };
    fetchSeniorProfile();
  }, [currentPlanId]);

  // Load wizard data from job_postings
  useEffect(() => {
    const load = async () => {
      if (!currentPlanId || !db) return;
      try {
        const snap = await db.collection('job_postings').doc(currentPlanId).get();
        if (snap.exists) setWizardData(snap.data());
      } catch { /* non-critical */ }
    };
    load();
  }, [currentPlanId]);

  const handleSave = async () => {
    if (isReadOnly) return;
    if (currentPlanId) {
        await dbService.updateCarePlan(currentPlanId, plan);
        onShowToast("Care Binder updated successfully", 'success');
    } else {
        onShowToast("Changes simulated (Demo Mode)", 'success');
    }
  };

  const handleTaskToggle = async (index: number) => {
      // Caregivers can toggle tasks
      const newPlan = await dbService.toggleRoutineTask(currentPlanId, index, plan);
      // Local state update handled by subscription usually, but optimistic update is good UX
      setPlan(newPlan);
      onShowToast(newPlan.dailyRoutine[index].isCompleted ? "Task completed" : "Task unchecked", "info");
  };

  const addMedication = () => {
      const newMed: Medication = { id: crypto.randomUUID(), name: 'New Med', dosage: '', frequency: 'Morning' };
      setPlan(prev => ({ ...prev, medications: [...prev.medications, newMed] }));
  };

  const addContact = () => {
      const newContact: EmergencyContact = { id: crypto.randomUUID(), name: 'New Contact', relation: '', phone: '', isPrimary: false };
      setPlan(prev => ({ ...prev, emergencyContacts: [...prev.emergencyContacts, newContact] }));
  };

  const updateItem = (section: keyof CarePlanType, index: number, field: string, value: any) => {
      if (isReadOnly) return;
      setPlan(prev => {
          const list = [...(prev[section] as any[])];
          list[index] = { ...list[index], [field]: value };
          return { ...prev, [section]: list };
      });
  };

  const deleteItem = (section: keyof CarePlanType, index: number) => {
      if (isReadOnly) return;
      setPlan(prev => {
          const list = [...(prev[section] as any[])];
          list.splice(index, 1);
          return { ...prev, [section]: list };
      });
  };
  
  // Format weekly schedule for display
  const formatSchedule = (weeklySchedule?: Record<string, Array<{start: string, end: string}>>) => {
    if (!weeklySchedule) return 'No schedule set';
    
    const days = Object.entries(weeklySchedule)
      .filter(([_, slots]) => slots.length > 0)
      .map(([day, slots]) => {
        const slotStr = slots.map(s => `${s.start} - ${s.end}`).join(', ');
        return `${day}: ${slotStr}`;
      });
    
    return days.length > 0 ? days.join('; ') : 'No schedule set';
  };

  if (loading) return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-primary-600" /></div>;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {!targetUserId && <ClientNavigation />}
      <div className="max-w-3xl mx-auto p-4 md:p-6 animate-slide-in">
       {/* Header */}
       <div className="flex items-center justify-between mb-6">
         <div className="flex items-center">
            <button 
                onClick={() => onNavigate('client')} // Navigates back to generic dashboard, App.tsx handles correct routing context
                className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
            >
                <ChevronLeft className="w-6 h-6" />
            </button>
            <div>
               <h1 className="text-2xl font-bold text-slate-900 ml-2">Digital Care Binder</h1>
               {isReadOnly && (
                   <span className="ml-2 text-xs bg-accent-100 text-accent-700 px-2 py-0.5 rounded-full font-bold flex items-center w-fit mt-1">
                       <User className="w-3 h-3 mr-1" /> Client View Mode
                   </span>
               )}
            </div>
         </div>
         {!isReadOnly && (
            <Button size="sm" onClick={handleSave} className="flex items-center">
                <Save className="w-4 h-4 mr-2" /> Save Changes
            </Button>
         )}
       </div>

       {/* Senior profile banner */}
       {seniorProfile && (
         <div className="mb-5 bg-primary-50 border border-primary-100 rounded-xl px-4 py-3">
           <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2">
             <div className="flex items-center gap-1.5">
               <User className="w-4 h-4 text-primary-600" />
               <span className="text-sm font-bold text-primary-900">
                 {seniorProfile.firstName || 'Your senior'}
               </span>
             </div>
             {seniorProfile.ageGroup && (
               <span className="text-xs text-primary-700 bg-white border border-primary-200 px-2 py-0.5 rounded-full">
                 {seniorProfile.ageGroup} yrs
               </span>
             )}
             {seniorProfile.gender && (
               <span className="text-xs text-primary-700 bg-white border border-primary-200 px-2 py-0.5 rounded-full">
                 {seniorProfile.gender}
               </span>
             )}
             {seniorProfile.relationship && (
               <span className="text-xs text-slate-500">· Your {seniorProfile.relationship.toLowerCase()}</span>
             )}
           </div>
           {seniorProfile.conditions && seniorProfile.conditions.length > 0 && (
             <div className="flex flex-wrap gap-1">
               {seniorProfile.conditions.map((c, i) => (
                 <span key={i} className="text-xs px-2 py-0.5 bg-accent-50 text-accent-700 border border-accent-100 rounded-full font-medium">
                   {c}
                 </span>
               ))}
             </div>
           )}
         </div>
       )}

       {/* Tabs */}
       <div className="flex space-x-2 bg-slate-100 p-1 rounded-xl mb-6 overflow-x-auto">
          <button 
            onClick={() => setActiveTab('meds')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${activeTab === 'meds' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Medications
          </button>
          <button 
            onClick={() => setActiveTab('contacts')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${activeTab === 'contacts' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Contacts
          </button>
          <button 
            onClick={() => setActiveTab('routine')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${activeTab === 'routine' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Daily Routine
          </button>
          <button 
            onClick={() => setActiveTab('intake')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${activeTab === 'intake' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Care Needs
          </button>
       </div>

       {/* Content */}
       <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 min-h-[400px]">
          
          {/* MEDICATIONS TAB */}
          {activeTab === 'meds' && (
              <div className="space-y-4">
                  <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 flex items-center">
                          <Pill className="w-5 h-5 mr-2 text-blue-500" /> Medication List
                      </h3>
                      {!isReadOnly && (
                        <button onClick={addMedication} className="text-sm text-primary-600 font-medium hover:underline flex items-center">
                            <Plus className="w-4 h-4 mr-1" /> Add Med
                        </button>
                      )}
                  </div>
                  {plan.medications.map((med, idx) => (
                      <div key={med.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50 relative group">
                          <div className="grid grid-cols-2 gap-3 mb-2">
                              <input 
                                  disabled={isReadOnly}
                                  className={`bg-white border border-slate-200 rounded px-2 py-1 text-sm font-bold ${isReadOnly ? 'text-slate-700' : ''}`}
                                  value={med.name}
                                  onChange={(e) => updateItem('medications', idx, 'name', e.target.value)}
                                  placeholder="Medication Name"
                              />
                              <input 
                                  disabled={isReadOnly}
                                  className="bg-white border border-slate-200 rounded px-2 py-1 text-sm"
                                  value={med.dosage}
                                  onChange={(e) => updateItem('medications', idx, 'dosage', e.target.value)}
                                  placeholder="Dosage"
                              />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                              <select 
                                  disabled={isReadOnly}
                                  className="bg-white border border-slate-200 rounded px-2 py-1 text-sm text-slate-600"
                                  value={med.frequency}
                                  onChange={(e) => updateItem('medications', idx, 'frequency', e.target.value)}
                              >
                                  <option>Morning</option>
                                  <option>Afternoon</option>
                                  <option>Evening</option>
                                  <option>Before Bed</option>
                                  <option>As Needed</option>
                              </select>
                              <input 
                                  disabled={isReadOnly}
                                  className="bg-white border border-slate-200 rounded px-2 py-1 text-sm"
                                  value={med.notes || ''}
                                  onChange={(e) => updateItem('medications', idx, 'notes', e.target.value)}
                                  placeholder="Notes"
                              />
                          </div>
                          {!isReadOnly && (
                            <button 
                                onClick={() => deleteItem('medications', idx)}
                                className="absolute -top-2 -right-2 bg-red-100 text-red-500 p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <Trash2 size={14} />
                            </button>
                          )}
                      </div>
                  ))}
                  {plan.medications.length === 0 && (
                      <div className="text-center py-8 text-slate-400 border-2 border-dashed border-slate-100 rounded-xl">
                          No medications listed.
                      </div>
                  )}
              </div>
          )}

          {/* CONTACTS TAB */}
          {activeTab === 'contacts' && (
              <div className="space-y-4">
                  <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 flex items-center">
                          <Phone className="w-5 h-5 mr-2 text-green-500" /> Emergency Contacts
                      </h3>
                      {!isReadOnly && (
                        <button onClick={addContact} className="text-sm text-primary-600 font-medium hover:underline flex items-center">
                            <Plus className="w-4 h-4 mr-1" /> Add Contact
                        </button>
                      )}
                  </div>

                  {/* Emergency contact from wizard */}
                  {wizardData?.emergencyFirstName && (
                    <div className="p-4 rounded-xl border border-indigo-100 bg-indigo-50">
                      <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-2">From your care setup</p>
                      <p className="font-bold text-slate-900">
                        {wizardData.emergencyFirstName}{wizardData.emergencyLastName ? ` ${wizardData.emergencyLastName}` : ''}
                      </p>
                      {wizardData.emergencyPhone && (
                        <p className="text-sm text-slate-600 flex items-center gap-1.5 mt-1">
                          <Phone className="w-3.5 h-3.5 text-slate-400" /> {wizardData.emergencyPhone}
                        </p>
                      )}
                    </div>
                  )}

                  {plan.emergencyContacts.map((contact, idx) => (
                      <div key={contact.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50 relative group">
                          <div className="flex items-center gap-3 mb-2">
                              <input 
                                  disabled={isReadOnly}
                                  className="flex-grow bg-white border border-slate-200 rounded px-2 py-1 text-sm font-bold"
                                  value={contact.name}
                                  onChange={(e) => updateItem('emergencyContacts', idx, 'name', e.target.value)}
                                  placeholder="Contact Name"
                              />
                              <label className="flex items-center text-xs text-slate-500 cursor-pointer">
                                  <input 
                                      disabled={isReadOnly}
                                      type="checkbox" 
                                      checked={contact.isPrimary}
                                      onChange={(e) => updateItem('emergencyContacts', idx, 'isPrimary', e.target.checked)}
                                      className="mr-1 text-primary-600 rounded"
                                  /> Primary
                              </label>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                              <input 
                                  disabled={isReadOnly}
                                  className="bg-white border border-slate-200 rounded px-2 py-1 text-sm"
                                  value={contact.relation}
                                  onChange={(e) => updateItem('emergencyContacts', idx, 'relation', e.target.value)}
                                  placeholder="Relation"
                              />
                              <input 
                                  disabled={isReadOnly}
                                  className="bg-white border border-slate-200 rounded px-2 py-1 text-sm"
                                  value={contact.phone}
                                  onChange={(e) => updateItem('emergencyContacts', idx, 'phone', e.target.value)}
                                  placeholder="Phone Number"
                              />
                          </div>
                          {!isReadOnly && (
                            <button 
                                onClick={() => deleteItem('emergencyContacts', idx)}
                                className="absolute -top-2 -right-2 bg-red-100 text-red-500 p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <Trash2 size={14} />
                            </button>
                          )}
                      </div>
                  ))}
              </div>
          )}

          {/* ROUTINE TAB */}
          {activeTab === 'routine' && (
              <div className="space-y-4">
                   <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 flex items-center">
                          <Clock className="w-5 h-5 mr-2 text-accent-500" /> Daily Routine
                      </h3>
                      {isReadOnly ? (
                          <span className="text-xs text-green-700 bg-green-100 px-2 py-1 rounded font-bold">Interactive Checklist</span>
                      ) : (
                          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded">Edit Mode</span>
                      )}
                  </div>
                  {plan.dailyRoutine.map((task, idx) => (
                      <div key={task.id} className={`flex items-start p-3 rounded-xl border transition-all ${
                          task.isCompleted ? 'bg-green-50 border-green-200' : 'bg-slate-50 border-slate-100'
                      }`}>
                          <div className="bg-white border border-slate-200 px-2 py-1 rounded text-xs font-bold text-slate-600 mr-3 min-w-[60px] text-center mt-1">
                              {task.time}
                          </div>
                          <div className="flex-grow">
                              <p className={`text-sm font-medium ${task.isCompleted ? 'text-green-800 line-through' : 'text-slate-800'}`}>
                                  {task.description}
                              </p>
                              <span className="text-[10px] uppercase tracking-wider text-slate-400">{task.category}</span>
                          </div>
                          
                          {/* Interactive Checkbox */}
                          <button 
                             onClick={() => handleTaskToggle(idx)}
                             className={`ml-2 p-1 rounded transition-colors ${
                                 task.isCompleted ? 'text-green-600 hover:text-green-700' : 'text-slate-300 hover:text-slate-400'
                             }`}
                          >
                              {task.isCompleted ? <CheckSquare className="w-6 h-6" /> : <Square className="w-6 h-6" />}
                          </button>
                      </div>
                  ))}
                  {plan.dailyRoutine.length === 0 && (
                      <div className="flex items-center justify-center p-8 text-slate-400 bg-slate-50 rounded-xl">
                          <AlertCircle className="w-4 h-4 mr-2" /> No routine tasks configured.
                      </div>
                  )}
              </div>
          )}

          {/* INTAKE TAB - Care Needs from ClientIntake */}
          {activeTab === 'intake' && (
              <div className="space-y-6">
                  <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 flex items-center">
                          <FileText className="w-5 h-5 mr-2 text-primary-500" /> Care Needs Summary
                      </h3>
                  </div>
                  
                  {intakeLoading ? (
                      <div className="flex items-center justify-center p-8">
                          <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
                          <span className="ml-2 text-slate-500">Loading intake data...</span>
                      </div>
                  ) : intakeData ? (
                      <div className="space-y-5">
                          {/* Care Recipient */}
                          <div className="bg-primary-50 rounded-xl p-4 border border-primary-200">
                              <div className="flex items-center gap-2 mb-3">
                                  <User className="w-5 h-5 text-primary-600" />
                                  <h4 className="font-bold text-slate-900">Care Recipient</h4>
                              </div>
                              <div className="grid sm:grid-cols-2 gap-3">
                                  <div>
                                      <p className="text-xs text-slate-500">Name</p>
                                      <p className="font-medium text-slate-900">
                                          {intakeData.recipientFirstName} {intakeData.recipientLastName}
                                      </p>
                                  </div>
                                  <div>
                                      <p className="text-xs text-slate-500">Relationship</p>
                                      <p className="font-medium text-slate-900">{intakeData.relationship}</p>
                                  </div>
                              </div>
                          </div>

                          {/* Care Types */}
                          <div className="bg-white rounded-xl p-4 border border-slate-200">
                              <div className="flex items-center gap-2 mb-3">
                                  <Heart className="w-5 h-5 text-primary-600" />
                                  <h4 className="font-bold text-slate-900">Care Types Needed</h4>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                  {intakeData.careTypes?.map((type, idx) => (
                                      <span
                                          key={idx}
                                          className="px-3 py-1.5 bg-primary-50 text-primary-700 text-sm font-medium rounded-lg"
                                      >
                                          {type}
                                      </span>
                                  ))}
                              </div>
                          </div>

                          {/* Schedule */}
                          <div className="bg-white rounded-xl p-4 border border-slate-200">
                              <div className="flex items-center gap-2 mb-3">
                                  <Clock className="w-5 h-5 text-primary-600" />
                                  <h4 className="font-bold text-slate-900">Schedule</h4>
                              </div>
                              <div className="space-y-2">
                                  <p className="text-sm">
                                      <span className="text-slate-500">Type:</span>{' '}
                                      <span className="font-medium text-slate-900">{intakeData.schedule}</span>
                                  </p>
                                  <div>
                                      <p className="text-xs text-slate-500 mb-1">Weekly Schedule:</p>
                                      <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3">
                                          {formatSchedule(intakeData.weeklySchedule)}
                                      </p>
                                  </div>
                              </div>
                          </div>

                          {/* Location */}
                          <div className="bg-white rounded-xl p-4 border border-slate-200">
                              <div className="flex items-center gap-2 mb-3">
                                  <Home className="w-5 h-5 text-primary-600" />
                                  <h4 className="font-bold text-slate-900">Care Location</h4>
                              </div>
                              <div className="flex items-start gap-2">
                                  <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
                                  <p className="text-sm text-slate-700">
                                      {intakeData.streetAddress}<br />
                                      {intakeData.city}, {intakeData.state} {intakeData.zipCode}
                                  </p>
                              </div>
                          </div>

                          {/* Start Date & Duration */}
                          <div className="grid sm:grid-cols-2 gap-4">
                              <div className="bg-white rounded-xl p-4 border border-slate-200">
                                  <div className="flex items-center gap-2 mb-2">
                                      <Calendar className="w-5 h-5 text-primary-600" />
                                      <h4 className="font-bold text-slate-900">Start Date</h4>
                                  </div>
                                  <p className="text-sm text-slate-700">{intakeData.startDate}</p>
                              </div>
                              <div className="bg-white rounded-xl p-4 border border-slate-200">
                                  <div className="flex items-center gap-2 mb-2">
                                      <Clock className="w-5 h-5 text-primary-600" />
                                      <h4 className="font-bold text-slate-900">Duration</h4>
                                  </div>
                                  <p className="text-sm text-slate-700">{intakeData.duration}</p>
                              </div>
                          </div>

                          {/* Additional Comments */}
                          {intakeData.additionalComments && (
                              <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                                  <h4 className="font-bold text-slate-900 mb-2">Additional Comments</h4>
                                  <p className="text-sm text-slate-600">{intakeData.additionalComments}</p>
                              </div>
                          )}

                          {/* Contact Info */}
                          <div className="bg-white rounded-xl p-4 border border-slate-200">
                              <div className="flex items-center gap-2 mb-3">
                                  <Phone className="w-5 h-5 text-primary-600" />
                                  <h4 className="font-bold text-slate-900">Contact Information</h4>
                              </div>
                              <div className="space-y-1 text-sm">
                                  <p><span className="text-slate-500">Name:</span> {intakeData.contactName}</p>
                                  <p><span className="text-slate-500">Phone:</span> {intakeData.phone}</p>
                                  <p><span className="text-slate-500">Email:</span> {intakeData.email}</p>
                              </div>
                          </div>
                      </div>
                  ) : wizardData ? (
                      <div className="space-y-5">
                          {/* Care Recipient */}
                          {(wizardData.careRecipientFirstName || wizardData.relationship) && (
                            <div className="bg-primary-50 rounded-xl p-4 border border-primary-200">
                              <div className="flex items-center gap-2 mb-3">
                                <User className="w-5 h-5 text-primary-600" />
                                <h4 className="font-bold text-slate-900">Care Recipient</h4>
                              </div>
                              <div className="grid sm:grid-cols-2 gap-3">
                                {(wizardData.careRecipientFirstName || wizardData.careRecipientLastName) && (
                                  <div>
                                    <p className="text-xs text-slate-500">Name</p>
                                    <p className="font-medium text-slate-900">
                                      {wizardData.careRecipientFirstName} {wizardData.careRecipientLastName}
                                    </p>
                                  </div>
                                )}
                                {wizardData.relationship && (
                                  <div>
                                    <p className="text-xs text-slate-500">Relationship</p>
                                    <p className="font-medium text-slate-900 capitalize">{wizardData.relationship}</p>
                                  </div>
                                )}
                                {wizardData.careRecipientAge && (
                                  <div>
                                    <p className="text-xs text-slate-500">Age</p>
                                    <p className="font-medium text-slate-900">{wizardData.careRecipientAge}</p>
                                  </div>
                                )}
                              </div>
                              {wizardData.additionalRecipients?.length > 0 && (
                                <div className="mt-3 pt-3 border-t border-primary-200 space-y-3">
                                  {wizardData.additionalRecipients.map((r: any, i: number) => (
                                    <div key={i} className="grid sm:grid-cols-3 gap-2">
                                      <div>
                                        <p className="text-xs text-slate-500">Person {i + 2}</p>
                                        <p className="font-medium text-slate-900">{r.firstName} {r.lastName}</p>
                                      </div>
                                      {r.relationship && (
                                        <div>
                                          <p className="text-xs text-slate-500">Relationship</p>
                                          <p className="font-medium text-slate-900 capitalize">{r.relationship}</p>
                                        </div>
                                      )}
                                      {r.age && (
                                        <div>
                                          <p className="text-xs text-slate-500">Age</p>
                                          <p className="font-medium text-slate-900">{r.age}</p>
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Care Needs */}
                          {wizardData.careNeeds?.length > 0 && (
                            <div className="bg-white rounded-xl p-4 border border-slate-200">
                              <div className="flex items-center gap-2 mb-3">
                                <Heart className="w-5 h-5 text-primary-600" />
                                <h4 className="font-bold text-slate-900">Care Types Needed</h4>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {wizardData.careNeeds.map((need: string, i: number) => (
                                  <span key={i} className="px-3 py-1.5 bg-primary-50 text-primary-700 text-sm font-medium rounded-lg">
                                    {need}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Schedule */}
                          <div className="bg-white rounded-xl p-4 border border-slate-200">
                            <div className="flex items-center gap-2 mb-3">
                              <Clock className="w-5 h-5 text-primary-600" />
                              <h4 className="font-bold text-slate-900">Schedule</h4>
                            </div>
                            <div className="space-y-2 text-sm">
                              {wizardData.careFrequency && (
                                <p><span className="text-slate-500">Frequency:</span>{' '}
                                  <span className="font-medium text-slate-900 capitalize">{wizardData.careFrequency}</span>
                                </p>
                              )}
                              {wizardData.startDate && (
                                <p><span className="text-slate-500">Start date:</span>{' '}
                                  <span className="font-medium text-slate-900">{wizardData.startDate}</span>
                                </p>
                              )}
                              {wizardData.daysFlexible ? (
                                <p><span className="text-slate-500">Days:</span>{' '}
                                  <span className="font-medium text-slate-900">Flexible</span>
                                </p>
                              ) : wizardData.selectedDays?.length > 0 && (
                                <p><span className="text-slate-500">Days:</span>{' '}
                                  <span className="font-medium text-slate-900">{wizardData.selectedDays.join(', ')}</span>
                                </p>
                              )}
                              {wizardData.timeOfDay?.length > 0 && (
                                <p><span className="text-slate-500">Time of day:</span>{' '}
                                  <span className="font-medium text-slate-900 capitalize">{wizardData.timeOfDay.join(', ')}</span>
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Location */}
                          {(() => {
                            const allLocations: Array<{ street?: string; city?: string; state?: string; zipCode?: string }> = [];
                            if (wizardData.street || wizardData.city) {
                              allLocations.push({ street: wizardData.street, city: wizardData.city, state: wizardData.state, zipCode: wizardData.zipCode });
                            }
                            if (Array.isArray(wizardData.savedLocations)) {
                              wizardData.savedLocations.forEach((loc: any) => {
                                const isDupe = allLocations.some(
                                  l => l.street?.toLowerCase() === loc.street?.toLowerCase() && l.zipCode === loc.zipCode
                                );
                                if (!isDupe && (loc.street || loc.city)) allLocations.push(loc);
                              });
                            }
                            if (allLocations.length === 0) return null;
                            return (
                              <div className="bg-white rounded-xl p-4 border border-slate-200">
                                <div className="flex items-center gap-2 mb-3">
                                  <Home className="w-5 h-5 text-primary-600" />
                                  <h4 className="font-bold text-slate-900">Care Location{allLocations.length > 1 ? 's' : ''}</h4>
                                </div>
                                <div className="flex flex-col gap-3">
                                  {allLocations.map((loc, i) => (
                                    <div key={i} className="flex items-start gap-2">
                                      <MapPin className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                                      <p className="text-sm text-slate-700">
                                        {loc.street && <>{loc.street}<br /></>}
                                        {[loc.city, loc.state, loc.zipCode].filter(Boolean).join(', ')}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}

                          {/* Rate & Payment */}
                          {(wizardData.rate || wizardData.rateFlexible || wizardData.paymentMethod) && (
                            <div className="bg-white rounded-xl p-4 border border-slate-200">
                              <div className="flex items-center gap-2 mb-3">
                                <DollarSign className="w-5 h-5 text-primary-600" />
                                <h4 className="font-bold text-slate-900">Rate & Payment</h4>
                              </div>
                              <div className="space-y-2 text-sm">
                                <p>
                                  <span className="text-slate-500">Hourly rate:</span>{' '}
                                  <span className="font-medium text-slate-900">
                                    {wizardData.rateFlexible ? 'Flexible (depends on experience)' : `$${wizardData.rate}/hr`}
                                  </span>
                                </p>
                                {wizardData.paymentMethod && (
                                  <p>
                                    <span className="text-slate-500">Payment method:</span>{' '}
                                    <span className="font-medium text-slate-900 capitalize">
                                      {wizardData.paymentMethod === 'credit_card' ? 'Credit card' : 'Cash'}
                                    </span>
                                  </p>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Notes */}
                          {wizardData.jobDescription && (
                            <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                              <h4 className="font-bold text-slate-900 mb-2">Notes</h4>
                              <p className="text-sm text-slate-600">{wizardData.jobDescription}</p>
                            </div>
                          )}
                      </div>
                  ) : (
                      <div className="text-center py-8 text-slate-400 bg-slate-50 rounded-xl">
                          <FileText className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                          <p>No care information found.</p>
                          <p className="text-sm mt-1">Complete the care setup to see your care needs here.</p>
                      </div>
                  )}
              </div>
          )}

       </div>
      </div>
    </div>
  );
};
