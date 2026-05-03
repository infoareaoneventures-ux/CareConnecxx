// Approve Caregiver Script
// Usage: node approve-caregiver.js <email>

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';

// Firebase config - same as in your app
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "YOUR_API_KEY",
  authDomain: "careconnex-d4c8b.firebaseapp.com",
  projectId: "careconnex-d4c8b",
  storageBucket: "careconnex-d4c8b.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function approveCaregiver(email) {
  try {
    console.log(`Looking for caregiver with email: ${email}`);
    
    // Query the caregivers collection by email
    const caregiversRef = collection(db, 'caregivers');
    const q = query(caregiversRef, where('email', '==', email));
    const querySnapshot = await getDocs(q);
    
    if (querySnapshot.empty) {
      console.log('No caregiver found with that email.');
      
      // Try users collection
      const usersRef = collection(db, 'users');
      const userQuery = query(usersRef, where('email', '==', email));
      const userSnapshot = await getDocs(userQuery);
      
      if (userSnapshot.empty) {
        console.log('No user found with that email either.');
        return;
      }
      
      // Update user to be a verified caregiver
      userSnapshot.forEach(async (userDoc) => {
        const userRef = doc(db, 'users', userDoc.id);
        await updateDoc(userRef, {
          verificationStatus: 'approved',
          isVerified: true,
          approvedAt: new Date().toISOString(),
          approvedBy: 'admin'
        });
        console.log(`User ${email} approved as caregiver!`);
      });
      return;
    }
    
    // Update caregiver document
    querySnapshot.forEach(async (caregiverDoc) => {
      const caregiverRef = doc(db, 'caregivers', caregiverDoc.id);
      await updateDoc(caregiverRef, {
        verificationStatus: 'approved',
        isVerified: true,
        approvedAt: new Date().toISOString(),
        approvedBy: 'admin'
      });
      console.log(`Caregiver ${email} approved successfully!`);
      console.log(`Document ID: ${caregiverDoc.id}`);
    });
    
  } catch (error) {
    console.error('Error approving caregiver:', error);
  }
}

const email = process.argv[2] || 'Hm@angelicare.com';
approveCaregiver(email);
