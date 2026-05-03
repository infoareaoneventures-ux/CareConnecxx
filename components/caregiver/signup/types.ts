export interface SignupFormData {
  // Step 1
  dateOfBirth: string; // YYYY-MM-DD
  termsAccepted: boolean;

  // Step 2
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
  phone: string;
  gender: 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say' | '';

  // Step 3
  street: string;
  apt: string;
  zipCode: string;
  city: string;
  state: string;
  neighborhood: string;
  latitude: number;
  longitude: number;

  // Step 4
  profilePhoto: { file: File | null; preview: string | null };

  // Step 5
  jobTypes: string[];
  weeklyAvailability: Record<string, string[]>;
  neverAvailable: string[];

  // Step 6
  primaryServices: Array<{ name: string; yearsExperience: string }>;
  additionalServices: string[];
  certifications: string[];

  // Step 7
  hourlyRate: string;
  rateFor2Seniors: string;
  rateFor3PlusSeniors: string;
  maxClients: string;

  // Step 8
  bio: string;
}

export const INITIAL_FORM_DATA: SignupFormData = {
  dateOfBirth: '',
  termsAccepted: false,
  email: '',
  password: '',
  confirmPassword: '',
  firstName: '',
  lastName: '',
  phone: '',
  gender: '',
  street: '',
  apt: '',
  zipCode: '',
  city: '',
  state: '',
  neighborhood: '',
  latitude: 0,
  longitude: 0,
  profilePhoto: { file: null, preview: null },
  jobTypes: [],
  weeklyAvailability: {
    sunday: [],
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
  },
  neverAvailable: [],
  primaryServices: [],
  additionalServices: [],
  certifications: [],
  hourlyRate: '',
  rateFor2Seniors: '',
  rateFor3PlusSeniors: '',
  maxClients: '',
  bio: '',
};

export const TOTAL_STEPS = 8;
