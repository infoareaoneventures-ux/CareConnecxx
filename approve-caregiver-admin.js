// Approve Caregiver Script using Firebase Admin SDK
// Usage: node approve-caregiver-admin.js <email>

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Firebase Admin
// You'll need to download a service account key from Firebase Console
// Go to Project Settings > Service Accounts > Generate new private key
let app;
try {
  const serviceAccountPath = join(__dirname, 'serviceAccountKey.json');
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  
  app = initializeApp({
    credential: cert(serviceAccount),
    projectId: 'careconnex-d4c8b'
  });
} catch (error) {
  console.log('Service account key not found. Trying with application default credentials...');
  app = initializeApp({
    projectId: 'careconnex-d4c8b'
  });
}

const db = getFirestore(app);

async function approveCaregiver(email) {
  try {
    console.log(`Looking for caregiver with email: ${email}`);
    
    // Query the caregivers collection by email
    const caregiversRef = db.collection('caregivers');
    const snapshot = await caregiversRef.where('email', '==', email).get();
    
    if (snapshot.empty) {
      console.log('No caregiver found with that email in caregivers collection.');
      
      // Try users collection
      const usersRef = db.collection('users');
      const userSnapshot = await usersRef.where('email', '==', email).get();
      
      if (userSnapshot.empty) {
        console.log('No user found with that email either.');
        console.log('\nPossible reasons:');
        console.log('- The caregiver hasn\'t signed up yet');
        console.log('- The email address is different');
        console.log('- Check Firebase Console > Firestore to verify');
        return;
      }
      
      // Update user to be a verified caregiver
      const batch = db.batch();
      userSnapshot.forEach((userDoc) => {
        const userRef = db.collection('users').doc(userDoc.id);
        batch.update(userRef, {
          verificationStatus: 'approved',
          isVerified: true,
          approvedAt: new Date().toISOString(),
          approvedBy: 'admin'
        });
        console.log(`Found user document: ${userDoc.id}`);
      });
      
      await batch.commit();
      console.log(`✅ User ${email} approved as caregiver!`);
      return;
    }
    
    // Update caregiver document
    const batch = db.batch();
    snapshot.forEach((caregiverDoc) => {
      const caregiverRef = db.collection('caregivers').doc(caregiverDoc.id);
      batch.update(caregiverRef, {
        verificationStatus: 'approved',
        isVerified: true,
        approvedAt: new Date().toISOString(),
        approvedBy: 'admin'
      });
      console.log(`Found caregiver document: ${caregiverDoc.id}`);
    });
    
    await batch.commit();
    console.log(`✅ Caregiver ${email} approved successfully!`);
    
  } catch (error) {
    console.error('❌ Error approving caregiver:', error.message);
    if (error.code === 'permission-denied') {
      console.log('\n⚠️  Permission denied. Make sure you have:');
      console.log('1. Firebase Admin SDK service account key');
      console.log('2. Or run: firebase login && firebase emulators:start');
    }
  }
}

const email = process.argv[2] || 'Hm@angelicare.com';
approveCaregiver(email);
