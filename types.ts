
export type ViewType =
  | 'landing'
  | 'how-it-works'
  | 'trust'
  | 'subscription'
  | 'client-signup'
  | 'client-apply'
  | 'caregiver-signup'
  | 'caregiver-apply'
  | 'client-login'
  | 'caregiver-login'
  | 'forgot-password-client'
  | 'forgot-password-caregiver'
  | 'client'
  | 'client-profile'
  | 'client-inbox'
  | 'client-intake'
  | 'care-plan'
  | 'caregiver'
  | 'caregiver-profile'
  | 'caregiver-inbox'
  | 'caregiver-calendar'
  | 'caregiver-membership'
  | 'caregiver-jobs'
  | 'caregiver-bookings'
  | 'caregiver-video'
  | 'caregiver-families'
  | 'caregiver-settings'
  | 'caregiver-transactions'
  | 'caregiver-payout'
  | 'admin'
  | 'stripe-callback'
  | 'payment-success'
  | 'payment-cancel'
  | 'express-booking'
  | 'family-faq'
  | 'help-center'
  | 'help-families'
  | 'help-caregivers'
  | 'help-general';

export interface Senior {
  id: number;
  uid?: string;
  clientId?: string;
  name: string;
  age: number;
  imageUrl?: string;
  needs: string[];
  personality: 'Introvert' | 'Extrovert' | 'Ambivert';
  location: string;
  zipCode?: string;
  latitude?: number;
  longitude?: number;
  phone?: string;
  scheduleNeeded?: string[];
  genderPreference?: 'Female' | 'Male' | 'No Preference';
  excludedTags?: string[];
  familyMembers?: FamilyMember[];
  languagePreference?: string;
  hasPets?: boolean;
  smokingPreference?: 'non-smoker' | 'smoker' | 'no-preference';
  schedule?: string[] | Record<string, string[]>;
  adls?: string[];
  firstName?: string;
  lastName?: string;
}

/**
 * Client user document stored in Firestore users/{clientUID}.
 * seniorIds references all senior_profiles docs for this household.
 */
export interface ClientUser {
  uid: string;
  userType: 'client';
  seniorIds?: string[];
  name?: string;
  email?: string;
  phone?: string;
  createdAt?: string;
}

export interface FamilyMember {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: 'admin' | 'viewer';
  status: 'active' | 'pending';
}


// Define WeeklySchedule type
export interface WeeklySchedule {
  monday: TimeSlot[];
  tuesday: TimeSlot[];
  wednesday: TimeSlot[];
  thursday: TimeSlot[];
  friday: TimeSlot[];
  saturday: TimeSlot[];
  sunday: TimeSlot[];
}

export interface TimeSlot {
  start: string;  // "09:00" (24-hour format)
  end: string;    // "17:00" (24-hour format)
}

// Caregiver Document Types
export interface CaregiverDocument {
  url: string;
  path: string;
  uploadedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
  reviewedBy?: string;
  notes?: string;
  fileName?: string;
  fileType?: string;
  expirationDate?: string;
  documentName?: string;
  _pendingFile?: File;
}

export interface CaregiverDocuments {
  driversLicense?: CaregiverDocument;
  driversLicenseBack?: CaregiverDocument;
  registration?: CaregiverDocument;
  insurance?: CaregiverDocument;
  profilePhoto?: CaregiverDocument;
}

export interface Caregiver {
  id: string;
  uid: string;
  name: string;
  email?: string;
  phone?: string;
  bio?: string;
  photo?: string;
  imageUrl?: string; // Legacy field
  hourlyRate: number;
  verified: boolean;
  onboardingStep?: number;
  verificationStatus?: 'pending' | 'submitted' | 'profile_complete' | 'checkr_clear' | 'approved' | 'rejected' | 'info_requested' | 'pre_adverse_action';
  membershipPaid?: boolean;
  transportationBadge?: boolean;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  infoRequestNotes?: string;
  infoRequestedAt?: string;
  reviewNotes?: string;
  onboardingStatus?: 'incomplete' | 'complete';
  documents?: CaregiverDocuments;
  backgroundCheckData?: {
    // SECURITY: We NEVER store full SSN in our database
    // SSN is handled by Checkr's embedded flow and tokenized
    checkrCandidateId?: string;  // Checkr's candidate ID (tokenized reference)
    checkrReportId?: string;     // Checkr's report ID
    ssnLastFour?: string;        // Last 4 digits only, if needed for verification
    consentGiven?: boolean;
    legalFirstName?: string;
    legalLastName?: string;
    dob?: string;                // Format: YYYY-MM-DD
    zip?: string;                // ZIP only, not full address
    submittedAt?: string;
    status?: 'pending' | 'clear' | 'consider' | 'suspended';
    invitationStatus?: 'sent' | 'completed' | 'expired' | 'canceled';
    completedAt?: string;
    canceledAt?: string;
    includesCanceled?: boolean;
  };

