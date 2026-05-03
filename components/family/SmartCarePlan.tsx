import React, { useState, useEffect } from 'react';
import { FileText, Heart, Pill, Activity, User, Clock, Plus, X, Video, Utensils, Phone, Save, Loader2, Edit3 } from 'lucide-react';
import { Button } from '../ui/Button';
import { dbService } from '../../services/api';
import { AddToastFunction, Medication, EmergencyContact, RoutineTask } from '../../types';

interface SmartCarePlanProps {
  clientId: string;
  onShowToast: AddToastFunction;
  editable?: boolean;
}

interface CarePlanData {
  medicalHistory: {
    conditions: string[];
    allergies: string[];
    surgeries: string[];
    bloodType?: string;
    height?: string;
    weight?: string;
  };
  medications: Medication[];
  preferences: {
    dietaryRestrictions: string[];
    foodLikes: string[];
    foodDislikes: string[];
    sleepSchedule: string;
    showerPreference: 'morning' | 'evening' | 'either';
    socialPreference: 'social' | 'quiet' | 'flexible';
    musicGenres: string[];
    hobbies: string[];
  };
  dailyRoutine: RoutineTask[];
  emergencyContacts: EmergencyContact[];
  videoIntroUrl?: string;
}

const DEFAULT_CARE_PLAN: CarePlanData = {
  medicalHistory: { conditions: [], allergies: [], surgeries: [] },
  medications: [],
  preferences: {
    dietaryRestrictions: [], foodLikes: [], foodDislikes: [],
    sleepSchedule: '10:00 PM - 6:00 AM', showerPreference: 'morning',
    socialPreference: 'flexible', musicGenres: [], hobbies: []
  },
  dailyRoutine: [
    { id: '1', time: '08:00', description: 'Wake up and morning hygiene', category: 'hygiene' },
    { id: '2', time: '09:00', description: 'Breakfast', category: 'meal' },
    { id: '3', time: '10:00', description: 'Morning medication', category: 'medication' },
    { id: '4', time: '12:00', description: 'Lunch', category: 'meal' },
    { id: '5', time: '14:00', description: 'Afternoon activity', category: 'activity' },
    { id: '6', time: '18:00', description: 'Dinner', category: 'meal' },
    { id: '7', time: '21:00', description: 'Evening medication', category: 'medication' }
  ],
  emergencyContacts: []
};

