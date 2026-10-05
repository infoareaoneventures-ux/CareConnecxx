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
    metaTitle: 'Senior Care in San Jose, CA | In-Home Caregivers | Evia',
    metaDescription: 'Find in-home senior caregivers in San Jose, CA who have completed a background check, for companion care, personal care, dementia care and respite care.',
    headline: 'Trusted Senior Care in San Jose, CA',
    subheadline: 'Connect with caregivers across San Jose, from Willow Glen to East San Jose, who have completed a background check. Read their profiles and interview before you book.',
    nearbyNeighborhoods: ['Willow Glen', 'Almaden Valley', 'Berryessa', 'Evergreen', 'Silver Creek', 'Cambrian', 'Blossom Hill', 'Downtown San Jose'],
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
    metaDescription: 'Find in-home senior caregivers in Mountain View, CA who have completed a background check, for in-home care, dementia care and respite care.',
    headline: 'In-Home Senior Care in Mountain View, CA',
    subheadline: 'Caregivers serving Mountain View families, each with a completed background check and a reviewed profile. Read reviews from families and interview before you book.',
    nearbyNeighborhoods: ['Crestview', 'Old Mountain View', 'Rex Manor', 'Gemello', 'Shoreline West', 'Monta Loma'],
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
    metaTitle: 'Senior Care in Santa Clara, CA | Caregivers | Evia',
    metaDescription: 'Find in-home senior caregivers in Santa Clara, CA who have completed a background check, for companion care, personal care and dementia care.',
    headline: 'Senior Care in Santa Clara, CA',
    subheadline: 'Find caregivers in Santa Clara for companion care, personal care, and dementia care, each with a completed background check. $29.95 a month for families, plus a 9% service fee on each visit.',
    nearbyNeighborhoods: ['Central Santa Clara', 'Rivermark', 'Santa Clara Square', 'Agnew', 'Bowers'],
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
    metaDescription: 'Find in-home senior caregivers in Sunnyvale, CA who have completed a background check, matched to your care needs, schedule and distance.',
    headline: 'Trusted In-Home Care in Sunnyvale, CA',
    subheadline: 'Serving Sunnyvale families with caregivers for companion care, personal care, Alzheimer\'s support, and respite care. Caregivers set their own rates and keep 100% of them.',
    nearbyNeighborhoods: ['Murphy Ave District', 'Lakewood', 'Borregas', 'Raynor Park', 'Cherry Chase', 'Ponderosa Park'],
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
    metaTitle: 'Senior Care in Palo Alto, CA | Caregivers | Evia',
    metaDescription: 'Find in-home senior caregivers in Palo Alto, CA who have completed a background check, for in-home care and dementia care.',
    headline: 'Senior Care in Palo Alto, CA',
    subheadline: 'Caregivers serving Palo Alto families, matched to your care needs, schedule and distance, each with a completed background check and a reviewed profile.',
    nearbyNeighborhoods: ['Downtown Palo Alto', 'Crescent Park', 'Old Palo Alto', 'Midtown', 'Barron Park', 'College Terrace', 'Ventura'],
    nearestCities: ['Menlo Park', 'Mountain View', 'Los Altos', 'Atherton', 'Stanford']
  }
];

export const getCityData = (slug: string): CityData | undefined =>
  cities.find(c => c.slug === slug);
