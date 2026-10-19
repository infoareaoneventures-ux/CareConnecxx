import { JobTimeOfDay, JobCareLevel, JobPaymentMethod } from '../../../types';
import type { GeocodedPoint } from '../../../utils/geocode';
import { PRIMARY_SERVICES, CareKind } from '../../caregiver/signup/constants';

export interface CareRecipientEntry {
  id?: string;
  firstName: string;
  lastName: string;
  relationship: string;
  /** Only for relationship Other: which list this person follows (adult / child) (the relationship decides everyone else). */
  careKind?: CareKind;
  /** A child's stage (one AGE_RANGES id), set on the child — the post's `ageRanges` are read from these. */
  ageRange?: string;
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
  dayShiftTimes: Record<string, { start: string; end: string }>;
  minHoursPerWeek: string;
  jobFrequency: 'occasional' | 'part-time' | 'full-time' | '';

  // Step 2: Who & Where
  careRecipients: CareRecipientEntry[];
  recipientsCount: 1 | 2 | 3 | 4;
  caregiversNeeded: 1 | 2 | 3 | 4;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  neighborhood: string;
  // The selected care location's saved STREET-level point (carePlans.locationPool
  // entry with geoPrecision 'street'), when it has one — the post reuses it as is;
  // otherwise PostJobFlow geocodes the street once at submit (2026-10-11).
  locationPoint: GeocodedPoint | null;

  // Step 2: Who & Where (home environment — tied to address)
  petsInHome: boolean;
  smokingHousehold: boolean;

  // Step 3: Care Needs
  careTypes: string[];
  careNeedDetails: Record<string, string[]>;
  careLevel: JobCareLevel | '';
  /** The picked children's stages (AGE_RANGES ids), derived on Step 3 from the recipients — informational on the post, like pets/smoking. */
  ageRanges: string[];

  // Step 4: Rate & Payment
  rate: number | undefined;
  rateFlexible: boolean;
  paymentMethod: JobPaymentMethod;

  // Step 5: Describe
  title: string;
  description: string;
}

export const INITIAL_FORM_DATA: JobPostFormData = {
  startDate: '',
  endDate: '',
  ongoing: false,
  daysOfWeek: [],
  daysFlexible: false,
  timeOfDay: [],
  dayShiftTimes: {},
  minHoursPerWeek: '',
  jobFrequency: '',

  careRecipients: [],
  recipientsCount: 1,
  caregiversNeeded: 1,
  streetAddress: '',
  city: '',
  state: 'CA',
  zipCode: '',
  neighborhood: '',
  locationPoint: null,

  careTypes: [],
  careNeedDetails: {},
  careLevel: '',
  ageRanges: [],
  petsInHome: false,
  smokingHousehold: false,

  rate: undefined,
  rateFlexible: false,
  paymentMethod: 'credit',

  title: '',
  description: '',
};

export interface StepProps {
  data: JobPostFormData;
  onChange: (patch: Partial<JobPostFormData>) => void;
  onContinue: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

// The senior eight — ONE source (components/caregiver/signup/constants.ts); the
// child eight live beside it as CHILD_SERVICES (2026-10-18).
export const CARE_TYPES: string[] = [...PRIMARY_SERVICES];

export const TIME_OF_DAY_OPTIONS: Array<{ value: JobTimeOfDay; label: string; sub: string }> = [
  { value: 'morning',   label: 'Morning',   sub: '6am–12pm' },
  { value: 'afternoon', label: 'Afternoon', sub: '12pm–6pm' },
  { value: 'evening',   label: 'Evening',   sub: '6pm–12am' },
  { value: 'overnight', label: 'Overnight', sub: '12am–6am' },
];

export const CARE_LEVEL_OPTIONS: Array<{ value: JobCareLevel; label: string; description: string }> = [
  { value: 'light', label: 'Light', description: 'Companionship, light housekeeping, reminders' },
  { value: 'moderate', label: 'Moderate', description: 'Hands-on help with mobility, meals, hygiene' },
  { value: 'intensive', label: 'Intensive', description: 'Full personal care, dementia, or medical needs' },
];
