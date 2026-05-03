import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

// Initialize with default credentials (works if you're logged in via firebase CLI)
const app = initializeApp({
  projectId: 'careconnex-d4c8b',
  storageBucket: 'careconnex-d4c8b.appspot.com'
});

const storage = getStorage(app);
const bucket = storage.bucket();

const corsConfig = [
  {
    origin: ['https://careconnex-d4c8b.web.app', 'http://localhost:5173'],
    method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'],
    maxAgeSeconds: 3600,
    responseHeader: ['Content-Type', 'Authorization', 'x-goog-resumable']
  }
];

async function setCors() {
  try {
    await bucket.setCorsConfiguration(corsConfig);
    console.log('✅ CORS configuration set successfully!');
    console.log('Origins allowed:', corsConfig[0].origin);
  } catch (error) {
    console.error('❌ Error setting CORS:', error.message);
    process.exit(1);
  }
}

setCors();
