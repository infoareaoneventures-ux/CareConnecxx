import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Check, Activity } from 'lucide-react';
import firebase from 'firebase/compat/app';
import { auth, db } from '../lib/firebase';
import { useCareConnex } from '../context/CareConnexContext';

const TOTAL_STEPS = 3;

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const TIME_BLOCKS = [
  { id: 'morning', label: 'Morning', time: '6am–12pm' },
  { id: 'afternoon', label: 'Afternoon', time: '12pm–5pm' },
  { id: 'evening', label: 'Evening', time: '5pm–10pm' },
  { id: 'overnight', label: 'Overnight', time: '10pm–6am' },
];

const RELATIONSHIPS = [
  'Self',
  'Parent',
  'Spouse',
  'Sibling',
  'Grandparent',
  'Other',
];

const START_OPTIONS = [
  { id: 'asap', label: 'ASAP' },
  { id: 'fewweeks', label: 'In a few weeks' },
  { id: 'notsure', label: 'Not sure' },
];

const DURATION_OPTIONS = [
  { id: 'longterm', label: 'Long term' },
  { id: 'shortterm', label: 'Short term' },
];

export default function ClientIntakeFlowV2() {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Step 1: Intake Form
  const [intakeData, setIntakeData] = useState({
    careRecipient: {
      firstName: '',
      lastName: '',
      gender: '',
    },
    relationship: '',
    emergencyContact: {
      fullName: '',
      relationship: '',
      phone: '',
    },
    schedule: {} as Record<string, string[]>,
    startDate: '',
    duration: '',
  });

  // Step 2: Lifestyle & Preferences
  const [lifestyleData, setLifestyleData] = useState({
    favoriteActivities: [] as string[],
    activitiesNeedHelp: [] as string[],
    entertainment: [] as string[],
    socialPreferences: {
      enjoysConversation: '',
      prefersQuiet: '',
    },
    familyInArea: {
      hasFamily: '',
      visitFrequency: '',
    },
    friendsVisitors: {
      hasVisitors: '',
      visitFrequency: '',
    },
    pets: {
      hasPets: '',
      petType: '',
      petName: '',
    },
    regularAppointments: {
      hasAppointments: '',
      details: '',
    },
  });

  // Step 3: Tasks & Support
  const [tasksData, setTasksData] = useState({
    adls: [] as string[],
    medicationReminders: [] as string[],
    mealPreparation: [] as string[],
    personalCare: [] as string[],
    householdTasks: [] as string[],
    transportation: [] as string[],
  });

  const updateIntakeField = (section: string, field: string, value: any) => {
    setIntakeData(prev => ({
      ...prev,
      [section]: {
        ...(prev[section as keyof typeof prev] as object),
        [field]: value,
      },
    }));
    setError('');
  };

  const toggleScheduleDay = (day: string, timeBlock: string) => {
    setIntakeData(prev => {
      const currentDaySchedule = prev.schedule[day] || [];
      const newSchedule = { ...prev.schedule };
      
      if (currentDaySchedule.includes(timeBlock)) {
        newSchedule[day] = currentDaySchedule.filter(t => t !== timeBlock);
      } else {
        newSchedule[day] = [...currentDaySchedule, timeBlock];
      }
      
      return { ...prev, schedule: newSchedule };
    });
    setError('');
  };

  const validateStep1 = (): boolean => {
    if (!intakeData.careRecipient.firstName?.trim()) {
      setError('Please enter care recipient first name');
      return false;
    }
    if (!intakeData.careRecipient.lastName?.trim()) {
      setError('Please enter care recipient last name');
      return false;
    }
    if (!intakeData.relationship) {
      setError('Please select your relationship to care recipient');
      return false;
    }
    if (!intakeData.emergencyContact.fullName?.trim()) {
      setError('Please enter emergency contact name');
      return false;
    }
    if (!intakeData.emergencyContact.phone?.trim()) {
      setError('Please enter emergency contact phone');
      return false;
    }
    if (Object.keys(intakeData.schedule).length === 0) {
      setError('Please select at least one day and time for care');
      return false;
    }
    if (!intakeData.startDate) {
      setError('Please select when you need care to start');
      return false;
    }
    if (!intakeData.duration) {
      setError('Please select duration of care needed');
      return false;
    }
    return true;
  };

  const handleNext = () => {
    if (currentStep === 1 && !validateStep1()) {
      return;
    }
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep(prev => prev + 1);
      setError('');
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(prev => prev - 1);
      setError('');
    } else {
      navigate('/client/dashboard');
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError('');

    try {
      const user = auth?.currentUser;
      if (!user) {
        setError('Please sign in to complete intake');
        setIsSubmitting(false);
        return;
      }

      // Save all intake data
      const completeIntakeData = {
        userId: user.uid,
        intake: intakeData,
        lifestyle: lifestyleData,
        tasks: tasksData,
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'completed',
      };

      await db.collection('clientIntakes').doc(user.uid).set(completeIntakeData, { merge: true });
      
      // Update user status
      await db.collection('users').doc(user.uid).update({
        intakeCompleted: true,
        careRecipientName: `${intakeData.careRecipient.firstName} ${intakeData.careRecipient.lastName}`,
      });

      addToast('Intake completed successfully!', 'success');
      navigate('/client/dashboard');
    } catch (err: any) {
      console.error('Intake submission error:', err);
      setError('Failed to save intake. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderStep1 = () => (
    <div className="space-y-6">
      {/* Progress */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium text-primary-600">Step 1 of 3</span>
        </div>
        <div className="flex-1 mx-4 bg-slate-200 rounded-full h-2">
          <div className="bg-primary-500 h-2 rounded-full" style={{ width: '33%' }}></div>
        </div>
      </div>

      <h2 className="text-xl font-bold text-slate-900">Intake Setup</h2>
      <p className="text-slate-600">Tell us about the care needed</p>

      {/* Who Needs Care */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Who Needs Care</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">First Name *</label>
            <input
              type="text"
              value={intakeData.careRecipient.firstName}
              onChange={(e) => updateIntakeField('careRecipient', 'firstName', e.target.value)}
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500"
              placeholder="First name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Last Name *</label>
            <input
              type="text"
              value={intakeData.careRecipient.lastName}
              onChange={(e) => updateIntakeField('careRecipient', 'lastName', e.target.value)}
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500"
              placeholder="Last name"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Gender (Optional)</label>
          <div className="flex gap-4">
            {['Male', 'Female', 'Prefer not to answer'].map((gender) => (
              <label key={gender} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="gender"
                  checked={intakeData.careRecipient.gender === gender}
                  onChange={() => updateIntakeField('careRecipient', 'gender', gender)}
                  className="w-4 h-4 text-primary-600"
                />
                <span className="text-sm text-slate-700">{gender}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Relationship */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Your Relationship *</h3>
        <div className="grid grid-cols-2 gap-3">
          {RELATIONSHIPS.map((rel) => (
            <label
              key={rel}
              className={`flex items-center p-3 rounded-xl border cursor-pointer transition-all ${
                intakeData.relationship === rel
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="relationship"
                checked={intakeData.relationship === rel}
                onChange={() => setIntakeData(prev => ({ ...prev, relationship: rel }))}
                className="w-4 h-4 text-primary-600 mr-3"
              />
              <span className="text-sm font-medium text-slate-700">{rel}</span>
            </label>
          ))}
        </div>
        {intakeData.relationship === 'Other' && (
          <input
            type="text"
            placeholder="Please specify"
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500"
          />
        )}
      </div>

      {/* Emergency Contact */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Emergency Contact *</h3>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Full Name</label>
          <input
            type="text"
            value={intakeData.emergencyContact.fullName}
            onChange={(e) => updateIntakeField('emergencyContact', 'fullName', e.target.value)}
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500"
            placeholder="Full name"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Relationship</label>
          <input
            type="text"
            value={intakeData.emergencyContact.relationship}
            onChange={(e) => updateIntakeField('emergencyContact', 'relationship', e.target.value)}
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500"
            placeholder="e.g., Son, Daughter, Friend"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Phone Number</label>
          <input
            type="tel"
            value={intakeData.emergencyContact.phone}
            onChange={(e) => updateIntakeField('emergencyContact', 'phone', e.target.value)}
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500"
            placeholder="(555) 123-4567"
          />
        </div>
      </div>

      {/* Schedule */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Schedule Needed *</h3>
        <p className="text-sm text-slate-500">Select days and times care is needed</p>
        
        <div className="space-y-3">
          {DAYS.map((day) => (
            <div key={day} className="border border-slate-200 rounded-xl p-4">
              <p className="font-medium text-slate-900 mb-3">{day}</p>
              <div className="grid grid-cols-2 gap-2">
                {TIME_BLOCKS.map((block) => (
                  <label
                    key={block.id}
                    className={`flex items-center p-2 rounded-lg border cursor-pointer transition-all ${
                      (intakeData.schedule[day] || []).includes(block.id)
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={(intakeData.schedule[day] || []).includes(block.id)}
                      onChange={() => toggleScheduleDay(day, block.id)}
                      className="w-4 h-4 text-primary-600 mr-2"
                    />
                    <div className="text-xs">
                      <p className="font-medium text-slate-700">{block.label}</p>
                      <p className="text-slate-500">{block.time}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Start Date */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">When do you need care to start? *</h3>
        <div className="grid grid-cols-3 gap-3">
          {START_OPTIONS.map((option) => (
            <label
              key={option.id}
              className={`flex items-center justify-center p-4 rounded-xl border cursor-pointer transition-all ${
                intakeData.startDate === option.id
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="startDate"
                checked={intakeData.startDate === option.id}
                onChange={() => setIntakeData(prev => ({ ...prev, startDate: option.id }))}
                className="w-4 h-4 text-primary-600 mr-2"
              />
              <span className="text-sm font-medium text-slate-700">{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Duration */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Duration of care needed *</h3>
        <div className="grid grid-cols-2 gap-3">
          {DURATION_OPTIONS.map((option) => (
            <label
              key={option.id}
              className={`flex items-center justify-center p-4 rounded-xl border cursor-pointer transition-all ${
                intakeData.duration === option.id
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="duration"
                checked={intakeData.duration === option.id}
                onChange={() => setIntakeData(prev => ({ ...prev, duration: option.id }))}
                className="w-4 h-4 text-primary-600 mr-2"
              />
              <span className="text-sm font-medium text-slate-700">{option.label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-6">
      {/* Progress */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium text-primary-600">Step 2 of 3</span>
        </div>
        <div className="flex-1 mx-4 bg-slate-200 rounded-full h-2">
          <div className="bg-primary-500 h-2 rounded-full" style={{ width: '66%' }}></div>
        </div>
      </div>

      <h2 className="text-xl font-bold text-slate-900">Lifestyle & Preferences</h2>
      <p className="text-slate-600">Help us understand daily routines and preferences</p>

      {/* Favorite Activities */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Favorite Activities</h3>
        <p className="text-sm text-slate-500">Select all that apply</p>
        <div className="grid grid-cols-2 gap-3">
          {['Walk', 'Reading', 'Cooking', 'Gardening', 'Watching TV', 'Socializing'].map((activity) => (
            <label key={activity} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{activity}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Activities Needing Help */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Activities Needing Help</h3>
        <p className="text-sm text-slate-500">Select all that apply</p>
        <div className="grid grid-cols-2 gap-3">
          {['Going outside', 'Exercise', 'Hobbies', 'Transportation'].map((activity) => (
            <label key={activity} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{activity}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Entertainment */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Entertainment Preferences</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Music', 'Movies', 'TV Shows', 'Theater'].map((item) => (
            <label key={item} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{item}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Social Preferences */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Social Preferences</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-slate-700">Enjoys conversation</span>
            <div className="flex gap-2">
              <button className="px-4 py-2 rounded-lg border border-slate-200 text-sm">No</button>
              <button className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm">Yes</button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-700">Prefers quiet environment</span>
            <div className="flex gap-2">
              <button className="px-4 py-2 rounded-lg border border-slate-200 text-sm">No</button>
              <button className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm">Yes</button>
            </div>
          </div>
        </div>
      </div>

      {/* Family in Area */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Family in the Area</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-slate-700">Has family nearby</span>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg border border-slate-200 text-sm">No</button>
            <button className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm">Yes</button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">How often do they visit?</label>
          <select className="w-full px-4 py-3 border border-slate-200 rounded-xl">
            <option>Select frequency</option>
            <option>Daily</option>
            <option>Weekly</option>
            <option>Monthly</option>
            <option>Rarely</option>
          </select>
        </div>
      </div>

      {/* Friends/Visitors */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Friends & Visitors</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-slate-700">Has regular visitors</span>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg border border-slate-200 text-sm">No</button>
            <button className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm">Yes</button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Visit frequency</label>
          <select className="w-full px-4 py-3 border border-slate-200 rounded-xl">
            <option>Select frequency</option>
            <option>Daily</option>
            <option>Weekly</option>
            <option>Monthly</option>
            <option>Rarely</option>
          </select>
        </div>
      </div>

      {/* Pets */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Pets</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-slate-700">Has pets</span>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg border border-slate-200 text-sm">No</button>
            <button className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm">Yes</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Pet type</label>
            <input type="text" placeholder="e.g., Dog, Cat" className="w-full px-4 py-3 border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Pet name</label>
            <input type="text" placeholder="Pet name" className="w-full px-4 py-3 border border-slate-200 rounded-xl" />
          </div>
        </div>
      </div>

      {/* Regular Appointments */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Regular Appointments</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-slate-700">Has regular appointments</span>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg border border-slate-200 text-sm">No</button>
            <button className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm">Yes</button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Appointment details</label>
          <textarea placeholder="e.g., Doctor visits, therapy sessions" className="w-full px-4 py-3 border border-slate-200 rounded-xl h-24"></textarea>
        </div>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-6">
      {/* Progress */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium text-primary-600">Step 3 of 3</span>
        </div>
        <div className="flex-1 mx-4 bg-slate-200 rounded-full h-2">
          <div className="bg-primary-500 h-2 rounded-full" style={{ width: '100%' }}></div>
        </div>
      </div>

      <h2 className="text-xl font-bold text-slate-900">Tasks & Support</h2>
      <p className="text-slate-600">What assistance is needed?</p>

      {/* ADLs */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Activities of Daily Living</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Ambulation', 'Bathing', 'Dressing', 'Feeding', 'Toileting', 'Transfer Assist'].map((adl) => (
            <label key={adl} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{adl}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Medication */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Medication Reminders</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Morning', 'Afternoon', 'Evening', 'Bedtime'].map((time) => (
            <label key={time} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{time}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Meal Preparation */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Meal Preparation</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Special Diet'].map((meal) => (
            <label key={meal} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{meal}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Personal Care */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Personal Care</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Hair Care', 'Nail Care', 'Oral Care', 'Skin Care', 'Shaving'].map((care) => (
            <label key={care} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{care}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Household Tasks */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Household Tasks</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Light Housekeeping', 'Laundry', 'Meal Prep', 'Shopping', 'Organizing', 'Pet Care'].map((task) => (
            <label key={task} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{task}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Transportation */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <h3 className="font-semibold text-slate-900">Transportation & Errands</h3>
        <div className="grid grid-cols-2 gap-3">
          {['Medical Appointments', 'Grocery Shopping', 'Pharmacy', 'Social Activities'].map((item) => (
            <label key={item} className="flex items-center p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" className="w-4 h-4 text-primary-600 mr-3" />
              <span className="text-sm text-slate-700">{item}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* Header */}
      <header className="bg-white border-b border-slate-100 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={handleBack}
            className="flex items-center text-slate-500 hover:text-slate-700 transition-colors"
          >
            <ChevronLeft className="w-5 h-5 mr-1" />
            Back
          </button>
          <div className="flex items-center space-x-2">
            <div className="bg-primary-600 p-2 rounded-xl">
              <Activity className="text-white w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-slate-900">CareConnex</span>
          </div>
          <div className="w-16"></div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 py-8">
        {currentStep === 1 && renderStep1()}
        {currentStep === 2 && renderStep2()}
        {currentStep === 3 && renderStep3()}
        
        {/* Error */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
            {error}
          </div>
        )}
      </main>

      {/* Bottom Actions */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4">
        <div className="max-w-2xl mx-auto flex gap-4">
          <button
            onClick={handleBack}
            className="flex-1 py-3 border border-slate-300 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={currentStep === 3 ? handleSubmit : handleNext}
            disabled={isSubmitting}
            className="flex-1 py-3 bg-primary-600 rounded-xl font-medium text-white hover:bg-primary-700 transition-colors flex items-center justify-center gap-2"
          >
            {currentStep === 3 ? (isSubmitting ? 'Submitting...' : 'Submit') : 'Continue'}
            {currentStep !== 3 && <ChevronRight className="w-5 h-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
