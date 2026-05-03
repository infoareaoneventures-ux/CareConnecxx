import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ChevronLeft, Check } from 'lucide-react';
import firebase from 'firebase/compat/app';
import { auth, db } from '../lib/firebase';
import { ClientIntakeData } from '../types';
import { useCareConnex } from '../context/CareConnexContext';

const TOTAL_STEPS = 8;

const CARE_TYPES = [
  { id: 'bathing', label: 'Bathing, dressing, toileting, transferring (between bed, chair, etc.)' },
  { id: 'continence', label: 'Continence (bladder/bowel control)' },
  { id: 'feeding', label: 'Feeding (bringing food to mouth and eating)' },
  { id: 'medication', label: 'Medications (organizing and taking doses)' },
  { id: 'mealprep', label: 'Meal prep' },
  { id: 'housekeeping', label: 'Housekeeping' },
  { id: 'transportation', label: 'Transportation' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'memory', label: 'Memory Care' },
  { id: 'companionship', label: 'Companionship' },
  { id: 'other', label: 'Other' },
];

const RELATIONSHIPS = [
  'Self',
  'Parent',
  'Spouse',
  'Sibling',
  'Grandparent',
  'Other family member',
  'Friend',
  'Other',
];

const SCHEDULE_OPTIONS = [
  { id: 'part-time', label: 'Part-time', description: 'A few hours per week' },
  { id: 'full-time', label: 'Full-time', description: 'Regular daily care' },
  { id: 'live-in', label: 'Live-in', description: '24/7 care in the home' },
  { id: 'overnight', label: 'Overnight', description: 'Nighttime care only' },
  { id: 'weekends', label: 'Weekends only', description: 'Saturday & Sunday' },
];

const START_OPTIONS = [
  { id: 'asap', label: 'ASAP' },
  { id: '1week', label: 'In a week' },
  { id: 'fewweeks', label: 'In a few weeks' },
  { id: 'notsure', label: 'Not sure' },
];

