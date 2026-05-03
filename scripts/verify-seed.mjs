// Verification script for seeded data
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, where } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyACFOXqqz1Q0PK3_ROJr1lQNncFCoInwy4',
  authDomain: 'careconnex-d4c8b.firebaseapp.com',
  projectId: 'careconnex-d4c8b',
  storageBucket: 'careconnex-d4c8b.firebasestorage.app',
  messagingSenderId: '688697288776',
  appId: '1:688697288776:web:771c1b479ee21521d6107d'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function verify() {
  console.log('Verifying seeded data...\n');
  
  const collections = [
    { name: 'caregivers', label: 'Caregivers' },
    { name: 'users', label: 'Users (Clients)' },
    { name: 'job_posts', label: 'Job Posts' },
    { name: 'appointments', label: 'Appointments' },
    { name: 'reviews', label: 'Reviews' },
    { name: 'support_tickets', label: 'Support Tickets' },
    { name: 'notifications', label: 'Notifications' }
  ];
  
  const counts = {};
  
  for (const col of collections) {
    const q = query(collection(db, col.name), where('_seedData', '==', true));
    const snapshot = await getDocs(q);
    counts[col.label] = snapshot.size;
    console.log(`${col.label}: ${snapshot.size} records`);
  }
  
  // Verify caregivers have verificationStatus: 'approved'
  const caregiverQuery = query(
    collection(db, 'caregivers'), 
    where('_seedData', '==', true), 
    where('verificationStatus', '==', 'approved')
  );
  const approvedCaregivers = await getDocs(caregiverQuery);
  console.log(`\nCaregivers with verificationStatus='approved': ${approvedCaregivers.size}/12`);
  
  // Verify senior_profiles
  const seniorQuery = query(collection(db, 'senior_profiles'), where('_seedData', '==', true));
  const seniors = await getDocs(seniorQuery);
  console.log(`Senior Profiles: ${seniors.size} records`);
  
  console.log('\n--- VERIFICATION SUMMARY ---');
  const expected = {
    'Caregivers': 12,
    'Users (Clients)': 6,
    'Senior Profiles': 6,
    'Job Posts': 10,
    'Appointments': 20,
    'Reviews': 25,
    'Support Tickets': 8,
    'Notifications': 15
  };
  
  let allGood = true;
  for (const [key, expectedCount] of Object.entries(expected)) {
    const actual = counts[key] || seniors.size;
    const status = actual === expectedCount ? '✅' : '❌';
    if (actual !== expectedCount) allGood = false;
    console.log(`${status} ${key}: ${actual}/${expectedCount}`);
  }
  
  if (approvedCaregivers.size === 12) {
    console.log('✅ All caregivers have verificationStatus: approved');
  } else {
    console.log('❌ Not all caregivers are approved');
    allGood = false;
  }
  
  if (allGood) {
    console.log('\n🎉 All data verified successfully!');
  } else {
    console.log('\n⚠️ Some data counts do not match expected values');
    process.exit(1);
  }
}

verify().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