  // NEW: Skills & Services
  skills?: string[];  // e.g., ["Driving", "Meal Preparation", "Medical Assistance"]
  certifications?: string[];  // e.g., ["CPR", "First Aid", "CNA"]

  // NEW: Availability
  weeklyAvailability?: WeeklySchedule;

  // NEW: Rate Suggestions
  suggestedRate?: number;  // AI-suggested competitive rate

  // NEW: Gender for preference matching
  gender?: 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say';

  instantPayAvailable: boolean;
  personalityTags: string[];
  matchScore: number;
  rating?: number;
  reviewCount?: number;
  distance: number;
  availability: string[];  // Legacy field, will migrate to weeklyAvailability
  backgroundCheckStatus?: 'none' | 'pending' | 'clear' | 'flagged' | 'consider';
  backgroundCheckId?: string;
  stripeAccountId?: string;
  stripeOnboardingComplete?: boolean;
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  detailsSubmitted?: boolean;
  stripeAccountCreatedAt?: string;
  stripeOnboardingCompletedAt?: string;
  latitude?: number;
  longitude?: number;
  location?: string;
  userType?: 'caregiver';
  totalEarnings?: number;
  completedJobs?: number;
  experience?: number;
  hasTransportation?: boolean;
  isSmoker?: boolean;
  medicalSkills?: string[];
  reliabilityScore?: number;
  retentionRate?: number;        // % of clients who rebook (0-100)
  matchReasoning?: string;
  matchFlags?: string[];
  matchReasons?: string[];
  videoUrl?: string;       // Video introduction URL (Firebase Storage) — legacy field
  introVideoUrl?: string;  // Caregiver intro video URL (UrbanSitter-style 30-second hello)
  profileVisibility?: 'visible' | 'hidden';  // Account Settings: show or hide profile from search
  hiddenJobIds?: string[]; // Job posts the caregiver has dismissed from their board
  rateFor2Seniors?: number;
  rateFor3PlusSeniors?: number;
  repeatFamilies?: number;    // "Booked by X repeat families" trust metric
  covidVaccinated?: boolean;  // COVID vaccination status
  education?: string;         // College / training institution
  travelRadius?: number;
  lastActive?: string;
  languages?: string[];
  petFriendly?: boolean;
  nonSmoker?: boolean;
  adls?: string[];
  firstName?: string;
  lastName?: string;

  // Payment Preferences (UrbanSitter model — direct off-platform)
  paymentPreferences?: {
    venmo?: string;    // e.g. "@maria-c"
    zelle?: string;    // phone or email
    cash?: boolean;
    other?: string;    // "PayPal @maria", "Apple Pay 415-555-0100", etc.
  };

  // Membership
  membershipStatus?: 'active' | 'trialing' | 'past_due' | 'payment_failed' | 'canceled' | 'inactive' | 'none';
  stripeSubscriptionId?: string;

  // UrbanSitter-style credit acceptance. When false, cannot apply to credit-only job posts.
  acceptsCreditCards?: boolean;

  // Micro-Visit
  acceptsMicroVisits?: boolean;

  // Signup Flow Fields (UrbanSitter-style)
  jobTypes?: string[];                    // ['occasional', 'part-time', 'full-time']
  maxClients?: number;                    // max seniors at one time
  primaryServices?: Array<{               // services with experience levels
    name: string;
    yearsExperience: string;              // '< 1 year', '1-2 years', etc.
  }>;
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  neighborhood?: string;
  dateOfBirth?: string;                   // YYYY-MM-DD
}

// --- JOB BOARD TYPES ---
export type JobTimeOfDay = 'morning' | 'afternoon' | 'evening' | 'overnight';
export type JobCareLevel = 'light' | 'moderate' | 'intensive';
export type JobPaymentMethod = 'cash' | 'credit';

export interface JobPost {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  description: string;
  rate: number;
  date: string; // "2024-01-01" (mirror of startDate for legacy consumers)
  startTime: string; // "09:00 AM"
  endTime: string; // "05:00 PM"
  location: string; // "City, State Zip" (mirror of city/state/zipCode)
  distance?: number; // Calculated relative to caregiver
  requirements: string[]; // ["Dementia", "Driving"] — mirror of careTypes
  status: 'open' | 'filled' | 'cancelled';
  createdAt: string;

