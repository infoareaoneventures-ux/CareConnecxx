/**
 * Cleanup User-Created Data Script
 * 
 * This script removes all user-created data from Firebase Firestore
 * while preserving demo/seed data (marked with _seedData: true).
 * 
 * PREREQUISITE: You need a Firebase service account key.
 * 
 * To get one:
 * 1. Go to https://console.firebase.google.com/project/careconnex-d4c8b/settings/serviceaccounts/adminsdk
 * 2. Click "Generate new private key"
 * 3. Save the JSON file as `serviceAccountKey.json` in the `functions/` folder
 * 
 * Run: node scripts/cleanup-user-data.mjs
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = join(__dirname, '../functions/serviceAccountKey.json');

// Check for service account
if (!existsSync(serviceAccountPath)) {
  console.error('❌ ERROR: serviceAccountKey.json not found!\n');
  console.log('To clean up user data, you need a Firebase service account key.\n');
  console.log('Steps to get one:');
  console.log('1. Go to: https://console.firebase.google.com/project/careconnex-d4c8b/settings/serviceaccounts/adminsdk');
  console.log('2. Click "Generate new private key"');
  console.log('3. Save the JSON file as serviceAccountKey.json in the functions/ folder\n');
  console.log('Then run this script again.\n');
  process.exit(1);
}

// Load service account
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

// Initialize Firebase Admin
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const auth = getAuth();

// Collections to clean up
const COLLECTIONS = [
  'users',
  'caregivers',
  'senior_profiles',
  'job_posts',
  'appointments',
  'reviews',
  'support_tickets',
  'notifications',
  'conversations',
  'messages'
];

// Demo emails to preserve (from demoCredentials.ts)
const DEMO_EMAILS = new Set([
  // Clients
  'maria.garcia@example.com',
  'john.smith@example.com',
  'sarah.johnson@example.com',
  'david.williams@example.com',
  'lisa.brown@example.com',
  // Caregivers
  'jennifer.miller@example.com',
  'robert.davis@example.com',
  'emily.rodriguez@example.com',
  'james.martinez@example.com',
  'emma.hernandez@example.com',
  'william.lopez@example.com',
  // Demo users from demoMode.ts
  'demo.client@example.com',
  'demo.caregiver@example.com',
  'demo.admin@example.com'
]);

const stats = {
  firestore: {},
  auth: { checked: 0, deleted: 0, errors: 0, preserved: 0 }
};

async function cleanupFirestoreCollection(collectionName) {
  console.log(`\n📁 Cleaning collection: ${collectionName}`);
  
  const snapshot = await db.collection(collectionName).get();
  let deleted = 0;
  let preserved = 0;
  let errors = 0;
  
  const batch = db.batch();
  let batchCount = 0;
  const BATCH_SIZE = 500;
  
  for (const doc of snapshot.docs) {
    const data = doc.data();
    
    // Check if this is seed/demo data
    const isSeedData = data._seedData === true;
    const email = data.email || '';
    const isDemoEmail = DEMO_EMAILS.has(email.toLowerCase());
    
    if (isSeedData || isDemoEmail) {
      preserved++;
      console.log(`  ✓ Preserved: ${doc.id} (${data.name || data.email || 'no name'})`);
    } else {
      // Delete user-created data
      batch.delete(doc.ref);
      batchCount++;
      deleted++;
      console.log(`  🗑️  Deleting: ${doc.id} (${data.name || data.email || 'no name'})`);
      
      // Commit batch if it reaches the limit
      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batchCount = 0;
      }
    }
  }
  
  // Commit remaining deletes
  if (batchCount > 0) {
    await batch.commit();
  }
  
  stats.firestore[collectionName] = { deleted, preserved, errors };
  console.log(`  ✅ ${collectionName}: ${deleted} deleted, ${preserved} preserved`);
  
  return { deleted, preserved };
}

async function cleanupAuthUsers() {
  console.log('\n\n🔐 Cleaning Firebase Auth users...\n');
  
  let nextPageToken;
  
  do {
    const listResult = await auth.listUsers(1000, nextPageToken);
    nextPageToken = listResult.pageToken;
    
    const usersToDelete = [];
    
    for (const user of listResult.users) {
      stats.auth.checked++;
      
      const email = user.email || '';
      const isDemoEmail = DEMO_EMAILS.has(email.toLowerCase());
      
      // Check if user has seed data marker in Firestore
      let isSeedUser = false;
      try {
        const caregiverDoc = await db.collection('caregivers').doc(user.uid).get();
        const userDoc = await db.collection('users').doc(user.uid).get();
        
        if (caregiverDoc.exists && caregiverDoc.data()._seedData) {
          isSeedUser = true;
        }
        if (userDoc.exists && userDoc.data()._seedData) {
          isSeedUser = true;
        }
      } catch (e) {
        // Ignore errors checking Firestore
      }
      
      if (isDemoEmail || isSeedUser) {
        stats.auth.preserved++;
        console.log(`  ✓ Preserved auth user: ${email || user.uid}`);
      } else {
        usersToDelete.push(user.uid);
        console.log(`  🗑️  Deleting auth user: ${email || user.uid}`);
      }
    }
    
    // Delete users in batches
    if (usersToDelete.length > 0) {
      try {
        await auth.deleteUsers(usersToDelete);
        stats.auth.deleted += usersToDelete.length;
      } catch (error) {
        console.error(`  ❌ Error deleting users:`, error.message);
        stats.auth.errors += usersToDelete.length;
        
        // Try individual deletes
        for (const uid of usersToDelete) {
          try {
            await auth.deleteUser(uid);
            stats.auth.deleted++;
            stats.auth.errors--;
          } catch (e) {
            console.error(`    ❌ Failed to delete ${uid}:`, e.message);
          }
        }
      }
    }
  } while (nextPageToken);
}

async function cleanupUserData() {
  console.log('🧹 Starting user data cleanup...\n');
  console.log('⚠️  This will DELETE all user-created data');
  console.log('✅ Demo/seed data will be PRESERVED\n');
  
  try {
    // Clean up Firestore collections
    for (const collectionName of COLLECTIONS) {
      try {
        await cleanupFirestoreCollection(collectionName);
      } catch (error) {
        console.error(`  ❌ Error cleaning ${collectionName}:`, error.message);
        stats.firestore[collectionName] = { deleted: 0, preserved: 0, errors: 1, errorMessage: error.message };
      }
    }
    
    // Clean up Auth users
    await cleanupAuthUsers();
    
    // Print summary
    console.log('\n\n📊 CLEANUP SUMMARY\n');
    console.log('Firestore Collections:');
    let totalDeleted = 0;
    let totalPreserved = 0;
    
    for (const [name, result] of Object.entries(stats.firestore)) {
      console.log(`  ${name}: ${result.deleted} deleted, ${result.preserved} preserved`);
      totalDeleted += result.deleted;
      totalPreserved += result.preserved;
    }
    
    console.log(`\n  Total Firestore: ${totalDeleted} deleted, ${totalPreserved} preserved`);
    console.log(`\nFirebase Auth:`);
    console.log(`  Checked: ${stats.auth.checked}`);
    console.log(`  Deleted: ${stats.auth.deleted}`);
    console.log(`  Preserved: ${stats.auth.preserved}`);
    console.log(`  Errors: ${stats.auth.errors}`);
    
    console.log('\n✅ Cleanup completed!');
    console.log('\n📝 Note: Demo data is preserved. You can re-run seed scripts if needed.');
    
  } catch (error) {
    console.error('\n❌ Fatal error during cleanup:', error);
    process.exit(1);
  }
}

// Run cleanup
cleanupUserData().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
