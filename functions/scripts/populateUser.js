// populateUser.js - Add test user profile
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function populateUser() {
  const userData = {
    name: "Imran",
    email: "imran@careconnex.com",
    phone: "+14155551234",  // Update with your actual WhatsApp number
    lovedOneName: "Mom",
    careRecipientName: "Mom",
    careNeeds: ["dementia", "mobility assistance", "meal prep"],
    zipCode: "95050",
    preferences: {
      caregiverGender: "no preference",
      schedule: "weekdays preferred",
      language: "English"
    },
    emergencyContact: {
      name: "Sister",
      phone: "+14155555678",
      relationship: "sister"
    },
    familyMembers: [
      {
        name: "Sister",
        phone: "+14155555678",
        relationship: "sister"
      }
    ],
    appointments: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  
  // Create or update user
  const userRef = db.collection('users').doc('test-user-imran');
  await userRef.set(userData);
  
  console.log('✅ User profile created!');
  console.log(`User ID: ${userRef.id}`);
  console.log(`Name: ${userData.name}`);
  console.log(`Loved one: ${userData.lovedOneName}`);
  console.log(`Care needs: ${userData.careNeeds.join(', ')}`);
}

populateUser().catch(console.error);