export const SmartCarePlan: React.FC<SmartCarePlanProps> = ({ clientId, onShowToast, editable = true }) => {
  const [carePlan, setCarePlan] = useState<CarePlanData>(DEFAULT_CARE_PLAN);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'medical' | 'routine' | 'preferences'>('overview');
  const [isEditing, setIsEditing] = useState(editable);

  useEffect(() => { loadCarePlan(); }, [clientId]);

  const loadCarePlan = async () => {
    try {
      setLoading(true);
      const data = await dbService.getSmartCarePlan?.(clientId);
      if (data) setCarePlan({ ...DEFAULT_CARE_PLAN, ...data });
    } catch (error) {
      console.error('Failed to load care plan:', error);
    } finally {
      setLoading(false);
    }
  };

  const saveCarePlan = async () => {
    try {
      setSaving(true);
      await dbService.saveSmartCarePlan?.(clientId, carePlan);
      onShowToast('Care plan saved successfully!', 'success');
      setIsEditing(false);
    } catch (error) {
      onShowToast('Failed to save care plan', 'error');
    } finally {
      setSaving(false);
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'meal': return 'bg-accent-100 text-accent-700';
      case 'medication': return 'bg-blue-100 text-blue-700';
      case 'hygiene': return 'bg-primary-100 text-primary-700';
      case 'activity': return 'bg-blue-100 text-blue-700';
      default: return 'bg-slate-100 text-slate-700';
    }
  };

  if (loading) return <div className="flex items-center justify-center p-12"><Loader2 className="w-8 h-8 text-primary-500 animate-spin" /></div>;

  return (
    <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden">
      <div className="bg-gradient-to-r from-primary-600 to-blue-600 p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center">
              <FileText className="w-7 h-7" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">Smart Care Plan</h2>
              <p className="text-primary-100">Comprehensive care profile</p>
            </div>
          </div>
          {editable && (
            <div className="flex items-center gap-3">
              {isEditing ? (
                <>
                  <Button variant="secondary" onClick={() => setIsEditing(false)} className="bg-white/20 text-white border-none">Cancel</Button>
                  <Button onClick={saveCarePlan} disabled={saving} className="bg-white text-primary-600">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-4 h-4 mr-2" /> Save</>}
                  </Button>
                </>
              ) : (
                <Button variant="secondary" onClick={() => setIsEditing(true)} className="bg-white/20 text-white border-none">
                  <Edit3 className="w-4 h-4 mr-2" /> Edit
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-6">
          {(['overview', 'medical', 'routine', 'preferences'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-xl font-medium transition-all ${activeTab === tab ? 'bg-white text-primary-600' : 'bg-white/10 text-white hover:bg-white/20'}`}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-50 p-4 rounded-2xl">
                <Pill className="w-8 h-8 text-blue-500 mb-2" />
                <p className="text-2xl font-bold text-slate-900">{carePlan.medications.length}</p>
                <p className="text-sm text-slate-500">Medications</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-2xl">
                <Clock className="w-8 h-8 text-primary-500 mb-2" />
                <p className="text-2xl font-bold text-slate-900">{carePlan.dailyRoutine.length}</p>
                <p className="text-sm text-slate-500">Daily Tasks</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-2xl">
                <Phone className="w-8 h-8 text-accent-500 mb-2" />
                <p className="text-2xl font-bold text-slate-900">{carePlan.emergencyContacts.length}</p>
                <p className="text-sm text-slate-500">Emergency Contacts</p>
              </div>
              <div className="bg-slate-50 p-4 rounded-2xl">
                <Heart className="w-8 h-8 text-red-500 mb-2" />
                <p className="text-2xl font-bold text-slate-900">{carePlan.medicalHistory.conditions.length}</p>
                <p className="text-sm text-slate-500">Conditions</p>
              </div>
            </div>

            {carePlan.videoIntroUrl ? (
              <div className="bg-slate-900 rounded-2xl overflow-hidden">
                <video src={carePlan.videoIntroUrl} controls className="w-full max-h-64" />
                <div className="p-4"><p className="text-white font-medium">Video Introduction</p></div>
              </div>
            ) : (
              <div className="bg-slate-50 border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center">
                <Video className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                <p className="text-slate-600 font-medium">No Video Introduction</p>
                <p className="text-slate-500 text-sm mb-4">Add a video to help caregivers get to know your loved one</p>
              </div>
            )}

            <div>
              <h3 className="font-bold text-slate-900 mb-4">Today's Routine</h3>
              <div className="space-y-2">
                {carePlan.dailyRoutine.slice(0, 4).map(task => (
                  <div key={task.id} className="flex items-center gap-4 p-3 bg-slate-50 rounded-xl">
                    <span className="font-mono font-semibold text-slate-500 w-14">{task.time}</span>
                    <div className={`p-2 rounded-lg ${getCategoryColor(task.category)}`}>
                      {task.category === 'meal' ? <Utensils className="w-4 h-4" /> : task.category === 'medication' ? <Pill className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                    </div>
                    <span className="flex-1 text-slate-700">{task.description}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'medical' && (
          <div className="space-y-6">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-slate-50 p-4 rounded-xl">
                <p className="font-medium text-slate-700 mb-2">Medical Conditions</p>
                <TagInput values={carePlan.medicalHistory.conditions} onChange={v => setCarePlan(p => ({ ...p, medicalHistory: { ...p.medicalHistory, conditions: v } }))} isEditing={isEditing} placeholder="Add conditions..." />
              </div>
              <div className="bg-slate-50 p-4 rounded-xl">
                <p className="font-medium text-slate-700 mb-2">Allergies</p>
                <TagInput values={carePlan.medicalHistory.allergies} onChange={v => setCarePlan(p => ({ ...p, medicalHistory: { ...p.medicalHistory, allergies: v } }))} isEditing={isEditing} placeholder="Add allergies..." />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'routine' && (
          <div className="space-y-3">
            {carePlan.dailyRoutine.sort((a,b) => a.time.localeCompare(b.time)).map((task, index) => (
              <div key={task.id} className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl">
                {isEditing ? (
                  <>
                    <input
                      type="time"
                      value={task.time}
                      onChange={e => {
                        const newRoutine = [...carePlan.dailyRoutine];
                        newRoutine[index] = { ...task, time: e.target.value };
                        setCarePlan(p => ({ ...p, dailyRoutine: newRoutine }));
                      }}
                      className="font-mono font-semibold text-slate-700 w-20 p-1 border border-slate-300 rounded"
                    />
                    <select
                      value={task.category}
                      onChange={e => {
                        const newRoutine = [...carePlan.dailyRoutine];
                        newRoutine[index] = { ...task, category: e.target.value as RoutineTask['category'] };
                        setCarePlan(p => ({ ...p, dailyRoutine: newRoutine }));
                      }}
                      className="p-1 border border-slate-300 rounded text-sm"
                    >
                      <option value="meal">Meal</option>
                      <option value="medication">Medication</option>
                      <option value="hygiene">Hygiene</option>
                      <option value="activity">Activity</option>
                      <option value="other">Other</option>
                    </select>
                    <input
                      type="text"
                      value={task.description}
                      onChange={e => {
                        const newRoutine = [...carePlan.dailyRoutine];
                        newRoutine[index] = { ...task, description: e.target.value };
                        setCarePlan(p => ({ ...p, dailyRoutine: newRoutine }));
                      }}
                      className="flex-1 p-1 border border-slate-300 rounded text-slate-700"
                    />
                    <button
                      onClick={() => {
                        const newRoutine = carePlan.dailyRoutine.filter((_, i) => i !== index);
                        setCarePlan(p => ({ ...p, dailyRoutine: newRoutine }));
                      }}
                      className="text-red-500 hover:text-red-700"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="font-mono font-semibold text-slate-500 w-16">{task.time}</span>
                    <div className={`p-2 rounded-lg ${getCategoryColor(task.category)}`}>
                      {task.category === 'meal' ? <Utensils className="w-4 h-4" /> : task.category === 'medication' ? <Pill className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                    </div>
                    <span className="flex-1 text-slate-700">{task.description}</span>
                  </>
                )}
              </div>
            ))}
            {isEditing && (
              <Button
                variant="secondary"
                onClick={() => {
                  const newTask: RoutineTask = {
                    id: Date.now().toString(),
                    time: '12:00',
                    description: 'New task',
                    category: 'activity'
                  };
                  setCarePlan(p => ({ ...p, dailyRoutine: [...p.dailyRoutine, newTask] }));
                }}
                className="w-full mt-4"
              >
                <Plus className="w-4 h-4 mr-2" /> Add Task
              </Button>
            )}
          </div>
        )}

        {activeTab === 'preferences' && (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-slate-50 p-4 rounded-xl">
              <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><Utensils className="w-4 h-4 text-accent-500" /> Dietary</h4>
              <TagInput values={carePlan.preferences.dietaryRestrictions} onChange={v => setCarePlan(p => ({ ...p, preferences: { ...p.preferences, dietaryRestrictions: v } }))} isEditing={isEditing} placeholder="Add restrictions..." />
            </div>
            <div className="bg-slate-50 p-4 rounded-xl">
              <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><User className="w-4 h-4 text-primary-500" /> Hobbies</h4>
              <TagInput values={carePlan.preferences.hobbies} onChange={v => setCarePlan(p => ({ ...p, preferences: { ...p.preferences, hobbies: v } }))} isEditing={isEditing} placeholder="Add hobbies..." />
            </div>
            <div className="bg-slate-50 p-4 rounded-xl">
              <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-blue-500" /> Sleep Schedule</h4>
              {isEditing ? (
                <input
                  type="text"
                  value={carePlan.preferences.sleepSchedule}
                  onChange={e => setCarePlan(p => ({ ...p, preferences: { ...p.preferences, sleepSchedule: e.target.value } }))}
                  placeholder="e.g., 10:00 PM - 6:00 AM"
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                />
              ) : (
                <p className="text-slate-700">{carePlan.preferences.sleepSchedule || 'Not specified'}</p>
              )}
            </div>
            <div className="bg-slate-50 p-4 rounded-xl">
              <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-blue-500" /> Shower Preference</h4>
              {isEditing ? (
                <select
                  value={carePlan.preferences.showerPreference}
                  onChange={e => setCarePlan(p => ({ ...p, preferences: { ...p.preferences, showerPreference: e.target.value as CarePlanData['preferences']['showerPreference'] } }))}
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                >
                  <option value="morning">Morning</option>
                  <option value="evening">Evening</option>
                  <option value="either">Either</option>
                </select>
              ) : (
                <p className="text-slate-700 capitalize">{carePlan.preferences.showerPreference}</p>
              )}
            </div>
            <div className="bg-slate-50 p-4 rounded-xl">
              <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2"><Heart className="w-4 h-4 text-red-500" /> Social Preference</h4>
              {isEditing ? (
                <select
                  value={carePlan.preferences.socialPreference}
                  onChange={e => setCarePlan(p => ({ ...p, preferences: { ...p.preferences, socialPreference: e.target.value as CarePlanData['preferences']['socialPreference'] } }))}
                  className="w-full p-2 border border-slate-300 rounded-lg text-sm"
                >
                  <option value="social">Social</option>
                  <option value="quiet">Quiet</option>
                  <option value="flexible">Flexible</option>
                </select>
              ) : (
                <p className="text-slate-700 capitalize">{carePlan.preferences.socialPreference}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Tag Input Component
const TagInput: React.FC<{ values: string[]; onChange: (v: string[]) => void; isEditing: boolean; placeholder: string }> = ({ values, onChange, isEditing, placeholder }) => {
  const [input, setInput] = useState('');
  
  if (!isEditing) {
    return (
      <div className="flex flex-wrap gap-2">
        {values.length > 0 ? values.map((v, i) => <span key={i} className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm">{v}</span>) : <span className="text-slate-400 text-sm">None listed</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {values.map((v, i) => (
        <span key={i} className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm flex items-center gap-1">
          {v}
          <button onClick={() => onChange(values.filter((_, idx) => idx !== i))}><X className="w-3 h-3" /></button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && input.trim()) {
            onChange([...values, input.trim()]);
            setInput('');
          }
        }}
        placeholder={placeholder}
        className="px-3 py-1 border border-slate-200 rounded-full text-sm focus:ring-2 focus:ring-primary-500 outline-none"
      />
    </div>
  );
};

export default SmartCarePlan;