  // Schedule
  startDate?: string;
  endDate?: string;
  daysOfWeek?: string[]; // ['Mon','Tue',...]
  timeOfDay?: JobTimeOfDay[];
  minHoursPerWeek?: number;

  // Recipient & location
  recipientsCount?: 1 | 2;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  neighborhood?: string;

  // Care needs
  careTypes?: string[];
  careLevel?: JobCareLevel;
  petsInHome?: boolean;
  smokingHousehold?: boolean;

  // Rate & payment
  paymentMethod?: JobPaymentMethod;
  rateFlexible?: boolean;

  // Screening
  screeningQuestions?: string[];

  // UrbanSitter-style frequency tag (displayed as one-time / part-time / full-time pill on the Job Board)
  jobFrequency?: 'one-time' | 'part-time' | 'full-time';

  applicantCount?: number;
  preferredDate?: string;
  notes?: string;
}

// --- MICRO-VISIT TYPES ---
export interface MicroTask {
  id: string;
  name: string;
  durationMin: number;
  flatRate: number;
  category?: 'hygiene' | 'medical' | 'household' | 'wellness';
}

export const MICRO_TASKS: MicroTask[] = [
  { id: 'bath', name: 'Bath Visit', durationMin: 45, flatRate: 40, category: 'hygiene' },
  { id: 'meds', name: 'Medication Reminder', durationMin: 30, flatRate: 30, category: 'medical' },
  { id: 'meal', name: 'Meal Prep & Drop-off', durationMin: 60, flatRate: 45, category: 'household' },
  { id: 'wound', name: 'Wound Care', durationMin: 45, flatRate: 50, category: 'medical' }
];

// --- CARE JOURNAL TYPES ---
// Wellness/activity log entries used to compute family-facing wellness and
// peace-of-mind scores (components/family/WellnessScore, PeaceOfMindScore).
export interface CareJournalEntry {
  id?: string;
  timestamp: string;
  note?: string;
  activities?: string[];
  wellness?: {
    mood?: string;
    wasActive?: boolean;
    tookMeds?: boolean;
    ateWell?: boolean;
  };
}

// --- ADMIN TYPES ---
export interface AdminUser {
  uid: string;
  name: string;
  email: string;
  phone?: string;
  userType: 'client' | 'caregiver';
  createdAt: string;
  isBanned?: boolean;
  verified?: boolean;
  documents?: Record<string, unknown>;
}

export interface CareCoordinator {
  id: string;
  uid?: string;
  name: string;
  email: string;
  phone?: string;
  title?: string;
  bio?: string;
  assignedClients?: string[];
  status?: 'active' | 'inactive';
  createdAt?: string;
  specialties?: string[];
  languages?: string[];
  isActive?: boolean;
  completedMatches?: number;
  photoURL?: string;
  activeMatchAssignments?: number;
}

export interface MatchFeedback {
  id?: string;
  seniorId: string;
  caregiverId: string;
  action: 'hired' | 'rejected' | 'viewed';
  reason?: string;
  timestamp: string;
}

export interface Review {
  id: string;
  caregiverId: string;
  clientId?: string;
  clientName: string;
  caregiverName?: string;
  rating: number;
  comment: string;
  date: string;
  appointmentId?: string;
  categories?: {
    punctuality: number;
    professionalism: number;
    communication: number;
    careQuality: number;
  };
  wouldRecommend?: boolean;
  wouldRehire?: boolean;
  response?: {
    text: string;
    respondedAt: string;
  };
}

export interface SystemLog {
  id: number;
  timestamp: string;
  event: string;
  type: 'info' | 'warning' | 'success';
}

export interface Gig {
  id: number;
  title: string;
  time: string;
  rate: number;
  distance: number;
  clientName: string;
}

export interface Appointment {
  id: string;
  clientId?: string;
  caregiverId: string;
  caregiverName: string;
  clientName: string;
  date: string;
  isoDate: string;
  time: string;
  duration: number; // Duration in hours
  status: 'pending_caregiver_confirmation' | 'confirmed' | 'in-progress' | 'completed' | 'cancelled';
  paymentStatus: 'pending' | 'paid' | 'refunded';
  paymentMethod: JobPaymentMethod;
  cost: number;
  hasReview?: boolean;
  cancelledBy?: 'client' | 'caregiver' | 'admin';
  cancellationReason?: string;
  cancelledAt?: string;