const DURATION_OPTIONS = [
  { id: 'ongoing', label: 'Ongoing', description: 'Long-term care' },
  { id: '1-2weeks', label: '1-2 weeks', description: 'Short-term respite' },
  { id: '1month', label: '1 month', description: 'Temporary recovery' },
  { id: '3months', label: '3 months', description: 'Extended care' },
  { id: '6months', label: '6 months', description: 'Medium-term care' },
  { id: 'unsure', label: 'Not sure yet', description: 'We\'ll help you decide' },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface TimeSlot {
  start: string;
  end: string;
}

export default function ClientIntakeFlow() {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  
  const [formData, setFormData] = useState<Partial<ClientIntakeData>>({
    careTypes: [],
  });
  const [scheduleType, setScheduleType] = useState<'flexible' | 'fixed' | null>(null);
  const [weeklySchedule, setWeeklySchedule] = useState<Record<string, TimeSlot[]>>({});
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [newSlotStart, setNewSlotStart] = useState('09:00');
  const [newSlotEnd, setNewSlotEnd] = useState('17:00');

  const updateField = (field: keyof ClientIntakeData, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setError('');
  };

  const toggleCareType = (careType: string) => {
    setFormData(prev => {
      const current = prev.careTypes || [];
      if (current.includes(careType)) {
        return { ...prev, careTypes: current.filter(c => c !== careType) };
      }
      return { ...prev, careTypes: [...current, careType] };
    });
    setError('');
  };

  const addTimeSlot = (day: string) => {
    if (newSlotStart >= newSlotEnd) {
      setError('End time must be after start time');
      return;
    }
    setWeeklySchedule(prev => {
      const current = prev[day] || [];
      return { ...prev, [day]: [...current, { start: newSlotStart, end: newSlotEnd }] };
    });
    setEditingDay(null);
    setError('');
  };

  const removeTimeSlot = (day: string, index: number) => {
    setWeeklySchedule(prev => {
      const current = prev[day] || [];
      return { ...prev, [day]: current.filter((_, i) => i !== index) };
    });
  };

  const formatTime = (time: string) => {
    const [hours, minutes] = time.split(':');
    const hour = parseInt(hours, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  const getTotalTimeSlots = () => {
    return Object.values(weeklySchedule).reduce((total, slots) => total + slots.length, 0);
  };

  const validateStep = (): boolean => {
    switch (currentStep) {
      case 1:
        if (!formData.recipientFirstName?.trim()) {
          setError('Please enter the care recipient\'s first name');
          return false;
        }
        if (!formData.recipientLastName?.trim()) {
          setError('Please enter the care recipient\'s last name');
          return false;
        }
        if (!formData.relationship) {
          setError('Please select who the care is for');
          return false;
        }
        break;
      case 2:
        if (!formData.careTypes?.length) {
          setError('Please select at least one type of care');
          return false;
        }
        break;
      case 3:
        if (!scheduleType) {
          setError('Please select a schedule type');
          return false;
        }
        if (getTotalTimeSlots() === 0) {
          setError('Please add at least one time slot');
          return false;
        }
        break;
      case 4:
        if (!formData.startDate) {
          setError('Please select when care should start');
          return false;
        }
        break;
      case 5:
        if (!formData.duration) {
          setError('Please select a duration');
          return false;
        }
        break;
      case 6:
        if (!formData.streetAddress?.trim()) {
          setError('Please enter the street address');
          return false;
        }
        if (!formData.city?.trim()) {
          setError('Please enter the city');
          return false;
        }
        if (!formData.state?.trim()) {
          setError('Please enter the state');
          return false;
        }
        if (!formData.zipCode?.trim()) {
          setError('Please enter your ZIP code');
          return false;
        }
        if (!/^\d{5}(-\d{4})?$/.test(formData.zipCode)) {
          setError('Please enter a valid ZIP code');
          return false;
        }
        break;
      case 8:
        if (!formData.contactName?.trim()) {
          setError('Please enter your full name');
          return false;
        }
        if (!formData.phone?.trim()) {
          setError('Please enter your phone number');
          return false;
        }
        if (!formData.email?.trim()) {
          setError('Please enter your email');
          return false;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
          setError('Please enter a valid email');
          return false;
        }
        if (!formData.password || formData.password.length < 8) {
          setError('Password must be at least 8 characters');
          return false;
        }
        if (formData.password !== formData.confirmPassword) {
          setError('Passwords do not match');
          return false;
        }
        break;
    }
    return true;
  };

  const handleNext = () => {
    if (validateStep()) {
      // Pre-fill contact name if relationship is "Self" and we're moving to step 9
      if (currentStep === 8 && formData.relationship === 'Self' && !formData.contactName) {
        setFormData(prev => ({ ...prev, contactName: prev.recipientName }));
      }
      setCurrentStep(prev => Math.min(prev + 1, TOTAL_STEPS));
      setError('');
    }
  };

  const handleBack = () => {
    setCurrentStep(prev => Math.max(prev - 1, 1));
    setError('');
  };

  const handleSubmit = async () => {
    if (!validateStep()) return;
    
    setIsSubmitting(true);
    setError('');

    try {
      if (!auth || !db) {
        setError('Firebase not initialized. Please refresh and try again.');
        setIsSubmitting(false);
        return;
      }

      const userCredential = await auth.createUserWithEmailAndPassword(
        formData.email!,
        formData.password!
      );

      const user = userCredential.user;

      if (!user) {
        throw new Error('Failed to create user');
      }

      await user.updateProfile({
        displayName: formData.contactName,
      });

      const intakeData: ClientIntakeData = {
        recipientName: `${formData.recipientFirstName} ${formData.recipientLastName}`,
        recipientFirstName: formData.recipientFirstName!,
        recipientLastName: formData.recipientLastName!,
        relationship: formData.relationship!,
        careTypes: formData.careTypes!,
        streetAddress: formData.streetAddress!,
        city: formData.city!,
        state: formData.state!,
        zipCode: formData.zipCode!,
        schedule: scheduleType === 'flexible' ? 'Flexible Schedule' : 'Fixed Schedule',
        weeklySchedule: weeklySchedule,
        startDate: formData.startDate!,
        duration: formData.duration!,
        additionalComments: formData.additionalComments || '',
        contactName: formData.contactName!,
        phone: formData.phone!,
        email: formData.email!,
        userId: user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
      };

      await db.collection('clientIntakes').doc(user.uid).set(intakeData);

      await db.collection('users').doc(user.uid).set({
        uid: user.uid,
        email: formData.email,
        displayName: formData.contactName,
        phone: formData.phone,
        role: 'client',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        intakeCompleted: true,
      });

      // Show success message and redirect to dashboard
      addToast('Welcome to CareConnex! Your care coordinator will reach out within 24 hours.', 'success');
      navigate('/client/dashboard', { replace: true });
    } catch (err: any) {
      console.error('Error creating account:', err);
      if (err.code === 'auth/email-already-in-use') {
        setError('An account with this email already exists. Please sign in instead.');
      } else if (err.code === 'auth/invalid-email') {
        setError('Invalid email address. Please check and try again.');
      } else if (err.code === 'auth/weak-password') {
        setError('Password is too weak. Please use at least 8 characters.');
      } else if (err.code === 'auth/network-request-failed') {
        setError('Network error. Please check your connection and try again.');
      } else if (err.message) {
        setError(`Error: ${err.message}`);
      } else {
        setError('Failed to create account. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStepTitle = () => {
    switch (currentStep) {
      case 1: return 'Who needs care?';
      case 2: return 'What care is needed?';
      case 3: return 'When will care be needed?';
      case 4: return 'When should care start?';
      case 5: return 'How long is care needed?';
      case 6: return 'Where is care needed?';
      case 7: return 'Anything else to share?';
      case 8: return 'Create your account';
      default: return '';
    }
  };

  const getStepSubtitle = () => {
    switch (currentStep) {
      case 1: return 'We\'ll use this to personalize your care plan.';
      case 2: return 'Select all that apply. You can always adjust later.';
      case 3: return 'Indicate when care will be needed by clicking the corresponding day/time periods below.';
      case 4: return 'When would you like care to begin?';
      case 5: return 'This helps us find caregivers available for your timeframe.';
      case 6: return 'Enter the full address where care will be provided.';
      case 7: return 'Share any details that will help us match the right caregiver.';
      case 8: return 'Set up your profile to track your inquiry and connect with caregivers.';
      default: return '';
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            {/* Name Fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">First Name</label>
                <input
                  type="text"
                  value={formData.recipientFirstName || ''}
                  onChange={(e) => updateField('recipientFirstName', e.target.value)}
                  placeholder="e.g., Mary"
                  className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Last Name</label>
                <input
                  type="text"
                  value={formData.recipientLastName || ''}
                  onChange={(e) => updateField('recipientLastName', e.target.value)}
                  placeholder="e.g., Johnson"
                  className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
            </div>

            {/* Relationship Dropdown */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-3">Who's the care for?</label>
              <div className="space-y-2">
                {RELATIONSHIPS.map((rel) => (
                  <button
                    key={rel}
                    onClick={() => updateField('relationship', rel)}
                    className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                      formData.relationship === rel
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-slate-100 hover:border-slate-200'
                    }`}
                  >
                    <span className="font-medium text-slate-900">{rel}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-2">
            {CARE_TYPES.map((careType, index) => (
              <button
                key={careType.id}
                onClick={() => toggleCareType(careType.label)}
                className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                  formData.careTypes?.includes(careType.label)
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="flex items-center">
                  <div className={`w-6 h-6 rounded border-2 flex items-center justify-center mr-3 flex-shrink-0 ${
                    formData.careTypes?.includes(careType.label)
                      ? 'bg-blue-500 border-blue-500'
                      : 'border-slate-300'
                  }`}>
                    {formData.careTypes?.includes(careType.label) && (
                      <Check className="w-4 h-4 text-white" />
                    )}
                  </div>
                  <span className="font-medium text-slate-900">{careType.label}</span>
                </div>
              </button>
            ))}
          </div>
        );

      case 3:
        return (
          <div className="space-y-6">
            {/* Schedule Type Selection */}
            <div className="space-y-3">
              <div
                onClick={() => setScheduleType('flexible')}
                className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${scheduleType === 'flexible'
                  ? 'bg-blue-50 border-blue-500'
                  : 'bg-white border-slate-200 hover:border-blue-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 ${scheduleType === 'flexible' ? 'border-blue-500' : 'border-slate-300'}`}>
                    {scheduleType === 'flexible' && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                  </div>
                  <div className="flex-1">
                    <p className={`font-semibold ${scheduleType === 'flexible' ? 'text-blue-700' : 'text-slate-900'}`}>
                      Flexible Schedule
                    </p>
                    <p className="text-sm text-slate-500 mt-1">
                      I need a certain amount of help that can be provided at various times throughout the week.
                    </p>
                  </div>
                </div>
              </div>

              <div
                onClick={() => setScheduleType('fixed')}
                className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${scheduleType === 'fixed'
                  ? 'bg-blue-50 border-blue-500'
                  : 'bg-white border-slate-200 hover:border-blue-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 ${scheduleType === 'fixed' ? 'border-blue-500' : 'border-slate-300'}`}>
                    {scheduleType === 'fixed' && <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />}
                  </div>
                  <div className="flex-1">
                    <p className={`font-semibold ${scheduleType === 'fixed' ? 'text-blue-700' : 'text-slate-900'}`}>
                      Fixed Schedule
                    </p>
                    <p className="text-sm text-slate-500 mt-1">
                      I require a caregiver to be present at specific time periods throughout the day or week.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Weekly Schedule - Adjustable Time Slots */}
            {scheduleType && (
              <div className="animate-slide-in">
                <p className="text-sm text-slate-600 mb-4">
                  <span className="font-medium">Weekly Schedule:</span> Add custom time slots for each day when care is needed.
                </p>

                {/* Days Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {DAYS.map(day => {
                    const daySlots = weeklySchedule[day] || [];
                    const isEditing = editingDay === day;
                    
                    return (
                      <div key={day} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                        {/* Day Header */}
                        <div className="bg-blue-50 px-4 py-3 border-b border-slate-200">
                          <span className="font-semibold text-blue-700">{day}</span>
                          {daySlots.length > 0 && (
                            <span className="ml-2 text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">
                              {daySlots.length} slot{daySlots.length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        
                        {/* Time Slots List */}
                        <div className="p-3 space-y-2">
                          {daySlots.length === 0 && !isEditing && (
                            <p className="text-sm text-slate-400 italic">No time slots added</p>
                          )}
                          
                          {daySlots.map((slot, index) => (
                            <div key={index} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
                              <span className="text-sm font-medium text-slate-700">
                                {formatTime(slot.start)} - {formatTime(slot.end)}
                              </span>
                              <button
                                onClick={() => removeTimeSlot(day, index)}
                                className="text-slate-400 hover:text-red-500 transition-colors"
                                aria-label="Remove time slot"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ))}
                          
                          {/* Add Time Slot Form */}
                          {isEditing ? (
                            <div className="space-y-3 pt-2 border-t border-slate-100">
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="block text-xs font-medium text-slate-600 mb-1">Start</label>
                                  <input
                                    type="time"
                                    value={newSlotStart}
                                    onChange={(e) => setNewSlotStart(e.target.value)}
                                    className="w-full px-2 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-slate-600 mb-1">End</label>
                                  <input
                                    type="time"
                                    value={newSlotEnd}
                                    onChange={(e) => setNewSlotEnd(e.target.value)}
                                    className="w-full px-2 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                  />
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => addTimeSlot(day)}
                                  className="flex-1 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                  Add
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingDay(null);
                                    setError('');
                                  }}
                                  className="flex-1 py-2 bg-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-300 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingDay(day);
                                setNewSlotStart('09:00');
                                setNewSlotEnd('17:00');
                              }}
                              className="w-full py-2 mt-2 border-2 border-dashed border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors flex items-center justify-center gap-1"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                              Add Time Slot
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Selected Summary */}
                <div className="mt-4 p-3 bg-slate-50 rounded-lg">
                  <p className="text-sm text-slate-600">
                    <span className="font-medium">Selected:</span> {getTotalTimeSlots()} time slot{getTotalTimeSlots() !== 1 ? 's' : ''} across {Object.keys(weeklySchedule).filter(d => weeklySchedule[d]?.length > 0).length} day{Object.keys(weeklySchedule).filter(d => weeklySchedule[d]?.length > 0).length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
            )}
          </div>
        );

      case 4:
        return (
          <div className="space-y-3">
            {START_OPTIONS.map((option, index) => {
              const letter = String.fromCharCode(65 + index); // A, B, C, D
              return (
                <button
                  key={option.id}
                  onClick={() => updateField('startDate', option.label)}
                  className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                    formData.startDate === option.label
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-slate-100 hover:border-slate-200'
                  }`}
                >
                  <span className="font-medium text-slate-900">{letter}: {option.label}</span>
                </button>
              );
            })}
          </div>
        );

      case 6:
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Street Address
              </label>
              <input
                type="text"
                value={formData.streetAddress || ''}
                onChange={(e) => updateField('streetAddress', e.target.value)}
                placeholder="e.g., 123 Main Street, Apt 4B"
                className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  City
                </label>
                <input
                  type="text"
                  value={formData.city || ''}
                  onChange={(e) => updateField('city', e.target.value)}
                  placeholder="e.g., San Jose"
                  className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  State
                </label>
                <input
                  type="text"
                  value={formData.state || ''}
                  onChange={(e) => updateField('state', e.target.value)}
                  placeholder="e.g., CA"
                  maxLength={2}
                  className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                ZIP Code
              </label>
              <input
                type="text"
                value={formData.zipCode || ''}
                onChange={(e) => updateField('zipCode', e.target.value)}
                placeholder="e.g., 90210"
                maxLength={10}
                className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
          </div>
        );

      case 5:
        return (
          <div className="space-y-3">
            {DURATION_OPTIONS.map((duration) => (
              <button
                key={duration.id}
                onClick={() => updateField('duration', duration.label)}
                className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                  formData.duration === duration.label
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="font-medium text-slate-900">{duration.label}</div>
                <div className="text-sm text-slate-500">{duration.description}</div>
              </button>
            ))}
          </div>
        );

      case 7:
        return (
          <div className="space-y-4">
            <textarea
              value={formData.additionalComments || ''}
              onChange={(e) => updateField('additionalComments', e.target.value)}
              placeholder="e.g., Mary has early-stage dementia and prefers a caregiver who speaks Spanish. She's most active in the mornings..."
              rows={6}
              className="w-full px-4 py-4 text-lg border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none"
            />
            <p className="text-sm text-slate-500">
              This is optional — you can always add more details later.
            </p>
          </div>
        );

      case 8:
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Full Name
              </label>
              <input
                type="text"
                value={formData.contactName || ''}
                onChange={(e) => updateField('contactName', e.target.value)}
                placeholder="Your full name"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Phone Number
              </label>
              <input
                type="tel"
                value={formData.phone || ''}
                onChange={(e) => updateField('phone', e.target.value)}
                placeholder="(555) 123-4567"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Email
              </label>
              <input
                type="email"
                value={formData.email || ''}
                onChange={(e) => updateField('email', e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Create Password
              </label>
              <input
                type="password"
                value={formData.password || ''}
                onChange={(e) => updateField('password', e.target.value)}
                placeholder="At least 8 characters"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Confirm Password
              </label>
              <input
                type="password"
                value={formData.confirmPassword || ''}
                onChange={(e) => updateField('confirmPassword', e.target.value)}
                placeholder="Confirm your password"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-blue-600 p-2 rounded-xl">
              <Activity className="text-white w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-slate-900">CareConnex</span>
          </div>
          <div className="text-sm text-slate-500">
            Step {currentStep} of {TOTAL_STEPS}
          </div>
        </div>
      </header>

      {/* Progress Bar */}
      <div className="bg-white border-b border-slate-100">
        <div className="max-w-lg mx-auto">
          <div className="flex">
            {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
              <div
                key={index}
                className={`flex-1 h-1 transition-all duration-300 ${
                  index < currentStep ? 'bg-blue-500' : 'bg-slate-100'
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-4 py-8">
        {/* Back Button */}
        {currentStep > 1 && (
          <button
            onClick={handleBack}
            className="flex items-center text-slate-500 hover:text-slate-700 mb-6 transition-colors"
          >
            <ChevronLeft className="w-5 h-5 mr-1" />
            Back
          </button>
        )}

        {/* Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            {getStepTitle()}
          </h1>
          <p className="text-slate-600">
            {getStepSubtitle()}
          </p>
        </div>

        {/* Form */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          {renderStep()}

          {/* Error Message */}
          {error && (
            <div className="mt-4 p-4 bg-red-50 border border-red-100 rounded-xl">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="mt-8">
          {currentStep < TOTAL_STEPS ? (
            <button
              onClick={handleNext}
              className="w-full py-4 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition-colors shadow-lg shadow-blue-200"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="w-full py-4 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition-colors shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {isSubmitting ? (
                <>
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                  Creating Account...
                </>
              ) : (
                <>
                  <Check className="w-5 h-5 mr-2" />
                  Create Account
                </>
              )}
            </button>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-slate-500 mt-6">
          Already have an account?{' '}
          <a href="/login" className="text-blue-600 hover:underline font-medium">
            Sign in
          </a>
        </p>
      </main>
    </div>
  );
}
