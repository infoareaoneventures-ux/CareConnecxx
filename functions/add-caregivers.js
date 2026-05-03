const admin = require('firebase-admin');

// Initialize with your service account (you'll need to provide this)
// Or use application default credentials
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'careconnex-d4c8b'
  });
}

const db = admin.firestore();

const caregivers = [
  {
    name: "Maria Gonzalez",
    phone: "+14155551001",
    hourlyRate: 28,
    skills: ["dementia", "bathing", "meal prep", "medication reminders"],
    specialties: ["dementia", "alzheimer care", "meal preparation"],
    serviceZipCodes: ["95050", "95051", "95054"],
    yearsExperience: 8,
    rating: 4.9,
    verified: true,
    available: true,
    bio: "Experienced caregiver specializing in dementia care. Fluent in Spanish and English."
  },
  {
    name: "David Kim",
    phone: "+14155551002",
    hourlyRate: 32,
    skills: ["mobility assistance", "physical therapy", "meal prep", "companionship"],
    specialties: ["mobility assistance", "fall prevention", "physical therapy"],
    serviceZipCodes: ["95050", "95051", "95125"],
    yearsExperience: 12,
    rating: 4.8,
    verified: true,
    available: true,
    bio: "Former physical therapist assistant. Specializes in mobility and fall prevention."
  },
  {
    name: "Jennifer Walsh",
    phone: "+14155551003",
    hourlyRate: 26,
    skills: ["companionship", "meal prep", "light housekeeping", "transportation"],
    specialties: ["companionship", "meal preparation", "medication management"],
    serviceZipCodes: ["95125", "95124", "95118"],
    yearsExperience: 5,
    rating: 5.0,
    verified: true,
    available: true,
    bio: "RN background, now providing compassionate in-home care. Specializes in medication management."
  }
];

async function addCaregivers() {
  for (const caregiver of caregivers) {
    const docRef = db.collection('caregivers').doc();
    await docRef.set({
      ...caregiver,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Added: ${caregiver.name} (${docRef.id})`);
  }
  console.log('Done!');
}

addCaregivers().catch(console.error);
