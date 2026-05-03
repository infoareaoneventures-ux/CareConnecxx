import React, { useState, useEffect } from 'react';
import { Button } from '../ui/Button';
import { 
  Check, 
  ChevronRight, 
  Clock, 
  Calendar, 
  Phone, 
  FileText,
  X
} from 'lucide-react';
import { ClientIntakeData } from '../../types';
import { db } from '../../lib/firebase';

interface IntakeModalProps {
  isOpen: boolean;
  onClose: () => void;
  intakeData: ClientIntakeData | null;
  userId: string;
  onComplete: () => void;
}

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

export const IntakeModal: React.FC<IntakeModalProps> = ({
  isOpen,
  onClose,
  intakeData,
  userId,
  onComplete
}) => {
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  
  // Form state
  const [phone, setPhone] = useState('');
  const [schedule, setSchedule] = useState('');
  const [startDate, setStartDate] = useState('');
  const [duration, setDuration] = useState('');

  // Load data from intakeData when modal opens
  useEffect(() => {
    if (isOpen && intakeData) {
      setPhone(intakeData.phone || '');
      setSchedule(intakeData.schedule || '');
      setStartDate(intakeData.startDate || '');
      setDuration(intakeData.duration || '');
      setCurrentStep(0);
      setSaveError(null);
    }
  }, [isOpen, intakeData]);

  // Define steps
  const steps = [
    {
      id: 'overview',
      title: 'Complete Your Intake',
      description: 'Fill in the remaining details',
    },
    {
      id: 'phone',
      title: 'Phone Number',
      description: 'So caregivers can reach you',
      icon: <Phone className="w-5 h-5" />,
      isComplete: !!phone,
      value: phone,
      onChange: setPhone,
      render: () => (
        <div className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Phone Number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            autoFocus
          />
        </div>
      )
    },
    {
      id: 'schedule',
      title: 'Schedule',
      description: 'When do you need care?',
      icon: <Clock className="w-5 h-5" />,
      isComplete: !!schedule && schedule !== 'Flexible Schedule',
      value: schedule,
      onChange: setSchedule,
      render: () => (
        <div className="space-y-3">
          {SCHEDULE_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                setSchedule(option.label);
              }}
              className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                schedule === option.label
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-blue-300'
              }`}
            >
              <div className="font-medium text-slate-900">{option.label}</div>
              <div className="text-sm text-slate-500">{option.description}</div>
            </button>
          ))}
        </div>
      )
    },
    {
      id: 'startDate',
      title: 'Start Date',
      description: 'When should care begin?',
      icon: <Calendar className="w-5 h-5" />,
      isComplete: !!startDate && startDate !== 'ASAP',
      value: startDate,
      onChange: setStartDate,
      render: () => (
        <div className="space-y-3">
          {START_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                setStartDate(option.label);
              }}
              className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                startDate === option.label
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-blue-300'
              }`}
            >
              <div className="font-medium text-slate-900">{option.label}</div>
            </button>
          ))}
        </div>
      )
    },
    {
      id: 'duration',
      title: 'Duration',
      description: 'How long is care needed?',
      icon: <FileText className="w-5 h-5" />,
      isComplete: !!duration && duration !== 'Ongoing',
      value: duration,
      onChange: setDuration,
      render: () => (
        <div className="space-y-3">
          {DURATION_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                setDuration(option.label);
              }}
              className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                duration === option.label
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-blue-300'
              }`}
            >
              <div className="font-medium text-slate-900">{option.label}</div>
              <div className="text-sm text-slate-500">{option.description}</div>
            </button>
          ))}
        </div>
      )
    },
  ];

  const completedCount = steps.slice(1).filter(s => s.isComplete).length;
  const totalSteps = steps.length - 1;
  const progress = (completedCount / totalSteps) * 100;
  const allComplete = steps.slice(1).every(s => s.isComplete);

  const handleSave = async () => {
    const currentStepData = steps[currentStep];
    if (!currentStepData || currentStep === 0) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      if (!db || !userId) {
        throw new Error('Database not available');
      }

      // Build update data
      const updateData: any = {
        updatedAt: new Date().toISOString()
      };

      if (currentStepData.id === 'phone') updateData.phone = phone;
      if (currentStepData.id === 'schedule') updateData.schedule = schedule;
      if (currentStepData.id === 'startDate') updateData.startDate = startDate;
      if (currentStepData.id === 'duration') updateData.duration = duration;

      console.log('Saving intake:', { step: currentStepData.id, updateData });

      // Save to Firestore
      await db.collection('clientIntakes').doc(userId).update(updateData);
      console.log('Save successful');

      // Go back to overview
      setCurrentStep(0);

    } catch (error: any) {
      console.error('Save failed:', error);
      setSaveError(error.message || 'Failed to save. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleComplete = async () => {
    setIsSaving(true);
    try {
      if (!db || !userId) {
        throw new Error('Database not available');
      }

      // Save all current values
      await db.collection('clientIntakes').doc(userId).update({
        phone,
        schedule,
        startDate,
        duration,
        status: 'pending',
        updatedAt: new Date().toISOString()
      });

      // Mark user as completed intake
      await db.collection('users').doc(userId).update({
        intakeCompleted: true
      });

      onComplete();
      onClose();
    } catch (error: any) {
      console.error('Complete failed:', error);
      setSaveError(error.message || 'Failed to complete. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {currentStep === 0 ? 'Complete Your Intake' : steps[currentStep].title}
            </h2>
            <p className="text-sm text-slate-500">
              {currentStep === 0 
                ? `${completedCount} of ${totalSteps} completed`
                : steps[currentStep].description
              }
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="px-6 pt-4">
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div 
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {saveError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {saveError}
            </div>
          )}

          {currentStep === 0 ? (
            // Overview - List all steps
            <div className="space-y-3">
              {steps.slice(1).map((step, index) => (
                <button
                  key={step.id}
                  onClick={() => setCurrentStep(index + 1)}
                  className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left ${
                    step.isComplete
                      ? 'border-green-200 bg-green-50'
                      : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    step.isComplete ? 'bg-green-100' : 'bg-slate-100'
                  }`}>
                    {step.isComplete ? (
                      <Check className="w-5 h-5 text-green-600" />
                    ) : (
                      <span className="text-slate-500">{step.icon}</span>
                    )}
                  </div>
                  <div className="flex-1">
                    <h3 className={`font-medium ${step.isComplete ? 'text-green-900' : 'text-slate-900'}`}>
                      {step.title}
                    </h3>
                    <p className={`text-sm ${step.isComplete ? 'text-green-600' : 'text-slate-500'}`}>
                      {step.isComplete ? 'Completed' : step.description}
                    </p>
                  </div>
                  <ChevronRight className={`w-5 h-5 ${step.isComplete ? 'text-green-400' : 'text-slate-400'}`} />
                </button>
              ))}
            </div>
          ) : (
            // Individual step form
            <div>
              {steps[currentStep].render?.()}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50">
          {currentStep === 0 ? (
            <div className="flex gap-3">
              <Button variant="secondary" fullWidth onClick={onClose}>
                Close
              </Button>
              {allComplete && (
                <Button fullWidth onClick={handleComplete} disabled={isSaving}>
                  {isSaving ? 'Completing...' : 'Complete Intake'}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setCurrentStep(0)}>
                Back
              </Button>
              <Button 
                onClick={handleSave} 
                disabled={isSaving || !steps[currentStep].value}
                className="flex-1"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
