// Seed data using Firebase REST API
const PROJECT_ID = 'careconnex-d4c8b';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const FIRST_NAMES = ['Maria', 'John', 'Sarah', 'David', 'Lisa', 'Michael', 'Jennifer', 'Robert', 'Emily', 'James', 'Emma', 'William'];
const LAST_NAMES = ['Garcia', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const SKILLS_POOL = ['Driving', 'Meal Preparation', 'Medication Management', 'Dementia Care', 'Mobility Assistance', 'Bathing', 'Companionship', 'Exercise Support'];
const CERTIFICATIONS_POOL = ['CPR', 'First Aid', 'CNA', 'LVN', 'RN', 'HHA'];
const LOCATIONS = [
  { city: 'Los Angeles', zip: '90210', lat: 34.0901, lng: -118.4065 },
  { city: 'Santa Monica', zip: '90401', lat: 34.0195, lng: -118.4912 },
  { city: 'Beverly Hills', zip: '90210', lat: 34.0736, lng: -118.4004 },
  { city: 'Pasadena', zip: '91101', lat: 34.1478, lng: -118.1445 },
];

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomItems(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function toFirestoreValue(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return value % 1 === 0 ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function createDocument(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = toFirestoreValue(value);
  }
  return { fields };
}

async function seedData() {
  console.log('🌱 Seeding CareConnex Database...\n');
  
  const seededAt = new Date().toISOString();
  const SEED_FLAG = { _seedData: true, seededAt };
  
  // 1. Create Caregivers
  console.log('Creating 12 caregivers...');
  for (let i = 0; i < 12; i++) {
    const firstName = getRandomItem(FIRST_NAMES);
    const lastName = getRandomItem(LAST_NAMES);
    const location = getRandomItem(LOCATIONS);
    const experience = Math.floor(Math.random() * 15) + 1;
    const caregiverId = `caregiver_seed_${i}`;
    
    const caregiver = {
      id: caregiverId,
      uid: caregiverId,
      name: `${firstName} ${lastName}`,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      phone: `555-${String(Math.floor(Math.random() * 8999) + 1000).padStart(4, '0')}`,
      bio: `Experienced caregiver with ${experience} years of experience providing compassionate care for seniors.`,
      hourlyRate: Math.floor(Math.random() * 20) + 20,
      verified: true,
      verificationStatus: 'approved',
      onboardingStatus: 'complete',
      backgroundCheckStatus: 'clear',
      skills: getRandomItems(SKILLS_POOL, Math.floor(Math.random() * 5) + 3),
      certifications: getRandomItems(CERTIFICATIONS_POOL, Math.floor(Math.random() * 3) + 1),
      gender: getRandomItem(['Male', 'Female', 'Non-binary', 'Prefer not to say']),
      instantPayAvailable: Math.random() > 0.3,
      personalityTags: getRandomItems(['Patient', 'Punctual', 'Friendly', 'Professional', 'Experienced'], 3),
      matchScore: Math.floor(Math.random() * 30) + 70,
      rating: Math.round((3.5 + Math.random() * 1.5) * 10) / 10,
      reviewCount: Math.floor(Math.random() * 50) + 5,
      distance: Math.round(Math.random() * 20 * 10) / 10,
      availability: ['Monday', 'Wednesday', 'Friday'],
      latitude: location.lat + (Math.random() - 0.5) * 0.1,
      longitude: location.lng + (Math.random() - 0.5) * 0.1,
      location: `${location.city}, CA ${location.zip}`,
      userType: 'caregiver',
      totalEarnings: Math.floor(Math.random() * 50000) + 5000,
      completedJobs: Math.floor(Math.random() * 100) + 10,
      experience,
      hasTransportation: Math.random() > 0.2,
      isSmoker: Math.random() > 0.9,
      reliabilityScore: Math.floor(Math.random() * 20) + 80,
      acceptsMicroVisits: Math.random() > 0.5,
      ...SEED_FLAG,
    };
    
    try {
      const response = await fetch(`${BASE_URL}/caregivers/${caregiverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createDocument(caregiver))
      });
      if (response.ok) {
        console.log(`  ✓ ${caregiver.name}`);
      } else {
        console.log(`  ✗ ${caregiver.name} - ${response.status}`);
      }
    } catch (e) {
      console.log(`  ✗ ${caregiver.name} - ${e.message}`);
    }
  }
  
  console.log('\n✅ Seeding complete! Refresh the app to see the data.');
}

seedData();