  // Micro-Visit Fields
  bookingType?: 'hourly' | 'task';
  taskName?: string;
  isMicroVisit?: boolean;

  // Recurring Booking Fields
  isRecurring?: boolean;
  recurringGroupId?: string; // Links appointments in same series
  recurringFrequency?: 'weekly' | 'biweekly' | 'monthly';
  recurringEndDate?: string; // ISO date when series ends
  recurringDayOfWeek?: number; // 0-6 (Sunday-Saturday)

  caregiverConfirmedAt?: string;
  caregiverDeclinedAt?: string;
  startTime?: string;
  wasRebooked?: boolean;

  // Optional location/notes fields
  location?: string;
  address?: string;
  notes?: string;
  seniorName?: string;

  // Multi-senior household: explicit seniorId (was implicit = clientId in old model)
  seniorId?: string;
}

// --- SHIFT HOURS (per-appointment caregiver hours submission + client approval) ---
export type ShiftHoursStatus =
  | 'pending_client_review'
  | 'correction_proposed'
  | 'approved'
  | 'auto_approved'
  | 'disputed_admin_review'
  | 'paid'
  | 'payment_failed';

export type ShiftHoursResolvedBy =
  | 'client'
  | 'caregiver'
  | 'admin'
  | 'system_auto_approve'
  | 'system_auto_accept';

export interface ShiftHours {
  id: string;                         // === appointmentId
  appointmentId: string;
  caregiverId: string;
  caregiverName: string;
  clientId: string;
  clientName: string;
  payRate: number;                    // snapshot at submit
  currency: 'usd';
  paymentMethod: JobPaymentMethod;    // snapshot from appointment at submit

  submittedStartTime: string;         // ISO
  submittedEndTime: string;           // ISO
  submittedTotalHours: number;
  submittedAt: string;                // ISO

  proposedStartTime?: string;
  proposedEndTime?: string;
  proposedTotalHours?: number;
  proposalReason?: string;
  proposedAt?: string;

  finalStartTime?: string;
  finalEndTime?: string;
  finalTotalHours?: number;
  grossPay?: number;                  // finalTotalHours * payRate
  resolvedAt?: string;
  resolvedBy?: ShiftHoursResolvedBy;

  autoApproveAt: string;              // submittedAt + 24h
  correctionRespondByAt?: string;     // proposedAt + 24h

  adminAssignedTo?: string;
  adminResolutionNote?: string;

  stripeChargeId?: string;
  stripeTransferId?: string;
  stripeFailureReason?: string;
  paymentAttemptCount: number;
  lastPaymentAttemptAt?: string;

  status: ShiftHoursStatus;
  createdAt: string;
  updatedAt: string;
}

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
}

export type AddToastFunction = (message: string, type: ToastType) => void;

// AI Matching Types
export interface MatchScore {
  caregiverId: string;
  overallScore: number;
  breakdown: {
    skillsMatch: number;
    availabilityMatch: number;
    personalityMatch: number;
    distanceScore: number;
    ratingScore: number;
    rebookingRate: number;
  };
  reasoning: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  recommendedCaregivers?: Caregiver[];
  suggestions?: string[];
  isEmergency?: boolean;
}

export interface DirectMessage {
  id: string;
  senderId: string;
  text: string;
  timestamp: string;
  createdAt?: any;
  isRead: boolean;
}

export interface Thread {
  id: string;
  contactId: string;
  contactName: string;
  contactAvatar: string;
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  messages: DirectMessage[];
  participants?: string[];
}

// --- CARE PLAN INTERFACES ---
export interface Medication {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  notes?: string;
}

export interface EmergencyContact {
  id: string;
  name: string;
  relation: string;
  phone: string;
  isPrimary: boolean;
}

export interface RoutineTask {
  id: string;
  time: string;
  description: string;
  category: 'meal' | 'medication' | 'activity' | 'hygiene';
  isCompleted?: boolean;
}

export interface CarePlan {
  medications: Medication[];
  emergencyContacts: EmergencyContact[];
  dailyRoutine: RoutineTask[];
  accessCodes?: string;
  dietaryRestrictions?: string;
}

// --- SUPPORT INTERFACES ---
export interface SupportTicket {
  id?: string;
  userId: string;
  userName?: string;
  userType?: 'client' | 'caregiver';
  type: 'dispute' | 'refund' | 'safety' | 'technical' | 'other';
  subject?: string;
  description: string;
  status: 'open' | 'in-progress' | 'resolved';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
  assignedTo?: string;
  responses?: Array<{ text: string; respondedAt: string; respondedBy?: string }>;
}

