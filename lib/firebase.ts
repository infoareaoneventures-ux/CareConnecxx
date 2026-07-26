
import firebase from 'firebase/compat/app';
import { getApp as getModularApp } from 'firebase/app';
import {
  getFunctions as getModularFunctions,
  type Functions as ModularFunctions,
} from 'firebase/functions';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/functions';
import 'firebase/compat/storage';
import 'firebase/compat/app-check';

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
let childcareFunctions: ModularFunctions | undefined;
let isConfigured = false;
export interface AppCheckRuntimeStatus {
  configured: boolean;
  activated: boolean;
  error: string | null;
}
const appCheckRuntimeStatus: AppCheckRuntimeStatus = {
  configured: false,
  activated: false,
  error: null,
};

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
  db = firebase.firestore();
  functions = firebase.functions();
  childcareFunctions = getModularFunctions(getModularApp());
  isConfigured = true;

  // ── App Check (childcare U2 / plan 2026-07-22-002 KTD22) ──────────────────
  // Activates ONLY when VITE_APPCHECK_SITE_KEY is present; absent key = no-op,
  // so current senior clients are completely unaffected. Server-side
  // enforcement scopes to the NEW childcare callables via
  // functions/src/childcare/requireAppCheck.ts (CHILDCARE_APPCHECK_MODE:
  // monitor by default, enforce after provider registration is verified).
  //
  // TODO(founder): register the App Check reCAPTCHA v3 provider for this web
  // app in the Firebase console, then set VITE_APPCHECK_SITE_KEY in .env and
  // rebuild. Until then this block never runs.
  const appCheckSiteKey = import.meta.env.VITE_APPCHECK_SITE_KEY as string | undefined;
  const debugToken = (
    globalThis as typeof globalThis & {
      FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
    }
  ).FIREBASE_APPCHECK_DEBUG_TOKEN;
  if (import.meta.env.PROD && debugToken !== undefined && debugToken !== false) {
    throw new Error('Firebase App Check debug tokens are prohibited in production builds.');
  }
  appCheckRuntimeStatus.configured = Boolean(appCheckSiteKey);
  if (appCheckSiteKey) {
    try {
      // Compat API: a string activates the reCAPTCHA v3 provider with that
      // site key; `true` enables automatic token refresh.
      firebase.appCheck().activate(appCheckSiteKey, true);
      appCheckRuntimeStatus.activated = true;
      console.log('App Check activated (reCAPTCHA v3).');
    } catch (appCheckError) {
      // Never let App Check break the app — enforcement is server-side and
      // childcare-scoped; senior surfaces must keep working regardless.
      appCheckRuntimeStatus.error =
        appCheckError instanceof Error ? appCheckError.message : 'App Check activation failed';
      if (import.meta.env.PROD) throw appCheckError;
      console.warn('App Check activation failed:', appCheckError);
    }
  }
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

export {
  app,
  auth,
  db,
  functions,
  storage,
  childcareFunctions,
  appCheckRuntimeStatus,
  isConfigured,
};
export default firebase;
