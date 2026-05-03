// Firebase Admin SDK script to create missing user document
// Run this in Firebase Functions or locally with service account

const admin = require('firebase-admin');

// Initialize with service account
admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

async function createUserDocument(email) {
  try {
    // Find user by email
    const userRecord = await auth.getUserByEmail(email);
    const uid = userRecord.uid;
    
    console.log(`Found user: ${uid}`);
    
    // Check if user doc exists
    const userDoc = await db.collection('users').doc(uid).get();
    
    if (userDoc.exists) {
      console.log('User document already exists:', userDoc.data());
      return;
    }
    
    // Create the user document
    await db.collection('users').doc(uid).set({
      uid: uid,
      name: userRecord.displayName || 'Test User',
      email: email,
      userType: 'client',  // or 'caregiver' depending on what you need
      createdAt: new Date().toISOString(),
      isBanned: false,
      verified: true
    });
    
    console.log('User document created successfully!');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run for your email
createUserDocument('imranzaved10@gmail.com');
