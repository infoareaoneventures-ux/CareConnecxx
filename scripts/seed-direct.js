// Direct seed script - run this to populate Firebase with dummy data
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc, writeBatch } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyACFOXqqz1Q0PK3_ROJr1lQNncFCoInwy4",
  authDomain: "careconnex-d4c8b.firebaseapp.com",
  projectId: "careconnex-d4c8b",
  storageBucket: "careconnex-d4c8b.firebasestorage.app",
  messagingSenderId: "406720148887",
  appId: "1:406720148887:web:b80f8a4c2e1b15b5c79c16"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Sample data pools
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

const SEED_DATA_FLAG = { _seedData: true, seededAt: new Date().toISOString() };

async function seedDatabase() {
  console.log('🌱 Starting database seeding...');
  
  try {
    // 1. Create Caregivers
    console.log('Creating caregivers...');
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
        ...SEED_DATA_FLAG,
      };
      
      await setDoc(doc(db, 'caregivers', caregiverId), caregiver);
      console.log(`  ✓ Created caregiver: ${caregiver.name}`);
    }
    
    // 2. Create Clients
    console.log('Creating clients...');
    const clientIds = [];
    for (let i = 0; i < 6; i++) {
      const firstName = getRandomItem(FIRST_NAMES);
      const lastName = getRandomItem(LAST_NAMES);
      const location = getRandomItem(LOCATIONS);
      const age = Math.floor(Math.random() * 25) + 65;
      const clientId = `client_seed_${i}`;
      clientIds.push(clientId);
      
      const userData = {
        uid: clientId,
        name: `${firstName} ${lastName}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
        userType: 'client',
        createdAt: new Date(Date.now() - Math.random() * 10000000000).toISOString(),
        isBanned: false,
        verified: true,
        zipCode: location.zip,
        location: `${location.city}, CA ${location.zip}`,
        latitude: location.lat + (Math.random() - 0.5) * 0.05,
        longitude: location.lng + (Math.random() - 0.5) * 0.05,
        ...SEED_DATA_FLAG,
      };
      
      const seniorProfile = {
        id: i,
        uid: clientId,
        name: `${firstName} ${lastName}`,
        age,
        needs: getRandomItems(['Mobility Assistance', 'Medication Reminders', 'Meal Preparation', 'Companionship', 'Dementia Care'], Math.floor(Math.random() * 4) + 2),
        personality: getRandomItem(['Introvert', 'Extrovert', 'Ambivert']),
        location: `${location.city}, CA`,
        zipCode: location.zip,
        latitude: userData.latitude,
        longitude: userData.longitude,
        phone: `555-${String(Math.floor(Math.random() * 8999) + 1000).padStart(4, '0')}`,
        scheduleNeeded: getRandomItems(['Morning', 'Afternoon', 'Evening', 'Weekends'], Math.floor(Math.random() * 3) + 1),
        genderPreference: getRandomItem(['Female', 'Male', 'No Preference']),
        excludedTags: [],
        familyMembers: [{
          id: `family_${i}`,
          name: getRandomItem(FIRST_NAMES) + ' ' + lastName,
          email: `family${i}@example.com`,
          role: 'admin',
          status: 'active'
        }]
      };
      
      await setDoc(doc(db, 'users', clientId), userData);
      await setDoc(doc(db, 'senior_profiles', clientId), seniorProfile);
      console.log(`  ✓ Created client: ${userData.name}`);
    }
    
    // 3. Create Job Posts
    console.log('Creating job posts...');
    const jobTitles = ['Part-time Caregiver Needed', 'Weekend Companion Care', 'Overnight Care Specialist', 'Dementia Care Expert', 'Live-in Caregiver'];
    for (let i = 0; i < 10; i++) {
      const clientId = getRandomItem(clientIds);
      const location = getRandomItem(LOCATIONS);
      const date = new Date();
      date.setDate(date.getDate() + Math.floor(Math.random() * 30) + 1);
      const jobId = `job_seed_${i}`;
      
      const jobPost = {
        id: jobId,
        clientId,
        clientName: 'Client Name', // Will be updated
        title: getRandomItem(jobTitles),
        description: `Looking for a compassionate caregiver to assist with daily activities.`,
        rate: Math.floor(Math.random() * 15) + 25,
        date: date.toISOString().split('T')[0],
        startTime: `${Math.floor(Math.random() * 4) + 8}:00 AM`,
        endTime: `${Math.floor(Math.random() * 4) + 2}:00 PM`,
        location: `${location.city}, CA ${location.zip}`,
        distance: Math.round(Math.random() * 15 * 10) / 10,
        requirements: getRandomItems(SKILLS_POOL, Math.floor(Math.random() * 3) + 1),
        status: 'open',
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        ...SEED_DATA_FLAG,
      };
      
      await setDoc(doc(db, 'job_posts', jobId), jobPost);
      console.log(`  ✓ Created job post: ${jobPost.title}`);
    }
    
    console.log('\n✅ Database seeding completed successfully!');
    console.log('Created:');
    console.log('  • 12 Caregivers');
    console.log('  • 6 Clients');
    console.log('  • 10 Job Posts');
    
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

seedDatabase();
