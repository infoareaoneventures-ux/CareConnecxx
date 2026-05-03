// populateCaregivers.js - Add dummy caregivers to Firestore for testing
const admin = require('firebase-admin');

// Initialize if not already done
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const dummyCaregivers = [
  {
    name: "Maria Gonzalez",
    phone: "+14155551001",
    email: "maria.g@careconnex.com",
    hourlyRate: 28,
    skills: ["dementia", "bathing", "meal prep", "medication reminders"],
    zipCode: "95050",
    yearsExperience: 8,
    rating: 4.9,
    verified: true,
    active: true,
    bio: "Experienced caregiver specializing in dementia care. Fluent in Spanish and English.",
    availability: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    backgroundChecked: true,
    cprCertified: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "David Kim",
    phone: "+14155551002",
    email: "david.kim@careconnex.com",
    hourlyRate: 32,
    skills: ["mobility assistance", "physical therapy", "meal prep", "companionship"],
    zipCode: "95050",
    yearsExperience: 12,
    rating: 4.8,
    verified: true,
    active: true,
    bio: "Former physical therapist assistant. Gentle, patient, and great with seniors.",
    availability: ["Monday", "Wednesday", "Friday", "Saturday", "Sunday"],
    backgroundChecked: true,
    cprCertified: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Jennifer Walsh",
    phone: "+14155551003",
    email: "jennifer.w@careconnex.com",
    hourlyRate: 26,
    skills: ["companionship", "meal prep", "light housekeeping", "transportation"],
    zipCode: "95051",
    yearsExperience: 5,
    rating: 5.0,
    verified: true,
    active: true,
    bio: "RN background, now providing compassionate in-home care. Excellent references.",
    availability: ["Tuesday", "Thursday", "Saturday", "Sunday"],
    backgroundChecked: true,
    cprCertified: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Robert Chen",
    phone: "+14155551004",
    email: "robert.chen@careconnex.com",
    hourlyRate: 30,
    skills: ["dementia", "Alzheimer's", "medication management", "cooking"],
    zipCode: "95050",
    yearsExperience: 15,
    rating: 4.9,
    verified: true,
    active: true,
    bio: "Specialized in memory care. Patient, kind, and experienced with challenging behaviors.",
    availability: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    backgroundChecked: true,
    cprCertified: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    name: "Amanda Foster",
    phone: "+14155551005",
    email: "amanda.f@careconnex.com",
    hourlyRate: 27,
    skills: ["personal care", "bathing", "grooming", "mobility assistance"],
    zipCode: "95054",
    yearsExperience: 6,
    rating: 4.7,
    verified: true,
    active: true,
    bio: "Compassionate caregiver with a background in nursing assistance.",
    availability: ["Monday", "Tuesday", "Friday", "Saturday", "Sunday"],
    backgroundChecked: true,
    cprCertified: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }
];

async function populateCaregivers() {
  console.log('Populating caregivers...');
  
  for (const caregiver of dummyCaregivers) {
    const docRef = db.collection('caregivers').doc();
    await docRef.set(caregiver);
    console.log(`✅ Added: ${caregiver.name} (ID: ${docRef.id})`);
  }
  
  console.log(`\n✅ Successfully added ${dummyCaregivers.length} caregivers!`);
  console.log('\nTest Cara now by messaging: "Find a caregiver"');
}

populateCaregivers().catch(console.error);
