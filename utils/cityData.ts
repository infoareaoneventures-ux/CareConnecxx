export interface CityData {
  slug: string;
  name: string;
  county: string;
  zipCodes: string[];
  avgHourlyRate: string;
  availableCaregivers: number;
  population65Plus: string;
  metaTitle: string;
  metaDescription: string;
  headline: string;
  subheadline: string;
  nearbyNeighborhoods: string[];
  localStats: { label: string; value: string }[];
  testimonial: { quote: string; name: string; neighborhood: string };
  nearestCities: string[];
}

export const cities: CityData[] = [
  {
    slug: 'san-jose',
    name: 'San Jose',
    county: 'Santa Clara County',
    zipCodes: ['95101', '95110', '95112', '95116', '95124', '95125', '95126', '95128', '95130', '95131', '95132', '95136', '95138', '95139', '95148'],
    avgHourlyRate: '$24–$33',
    availableCaregivers: 120,
    population65Plus: '11.8%',
    metaTitle: 'Senior Care in San Jose, CA | Verified Caregivers $22–$35/hr | Evia',
    metaDescription: 'Find trusted senior caregivers in San Jose, CA. Verified, background-checked caregivers available for in-home care, dementia care, and respite care. Match in 24 hours.',
    headline: 'Trusted Senior Care in San Jose, CA',
    subheadline: 'Connect with verified, background-checked caregivers across San Jose — from Willow Glen to East San Jose — using AI-powered matching. No agency fees.',
    nearbyNeighborhoods: ['Willow Glen', 'Almaden Valley', 'Berryessa', 'Evergreen', 'Silver Creek', 'Cambrian', 'Blossom Hill', 'Downtown San Jose'],
    localStats: [
      { label: 'Caregivers Available', value: '120+' },
      { label: 'Avg. Hourly Rate', value: '$24–$33' },
      { label: 'Typical Match Time', value: '< 24 hrs' },
      { label: 'Avg. Client Rating', value: '4.9 ★' }
    ],
    testimonial: {
      quote: "We found an incredible caregiver for my father in Willow Glen within a day. The video interview made me feel completely confident before she walked through the door.",
      name: "Patricia M.",
      neighborhood: "Willow Glen, San Jose"
    },
    nearestCities: ['Santa Clara', 'Milpitas', 'Campbell', 'Los Gatos', 'Cupertino']
  },
  {
    slug: 'mountain-view',
    name: 'Mountain View',
    county: 'Santa Clara County',
    zipCodes: ['94040', '94041', '94043'],
    avgHourlyRate: '$25–$34',
    availableCaregivers: 45,
    population65Plus: '10.4%',
    metaTitle: 'Senior Care in Mountain View, CA | In-Home Caregivers | Evia',
    metaDescription: 'Find verified senior caregivers in Mountain View, CA. Background-checked, reviewed by local families. In-home care, dementia care & respite care starting at $25/hr.',
    headline: 'In-Home Senior Care in Mountain View, CA',
    subheadline: 'Verified caregivers serving Mountain View families — background-checked, interviewed by our team, and rated by real local families. Match in as little as 24 hours.',
    nearbyNeighborhoods: ['Crestview', 'Old Mountain View', 'Rex Manor', 'Gemello', 'Shoreline West', 'Monta Loma'],
    localStats: [
      { label: 'Caregivers Available', value: '45+' },
      { label: 'Avg. Hourly Rate', value: '$25–$34' },
      { label: 'Typical Match Time', value: '< 24 hrs' },
      { label: 'Avg. Client Rating', value: '4.9 ★' }
    ],
    testimonial: {
      quote: "After trying two agencies, Evia gave us real control. We read reviews, watched intro videos, and interviewed our caregiver over video. My mom loves her.",
      name: "James T.",
      neighborhood: "Mountain View, CA"
    },
    nearestCities: ['Sunnyvale', 'Palo Alto', 'Los Altos', 'Castro Valley', 'San Jose']
  },
  {
    slug: 'santa-clara',
    name: 'Santa Clara',
    county: 'Santa Clara County',
    zipCodes: ['95050', '95051', '95054'],
    avgHourlyRate: '$23–$33',
    availableCaregivers: 55,
    population65Plus: '10.1%',
    metaTitle: 'Senior Care in Santa Clara, CA | Verified Caregivers | Evia',
    metaDescription: 'Find trusted in-home senior caregivers in Santa Clara, CA. No agency fees, AI-powered matching, and background-checked caregivers available for same-week starts.',
    headline: 'Senior Care in Santa Clara, CA',
    subheadline: 'Find background-checked, reviewed caregivers in Santa Clara for companion care, personal care, and dementia care. Families save 30–40% versus traditional agencies.',
    nearbyNeighborhoods: ['Central Santa Clara', 'Rivermark', 'Santa Clara Square', 'Agnew', 'Bowers'],
    localStats: [
      { label: 'Caregivers Available', value: '55+' },
      { label: 'Avg. Hourly Rate', value: '$23–$33' },
      { label: 'Typical Match Time', value: '< 24 hrs' },
      { label: 'Avg. Client Rating', value: '4.9 ★' }
    ],
    testimonial: {
      quote: "The background check details were transparent, and we could see how many families had rehired our caregiver. That track record made all the difference.",
      name: "Sunita R.",
      neighborhood: "Santa Clara, CA"
    },
    nearestCities: ['San Jose', 'Sunnyvale', 'Cupertino', 'Mountain View', 'Milpitas']
  },
  {
    slug: 'sunnyvale',
    name: 'Sunnyvale',
    county: 'Santa Clara County',
    zipCodes: ['94085', '94086', '94087', '94089'],
    avgHourlyRate: '$25–$34',
    availableCaregivers: 60,
    population65Plus: '10.8%',
    metaTitle: 'Senior Care in Sunnyvale, CA | In-Home Caregivers | Evia',
    metaDescription: 'Find verified senior caregivers in Sunnyvale, CA. AI-matched, background-checked, and reviewed by local Sunnyvale families. Start care within 24 hours.',
    headline: 'Trusted In-Home Care in Sunnyvale, CA',
    subheadline: 'Serving Sunnyvale families with verified caregivers for companion care, personal care, Alzheimer\'s support, and respite care. Transparent pricing — no agency markup.',
    nearbyNeighborhoods: ['Murphy Ave District', 'Lakewood', 'Borregas', 'Raynor Park', 'Cherry Chase', 'Ponderosa Park'],
    localStats: [
      { label: 'Caregivers Available', value: '60+' },
      { label: 'Avg. Hourly Rate', value: '$25–$34' },
      { label: 'Typical Match Time', value: '< 24 hrs' },
      { label: 'Avg. Client Rating', value: '4.9 ★' }
    ],
    testimonial: {
      quote: "I was skeptical about an app-based platform but was proven wrong completely. Our caregiver has been with my mother for eight months and they have a wonderful bond.",
      name: "Helen W.",
      neighborhood: "Sunnyvale, CA"
    },
    nearestCities: ['Mountain View', 'Santa Clara', 'Cupertino', 'San Jose', 'Los Altos']
  },
  {
    slug: 'palo-alto',
    name: 'Palo Alto',
    county: 'Santa Clara County',
    zipCodes: ['94301', '94303', '94304', '94305', '94306'],
    avgHourlyRate: '$27–$36',
    availableCaregivers: 40,
    population65Plus: '13.2%',
    metaTitle: 'Senior Care in Palo Alto, CA | Verified Caregivers | Evia',
    metaDescription: 'Find trusted senior caregivers in Palo Alto, CA. Verified, background-checked, and AI-matched. In-home care and dementia care starting at $27/hr. No agency fees.',
    headline: 'Premium Senior Care in Palo Alto, CA',
    subheadline: 'Palo Alto families deserve caregivers who match their standards. Evia\'s AI matching surfaces the top-rated, most experienced caregivers in your neighborhood — fast.',
    nearbyNeighborhoods: ['Downtown Palo Alto', 'Crescent Park', 'Old Palo Alto', 'Midtown', 'Barron Park', 'College Terrace', 'Ventura'],
    localStats: [
      { label: 'Caregivers Available', value: '40+' },
      { label: 'Avg. Hourly Rate', value: '$27–$36' },
      { label: 'Typical Match Time', value: '< 24 hrs' },
      { label: 'Avg. Client Rating', value: '4.9 ★' }
    ],
    testimonial: {
      quote: "The AI match explained exactly why each caregiver was recommended for my father's Parkinson's. That level of personalization — and then being able to video interview — made this the obvious choice.",
      name: "Marcus T.",
      neighborhood: "Crescent Park, Palo Alto"
    },
    nearestCities: ['Menlo Park', 'Mountain View', 'Los Altos', 'Atherton', 'Stanford']
  }
];

export const getCityData = (slug: string): CityData | undefined =>
  cities.find(c => c.slug === slug);
