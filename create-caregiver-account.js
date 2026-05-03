// Create Caregiver Account Script
// Uses Firebase Client SDK to create a caregiver account

import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyB8z0z8z8z8z8z8z8z8z8z8z8z8z8z8z8z8",
  authDomain: "careconnex-d4c8b.firebaseapp.com",
  projectId: "careconnex-d4c8b",
  storageBucket: "careconnex-d4c8b.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

async function createCaregiverAccount() {
  const email = 'testcaregiveraccept@example.com';
  const password = 'TestPass123!';
  const name = 'Test Caregiver Accept';
  
  try {
    console.log('Creating caregiver account...');
    
    // Create user in Firebase Auth
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    await updateProfile(user, { displayName: name });
    
    console.log('User created:', user.uid);
    
    // Create user document
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      name: name,
      email: email,
      userType: 'caregiver',
      createdAt: new Date().toISOString(),
      isBanned: false,
      verified: true,
      verificationStatus: 'approved',
      phone: '+15559876543'
    });
    
    // Create caregiver document
    await setDoc(doc(db, 'caregivers', user.uid), {
      uid: user.uid,
      name: name,
      email: email,
      hourlyRate: 25,
      verified: true,
      verificationStatus: 'approved',
      instantPayAvailable: false,
      personalityTags: ['Compassionate', 'Reliable'],
      matchScore: 95,
      distance: 1.5,
      availability: [],
      backgroundCheckStatus: 'approved',
      certifications: ['CNA', 'CPR'],
      bio: 'Experienced caregiver with 5+ years in senior care.',
      yearsExperience: 5,
      location: 'San Jose, CA',
      hasTransportation: true
    });
    
    console.log('✅ Caregiver account created successfully!');
    console.log('Email:', email);
    console.log('Password:', password);
    console.log('UID:', user.uid);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code === 'auth/email-already-in-use') {
      console.log('Account already exists. You can log in with:');
      console.log('Email:', email);
      console.log('Password:', password);
    }
  }
}

createCaregiverAccount();
