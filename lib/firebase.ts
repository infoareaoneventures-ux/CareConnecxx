
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/functions';
import 'firebase/compat/storage';

// Configuration from Environment Variables
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

let app;
let auth: firebase.auth.Auth | undefined;
let db: firebase.firestore.Firestore | undefined;
let functions: firebase.functions.Functions | undefined;
let storage: firebase.storage.Storage | undefined;
let isConfigured = false;

let googleProvider: firebase.auth.GoogleAuthProvider;

try {
  console.log("Firebase config check:", { apiKey: firebaseConfig.apiKey ? "present" : "MISSING", projectId: firebaseConfig.projectId });
  // strict validation
  if (!firebaseConfig.apiKey) {
    throw new Error("Missing Firebase Configuration. Check .env file.");
  }

  // Initialize Firebase
  if (!firebase.apps.length) {
    app = firebase.initializeApp(firebaseConfig);
  } else {
    app = firebase.app();
  }
  auth = firebase.auth();
  googleProvider = new firebase.auth.GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });
  db = firebase.firestore();
  functions = firebase.functions();
  isConfigured = true;
  try {
    storage = firebase.storage();
  } catch (storageError) {
    console.warn('Firebase Storage unavailable:', storageError);
  }
  console.log("🔥 Google Cloud Backend Connected: " + firebaseConfig.projectId);
} catch (error) {
  console.error("Error connecting to Google Cloud:", error);
  // In Phase 8, we do NOT fallback to true. App should fail if config is missing.
  isConfigured = false;
}

// ── Phone Auth: RecaptchaVerifier singleton per container ──────────────────
// Firebase compat requires a RecaptchaVerifier bound to a DOM element before
// signInWithPhoneNumber will resolve. Keeping one per container so React
// remount doesn't leak unrendered instances (each one phones home to Google).
const _recaptchaVerifiers = new Map<string, firebase.auth.RecaptchaVerifier>();

export function getOrCreateRecaptchaVerifier(
  containerId: string,
  options: { size?: 'invisible' | 'normal'; onSolved?: () => void } = {},
): firebase.auth.RecaptchaVerifier {
  const existing = _recaptchaVerifiers.get(containerId);
  if (existing) return existing;
  if (!auth) throw new Error('Firebase auth is not configured');
  const verifier = new firebase.auth.RecaptchaVerifier(containerId, {
    size: options.size ?? 'invisible',
    callback: options.onSolved,
  });
  _recaptchaVerifiers.set(containerId, verifier);
  return verifier;
}

export function clearRecaptchaVerifier(containerId: string): void {
  const v = _recaptchaVerifiers.get(containerId);
  if (v) {
    try { v.clear(); } catch { /* SDK can throw when already cleared */ }
    _recaptchaVerifiers.delete(containerId);
  }
}

export { app, auth, db, functions, storage, isConfigured, googleProvider };
export default firebase;
