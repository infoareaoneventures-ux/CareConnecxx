// Check Job Posts in Firestore
// This script queries the job_posts collection to verify if jobs are being created

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Firebase Admin
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

async function checkJobPosts() {
  try {
    console.log('Querying job_posts collection...\n');
    
    const jobPostsRef = db.collection('job_posts');
    const snapshot = await jobPostsRef.orderBy('createdAt', 'desc').limit(10).get();
    
    if (snapshot.empty) {
      console.log('❌ No job posts found in the database.');
      return;
    }
    
    console.log(`✅ Found ${snapshot.size} job post(s):\n`);
    
    snapshot.forEach((doc, index) => {
      const job = doc.data();
      console.log(`--- Job ${index + 1} ---`);
      console.log(`ID: ${doc.id}`);
      console.log(`Title: ${job.title || 'N/A'}`);
      console.log(`Client: ${job.clientName || 'N/A'} (${job.clientId || 'N/A'})`);
      console.log(`Date: ${job.date || 'N/A'}`);
      console.log(`Location: ${job.location || 'N/A'}`);
      console.log(`Rate: $${job.rate || 'N/A'}/hr`);
      console.log(`Status: ${job.status || 'N/A'}`);
      console.log(`Created: ${job.createdAt || 'N/A'}`);
      console.log('');
    });
    
  } catch (error) {
    console.error('❌ Error querying job posts:', error.message);
    if (error.code === 'permission-denied') {
      console.log('\n⚠️  Permission denied. You need Firebase Admin SDK service account key.');
      console.log('Get it from: Firebase Console > Project Settings > Service Accounts > Generate new private key');
    }
  }
}

checkJobPosts();
