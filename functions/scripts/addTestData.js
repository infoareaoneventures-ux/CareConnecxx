const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function addTestData() {
  console.log('Adding test data to Firestore...\n');

  // Add user
  await db.collection('users').doc('test-user-imran').set({
    name: "Imran",
    phone: "+14155551234",
    lovedOneName: "Mom",
    careRecipientName: "Mom",
    careNeeds: ["dementia", "mobility assistance", "meal prep"],
    zipCode: "95050",
    preferences: {
      caregiverGender: "no preference",
      schedule: "weekdays preferred"
    },
    emergencyContact: {
      name: "Sister",
      phone: "+14155555678",
      relationship: "sister"
    },
    appointments: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('✅ User "Imran" added');

  // Add caregivers
  const caregivers = [
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
      cprCertified: true
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
      cprCertified: true
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
      cprCertified: true
    }
  ];

  for (const cg of caregivers) {
    const docRef = await db.collection('caregivers').add({
      ...cg,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✅ Caregiver "${cg.name}" added (ID: ${docRef.id})`);
  }

  console.log('\n✅ All test data added successfully!');
  console.log('\nNow test Cara by sending "Find a caregiver" to your WhatsApp number.');
  process.exit(0);
}

addTestData().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
