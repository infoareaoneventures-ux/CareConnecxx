import { JobTimeOfDay, JobCareLevel, JobPaymentMethod } from '../../../types';

export interface CareRecipientEntry {
  id?: string;
  firstName: string;
  lastName: string;
  relationship: string;
  isSelf?: boolean;
}

export interface JobPostFormData {
  // Step 1: Schedule
  startDate: string;
  endDate: string;
  ongoing: boolean;
  daysOfWeek: string[];
  daysFlexible: boolean;
  timeOfDay: JobTimeOfDay[];
  minHoursPerWeek: string;
  jobFrequency: 'one-time' | 'part-time' | 'full-time' | '';

  // Step 2: Who & Where
  careRecipients: CareRecipientEntry[];
  recipientsCount: 1 | 2 | 3 | 4;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  neighborhood: string;

  // Step 2: Who & Where (home environment — tied to address)
  petsInHome: boolean;
  smokingHousehold: boolean;

  // Step 3: Care Needs
  careTypes: string[];
  careLevel: JobCareLevel | '';

  // Step 4: Rate & Payment
  rate: number;
  rateFlexible: boolean;
  paymentMethod: JobPaymentMethod | '';

  // Step 5: Describe
  title: string;
  description: string;

  // Step 6: Screening
  screeningQuestions: string[];
}

export const INITIAL_FORM_DATA: JobPostFormData = {
  startDate: '',
  endDate: '',
  ongoing: false,
  daysOfWeek: [],
  daysFlexible: false,
  timeOfDay: [],
  minHoursPerWeek: '',
  jobFrequency: '',

  careRecipients: [],
  recipientsCount: 1,
  streetAddress: '',
  city: '',
  state: 'CA',
  zipCode: '',
  neighborhood: '',

  careTypes: [],
  careLevel: '',
  petsInHome: false,
  smokingHousehold: false,

  rate: 28,
  rateFlexible: false,
  paymentMethod: '',

  title: '',
  description: '',

  screeningQuestions: [],
};

export interface StepProps {
  data: JobPostFormData;
  onChange: (patch: Partial<JobPostFormData>) => void;
  onContinue: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export const CARE_TYPES = [
  'Mobility Assistance',
  'Dementia / Memory Care',
  'Medication Reminders',
  'Personal Care',
  'Companionship',
  'Transportation',
  'Meal Preparation',
  'Light Housekeeping',
];

export const TIME_OF_DAY_OPTIONS: Array<{ value: JobTimeOfDay; label: string }> = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'overnight', label: 'Overnight' },
];

export const CARE_LEVEL_OPTIONS: Array<{ value: JobCareLevel; label: string; description: string }> = [
  { value: 'light', label: 'Light', description: 'Companionship, light housekeeping, reminders' },
  { value: 'moderate', label: 'Moderate', description: 'Hands-on help with mobility, meals, hygiene' },
  { value: 'intensive', label: 'Intensive', description: 'Full personal care, dementia, or medical needs' },
];

export const PAYMENT_OPTIONS: Array<{ value: JobPaymentMethod; label: string; description: string }> = [
  { value: 'credit', label: 'Credit card', description: 'Charged automatically when hours are approved' },
  { value: 'cash', label: 'Cash', description: 'Pay caregiver directly — cash-only caregivers can apply' },
];