// --- NOTIFICATION HISTORY ---
export interface AppNotification {
  id: string;
  userId: string;
  title: string;
  body: string;
  message?: string;
  type: 'booking' | 'system' | 'message' | 'alert' | 'verification_approved' | 'verification_rejected' | 'info_requested' | string;
  isRead: boolean;
  read?: boolean;
  createdAt: string;
  timestamp?: string;
}

export interface Invoice {
  id: string;
  invoiceNumber?: string;
  clientId: string;
  clientName?: string;
  caregiverId: string;
  caregiverName?: string;
  amount: number;
  subtotal?: number;
  taxes?: number;
  fees?: number;
  total?: number;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'approved' | 'pending';
  dueDate: string;
  createdAt: string;
  carePeriod?: { start: string; end: string };
  lineItems?: Array<{ description: string; hours: number; rate: number; total: number; date?: string; tasks?: string[]; seniorId?: string; seniorName?: string }>;
  notes?: string;
  paidAt?: string;
  pdfUrl?: string;
}

// --- BACKGROUND CHECK SUBMISSION PAYLOAD ---
// SSN/DOB are collected by Checkr's hosted invitation flow, not our app.
export interface BackgroundCheckData {
  legalFirstName: string;
  legalLastName: string;
  zipCode: string;
  state?: string;
  consentGiven: boolean;
}

// Predefined skill options
export const CAREGIVER_SKILLS = [
  'Driving & Transportation',
  'Meal Preparation',
  'Light Housekeeping',
  'Medication Reminders',
  'Medical Assistance',
  'Companionship',
  'Mobility Support',
  'Personal Care',
  'Dementia Care',
  'Physical Therapy Support'
] as const;

export type CaregiverSkill = typeof CAREGIVER_SKILLS[number];

// --- EMERGENCY ALERT ---
export interface EmergencyAlert {
  id: string;
  initiatorId: string;
  initiatorType: 'client' | 'caregiver';
  timestamp: string;
  location?: { lat: number; lng: number };
  status: 'active' | 'resolved';
  notifiedContacts: string[];
}

// --- VIDEO INTERVIEW TYPES ---
export type VideoInterviewStatus = 'requested' | 'accepted' | 'scheduled' | 'in-progress' | 'completed' | 'cancelled' | 'missed';

export interface VideoInterview {
  id: string;
  clientId: string;
  clientName: string;
  caregiverId: string;
  caregiverName: string;
  scheduledTime: string; // ISO timestamp
  duration?: number; // in minutes
  status: VideoInterviewStatus;
  roomSid?: string; // Twilio room SID
  roomName?: string;
  recordingUrl?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  notes?: string;
  interviewType?: 'video' | 'phone' | 'in-person';
  jobId?: string;
  jobTitle?: string;
}

/**
 * Client Intake Flow Types
 */
export interface ClientIntakeData {
  recipientName: string;
  recipientFirstName?: string;
  recipientLastName?: string;
  relationship: string;
  careTypes: string[];
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  schedule: string;
  weeklySchedule?: Record<string, Array<{start: string, end: string}>>;
  startDate: string;
  duration: string;
  additionalComments?: string;
  contactName: string;
  phone: string;
  email: string;
  password?: string;
  confirmPassword?: string;
  userId: string;
  createdAt: any; // Firebase Timestamp
  status: 'pending' | 'in_review' | 'matched' | 'active' | 'completed' | 'contacted';
  assignedCoordinator?: string;
  matchedCaregivers?: string[];
}

export type IntakeStep = 
  | 'recipient_name'
  | 'relationship'
  | 'care_types'
  | 'location'
  | 'schedule'
  | 'start_date'
  | 'duration'
  | 'comments'
  | 'account_creation';

/**
 * Firebase Auth User - use this instead of `any`
 */
export type User = import('firebase/auth').User | null;

/**
 * Extended user profile stored in Firestore
 */
