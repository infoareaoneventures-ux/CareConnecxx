// Firebase Admin SDK script to create missing user document
// Run this in Firebase Functions or locally with service account

// Guard: this script writes to the LIVE project (careconnex-d4c8b). It refuses to run unless you pass --live.
if (!process.argv.includes('--live')) {
  console.error('Refusing to run: fix-missing-user.js writes to the LIVE careconnex-d4c8b project. Re-run with --live to confirm.');
  process.exit(1);
}
process.argv = process.argv.filter((a) => a !== '--live');

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
