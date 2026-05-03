import React, { useState, useEffect } from 'react';
import { useCareConnex } from '../../context/CareConnexContext';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { 
  Check, 
  ChevronRight, 
  Clock, 
  Calendar, 
  Phone, 
  User,
  FileText,
  Activity
} from 'lucide-react';
import { ClientIntakeData } from '../../types';
import { db } from '../../lib/firebase';

interface CompleteIntakeStep {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  isCompleted: boolean;
}

interface CompleteIntakeProps {
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

export const CompleteIntake: React.FC<CompleteIntakeProps> = ({
  intakeData,
  userId,
  onComplete
}) => {
  const { addToast } = useCareConnex();
  const [currentSubStep, setCurrentSubStep] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    phone: '',
    schedule: '',
    startDate: '',
    duration: '',
  });
  
  // Sync formData with intakeData when it loads/changes
  useEffect(() => {
    if (intakeData) {
      setFormData({
        phone: intakeData.phone || '',
        schedule: intakeData.schedule || '',
        startDate: intakeData.startDate || '',
        duration: intakeData.duration || '',
      });
    }
  }, [intakeData]);

  const subSteps = [
    {
      id: 'phone',
      title: 'Add Phone Number',
      description: 'So caregivers can reach you',
      icon: <Phone className="w-5 h-5" />,
      isCompleted: !!(formData.phone || intakeData?.phone)
    },
    {
      id: 'schedule',
      title: 'Set Schedule',
      description: 'When do you need care?',
      icon: <Clock className="w-5 h-5" />,
      isCompleted: !!(formData.schedule && formData.schedule !== 'Flexible Schedule') || 
                   !!(intakeData?.schedule && intakeData?.schedule !== 'Flexible Schedule')
    },
    {
      id: 'startDate',
      title: 'Start Date',
      description: 'When should care begin?',
      icon: <Calendar className="w-5 h-5" />,
      isCompleted: !!(formData.startDate && formData.startDate !== 'ASAP') ||
                   !!(intakeData?.startDate && intakeData?.startDate !== 'ASAP')
    },
    {
      id: 'duration',
      title: 'Duration',
      description: 'How long is care needed?',
      icon: <FileText className="w-5 h-5" />,
      isCompleted: !!(formData.duration && formData.duration !== 'Ongoing') ||
                   !!(intakeData?.duration && intakeData?.duration !== 'Ongoing')
    }
  ];

  const completedCount = subSteps.filter(s => s.isCompleted).length;
  const progress = (completedCount / subSteps.length) * 100;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (db && userId) {
        const currentStepId = subSteps[currentSubStep - 1]?.id;
        const updateData: any = {
          updatedAt: new Date().toISOString()
        };
        
        // Only update the field for the current step
        if (currentStepId === 'phone') updateData.phone = formData.phone;
        if (currentStepId === 'schedule') updateData.schedule = formData.schedule;
        if (currentStepId === 'startDate') updateData.startDate = formData.startDate;
        if (currentStepId === 'duration') updateData.duration = formData.duration;
        
        console.log('Saving intake data:', { currentStepId, updateData, userId });
        await db.collection('clientIntakes').doc(userId).update(updateData);
        console.log('Save successful');
        
        // Check if all steps are now complete
        // Use the updated formData values for the current step, fall back to intakeData for others
        const hasPhone = (currentStepId === 'phone' ? formData.phone : (formData.phone || intakeData?.phone));
        const hasSchedule = (currentStepId === 'schedule' ? formData.schedule : (formData.schedule || intakeData?.schedule));
        const hasStartDate = (currentStepId === 'startDate' ? formData.startDate : (formData.startDate || intakeData?.startDate));
        const hasDuration = (currentStepId === 'duration' ? formData.duration : (formData.duration || intakeData?.duration));
        
        const allComplete = 
          hasPhone &&
          hasSchedule && hasSchedule !== 'Flexible Schedule' &&
          hasStartDate && hasStartDate !== 'ASAP' &&
          hasDuration && hasDuration !== 'Ongoing';
        
        console.log('Completion check:', { hasPhone, hasSchedule, hasStartDate, hasDuration, allComplete });
        
        if (allComplete) {
          await db.collection('clientIntakes').doc(userId).update({
            status: 'pending'
          });
          await db.collection('users').doc(userId).update({
            intakeCompleted: true
          });
          onComplete();
        } else {
          // Go back to steps overview
          setCurrentSubStep(0);
        }
      }
    } catch (error) {
      console.error('Failed to save intake data:', error);
      addToast('Failed to save. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const renderSubStepContent = () => {
    switch (currentSubStep) {
      case 0:
        return (
          <div className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              Phone Number
            </label>
            <input
              type="tel"
              value={formData.phone}
              onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
              placeholder="(555) 123-4567"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500"
            />
          </div>
        );
      
      case 1:
        return (
          <div className="space-y-3">
            {SCHEDULE_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setFormData(prev => ({ ...prev, schedule: option.label }))}
                className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                  formData.schedule === option.label
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="font-medium text-slate-900">{option.label}</div>
                <div className="text-sm text-slate-500">{option.description}</div>
              </button>
            ))}
          </div>
        );
      
      case 2:
        return (
          <div className="space-y-3">
            {START_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setFormData(prev => ({ ...prev, startDate: option.label }))}
                className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                  formData.startDate === option.label
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="font-medium text-slate-900">{option.label}</div>
              </button>
            ))}
          </div>
        );
      
      case 3:
        return (
          <div className="space-y-3">
            {DURATION_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setFormData(prev => ({ ...prev, duration: option.label }))}
                className={`w-full p-4 text-left border-2 rounded-xl transition-all ${
                  formData.duration === option.label
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="font-medium text-slate-900">{option.label}</div>
                <div className="text-sm text-slate-500">{option.description}</div>
              </button>
            ))}
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
            <FileText className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Complete Your Intake</h2>
            <p className="text-sm text-slate-500">
              {completedCount} of {subSteps.length} steps completed
            </p>
          </div>
        </div>
        
        {/* Progress Bar */}
        <div className="mt-4 h-2 bg-slate-100 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="p-6">
        {currentSubStep === 0 ? (
          // Show all steps overview
          <div className="space-y-3">
            {subSteps.map((step, index) => (
              <button
                key={step.id}
                onClick={() => setCurrentSubStep(index + 1)}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left ${
                  step.isCompleted
                    ? 'border-green-200 bg-green-50'
                    : 'border-slate-100 hover:border-blue-200 hover:bg-blue-50'
                }`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  step.isCompleted ? 'bg-green-100' : 'bg-slate-100'
                }`}>
                  {step.isCompleted ? (
                    <Check className="w-5 h-5 text-green-600" />
                  ) : (
                    <span className="text-slate-500">{step.icon}</span>
                  )}
                </div>
                <div className="flex-1">
                  <h3 className={`font-medium ${step.isCompleted ? 'text-green-900' : 'text-slate-900'}`}>
                    {step.title}
                  </h3>
                  <p className={`text-sm ${step.isCompleted ? 'text-green-600' : 'text-slate-500'}`}>
                    {step.description}
                  </p>
                </div>
                <ChevronRight className={`w-5 h-5 ${step.isCompleted ? 'text-green-400' : 'text-slate-400'}`} />
              </button>
            ))}
            
            {completedCount === subSteps.length && (
              <Button 
                fullWidth 
                onClick={onComplete}
                className="mt-4"
              >
                <Check className="w-4 h-4 mr-2" />
                Complete Intake
              </Button>
            )}
          </div>
        ) : (
          // Show individual step form
          <div>
            <button
              onClick={() => setCurrentSubStep(0)}
              className="text-sm text-slate-500 hover:text-slate-700 mb-4"
            >
              ← Back to all steps
            </button>
            
            <h3 className="text-lg font-bold text-slate-900 mb-2">
              {subSteps[currentSubStep - 1]?.title}
            </h3>
            <p className="text-slate-600 mb-6">
              {subSteps[currentSubStep - 1]?.description}
            </p>
            
            {renderSubStepContent()}
            
            <div className="flex gap-3 mt-6">
              <Button
                variant="secondary"
                onClick={() => setCurrentSubStep(0)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={isSaving || !formData[subSteps[currentSubStep - 1]?.id as keyof typeof formData]}
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
