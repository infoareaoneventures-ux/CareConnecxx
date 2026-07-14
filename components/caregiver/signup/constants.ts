// Primary senior care services
export const PRIMARY_SERVICES = [
  'Mobility Assistance',
  'Dementia / Memory Care',
  'Medication Reminders',
  'Personal Care',
  'Companionship',
  'Transportation',
  'Meal Preparation',
  'Light Housekeeping',
] as const;

// Additional service checkboxes (no duplicates with PRIMARY_SERVICES)
export const ADDITIONAL_SERVICES = [
  'Hospice Care',
  'Post-Surgery Recovery',
  'Incontinence Care',
  'Fall Risk Management',
  'Diabetes Management',
  'Physical Therapy Support',
] as const;

// Certifications
export const CERTIFICATIONS = ['CNA', 'HHA', 'RN', 'LPN'] as const;

// Experience level options
export const EXPERIENCE_LEVELS = [
  '< 1 year',
  '1-2 years',
  '3-5 years',
  '5-10 years',
  '10+ years',
] as const;

// Availability time blocks (UrbanSitter-style)
export const TIME_BLOCKS = [
  { id: 'morning', label: 'Morning', time: '6am - 12pm', icon: '☀️' },
  { id: 'afternoon', label: 'Afternoon', time: '12pm - 6pm', icon: '🌤' },
  { id: 'evening', label: 'Evening', time: '6pm - 12am', icon: '🌙' },
  { id: 'overnight', label: 'Overnight', time: '12am - 6am', icon: '🌑' },
] as const;

export const DAYS = [
  { id: 'sunday', short: 'S' },
  { id: 'monday', short: 'M' },
  { id: 'tuesday', short: 'T' },
  { id: 'wednesday', short: 'W' },
  { id: 'thursday', short: 'T' },
  { id: 'friday', short: 'F' },
  { id: 'saturday', short: 'S' },
] as const;

// Job type options
export const JOB_TYPES = [
  { id: 'occasional', label: 'Occasional', subtitle: '' },
  { id: 'part-time', label: 'Part-time', subtitle: '' },
  { id: 'full-time', label: 'Full-time', subtitle: '' },
] as const;

// US States
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
] as const;

// Writing ideas for the About Me bio
export const WRITING_IDEAS = [
  'What do you enjoy most about caregiving?',
  'Describe your approach to caring for seniors with dementia.',
  'What special skills or training do you bring?',
  'How do you handle difficult or stressful situations?',
  'Share a meaningful caregiving experience.',
  'What makes you a great match for families?',
];

// Example bio for reference
export const EXAMPLE_BIO = `Hi, I'm Sarah, and I've been a dedicated caregiver for over 8 years. I specialize in companionship and personal care for seniors, with extensive experience in dementia and Alzheimer's care. I'm CNA certified.

What I love most about caregiving is building genuine connections with the people I care for. I believe every senior deserves dignity, respect, and joy in their daily life. I'm patient, reliable, and always go the extra mile to ensure comfort and safety.

I have my own transportation and am flexible with scheduling. In my free time, I enjoy cooking healthy meals and taking walks — activities I love sharing with the seniors in my care.`;

// Max clients dropdown options
export const MAX_CLIENTS_OPTIONS = ['1', '2', '3+'] as const;