export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  phone?: string;
  userType: 'client' | 'caregiver' | 'admin';
  createdAt: string;
  updatedAt?: string;
  isVerified?: boolean;
  isBanned?: boolean;
  smsOptIn?: boolean;
  pushOptIn?: boolean;
  timezone?: string;
  savedCaregiverIds?: string[];  // Favorited / saved caregiver IDs
  savedSearches?: Array<{
    name: string;
    filters: Record<string, any>;
    emailFrequency: 'daily' | 'weekly' | 'off';
    savedAt: string;
  }>;  // Saved search filter sets
  seniorProfile?: {
    relationship?: string;
    firstName?: string;
    ageGroup?: string;
    gender?: string;
    conditions?: string[];
  };

  // Caregiver Account Settings — Communication preferences (UrbanSitter-parity)
  notificationPrefs?: {
    monthlyTips?: boolean;
    weeklySummary?: boolean;
    jobAlerts?: boolean;
    confirmWeekendAvailability?: boolean;
    smsOnBookingRequest?: boolean;
    smsOnInterviewRequest?: boolean;
    smsImportant?: boolean;
    jobApplicationNotifications?: boolean;
  };
  bookingRequestPolicy?: 'any-time-slot' | 'only-when-available';
  notAcceptingNewFamilies?: boolean;
}

// ==========================================
// CARE COORDINATOR MATCHING SYSTEM
// ==========================================

export interface CareNeed {
  category: 'mobility' | 'cognitive' | 'medical' | 'personal_care' | 'household' | 'companionship';
  description: string;
  frequency: 'daily' | 'weekly' | 'as_needed';
  priority: 'required' | 'preferred' | 'nice_to_have';
}

export interface MatchAssignment {
  id: string;
  clientId: string;
  seniorId: string;
  coordinatorId?: string;
  status: 'pending_review' | 'in_review' | 'matches_ready' | 'sent_to_client' | 'interviewing' | 'hire_requested' | 'completed';
  aiSuggestedMatches: AIMatchSuggestion[];
  approvedMatches: ApprovedMatch[];
  rejectedMatches: RejectedMatch[];
  careNeeds: CareNeed[];
  priority: 'low' | 'medium' | 'high' | 'urgent';
  notes: string;
  createdAt: string;
  reviewedAt?: string;
  sentToClientAt?: string;
}

export interface AIMatchSuggestion {
  caregiverId: string;
  caregiverName: string;
  matchScore: number;
  ranking: number;
  reasoning: string[];
  predictiveFactors: {
    successProbability: number;
    acceptanceLikelihood: number;
    retentionProbability: number;
  };
  availabilityMatch: {
    score: number;
    overlappingHours: string[];
  };
  redFlags?: string[];
}

export interface ApprovedMatch {
  caregiverId: string;
  caregiverName: string;
  approvedAt: string;
  approvedBy: string;
  coordinatorNotes?: string;
  priority: number;
  status: 'pre_confirmed' | 'interview_scheduled' | 'interview_completed' | 'selected' | 'booked' | 'declined';
}

export interface RejectedMatch {
  caregiverId: string;
  rejectedAt: string;
  rejectedBy: string;
  reason: 'unavailable' | 'skills_mismatch' | 'distance' | 'past_issues' | 'other';
  notes?: string;
}

export interface InterviewRequest {
  id: string;
  clientId: string;
  seniorId: string;
  caregiverId: string;
  matchAssignmentId: string;
  type: 'video' | 'phone' | 'in_person';
  status: 'pending' | 'scheduled' | 'completed' | 'cancelled' | 'declined';
  proposedTimes: string[];
  scheduledTime?: string;
  duration: number;
  clientNotes?: string;
  caregiverNotes?: string;
  clientFeedback?: {
    fit: 'strong' | 'maybe' | 'no_match';
    notes?: string;
    submittedAt: string;
  };
  caregiverFeedback?: {
    interested: boolean;
    notes?: string;
    submittedAt: string;
  };
  createdAt: string;
  scheduledAt?: string;
  completedAt?: string;
}

export interface HireRequest {
  id: string;
  clientId: string;
  seniorId: string;
  matchAssignmentId: string;
  caregiverId: string;
  interviewedCaregiverIds: string[];
  clientNotes?: string;
  proposedStartDate: string;
  proposedSchedule: {
    days: string[];
    startTime: string;
    endTime: string;
  };
  serviceType: 'ongoing' | 'one_time' | 'respite';
  status: 'pending_coordinator_review' | 'coordinator_approved' | 'coordinator_declined' | 'caregiver_accepted' | 'caregiver_declined' | 'booking_created';
  requestedAt: string;
  coordinatorReviewedAt?: string;
  coordinatorId?: string;
  coordinatorNotes?: string;
  caregiverNotifiedAt?: string;
  caregiverRespondedAt?: string;
  bookingId?: string;
}
