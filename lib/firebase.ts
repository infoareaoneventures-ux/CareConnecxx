
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

// ── Admin assist: acting for a person (2026-10-22) ───────────────────────────
// The client pages read the signed-in account in ~35 places (auth.currentUser,
// authService.getCurrentUser(), useAuthUser) for the uid, name, email and photo
// they write under. While an admin acts for a person, that identity IS the
// person: `auth.currentUser` returns a view of the real signed-in user whose
// uid / displayName / email / photoURL / phoneNumber are the person's, while
// every method (getIdToken, reload, sign-out…) still runs on the real admin, so
// callables carry the admin's token (+ actingForUid) and firestore.rules
// actingFor() decides. Set from services/api.ts setActingContext.
export interface ActingAuthIdentity {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
}
let actingIdentity: ActingAuthIdentity | null = null;
let actingView: { real: firebase.User; identity: ActingAuthIdentity; user: firebase.User } | null = null;
export function setActingAuthUser(identity: ActingAuthIdentity | null): void { actingIdentity = identity; actingView = null; }
function actingUserFor(real: firebase.User | null): firebase.User | null {
  if (!actingIdentity || !real) return real;
  // One stable view object per (signed-in user, identity): components compare it by reference.
  if (actingView && actingView.real === real && actingView.identity === actingIdentity) return actingView.user;
  const id = actingIdentity as unknown as Record<string, unknown>;
  const user = new Proxy(real, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in id) return id[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  actingView = { real, identity: actingIdentity, user };
  return user;
}
function withActingUser(real: firebase.auth.Auth): firebase.auth.Auth {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'currentUser') return actingUserFor(target.currentUser);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
let db: firebase.firestore.Firestore | undefined;
let functions: firebase.functions.Functions | undefined;
let storage: firebase.storage.Storage | undefined;
let isConfigured = false;

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
  auth = withActingUser(firebase.auth());
  db = firebase.firestore();
  // Firestore rejects a field whose value is undefined ("Unsupported field value: undefined") and the
  // save fails as a whole. The server has had ignoreUndefinedProperties on since 2026-08; the site gets
  // the same net (2026-10-19, after the first-login wizard broke on an undefined stage): an undefined
  // field is dropped instead of killing the write. Must run before any other Firestore call.
  if (typeof (db as any).settings === "function") {
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* settings already applied (hot reload) */ }
  }
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
// reCAPTCHA can't re-render into the same element, so each verifier gets a fresh child.
const _recaptchaVerifiers = new Map<
  string,
  { verifier: firebase.auth.RecaptchaVerifier; host: HTMLElement | null }
>();
let _recaptchaHostSeq = 0;

export function getOrCreateRecaptchaVerifier(
  containerId: string,
  options: { size?: 'invisible' | 'normal'; onSolved?: () => void } = {},
): firebase.auth.RecaptchaVerifier {
  const existing = _recaptchaVerifiers.get(containerId);
  if (existing) return existing.verifier;
  if (!auth) throw new Error('Firebase auth is not configured');

  const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
  let host: HTMLElement | null = null;
  let target: string | HTMLElement = containerId;
  if (container) {
    host = document.createElement('div');
    host.id = `${containerId}-rc-${++_recaptchaHostSeq}`;
    container.appendChild(host);
    target = host;
  }

  const verifier = new firebase.auth.RecaptchaVerifier(target, {
    size: options.size ?? 'invisible',
    callback: options.onSolved,
  });
  _recaptchaVerifiers.set(containerId, { verifier, host });
  return verifier;
}

export function clearRecaptchaVerifier(containerId: string): void {
  const entry = _recaptchaVerifiers.get(containerId);
  if (entry) {
    try { entry.verifier.clear(); } catch { /* SDK can throw when already cleared */ }
    entry.host?.remove();
    _recaptchaVerifiers.delete(containerId);
  }
}

export { app, auth, db, functions, storage, isConfigured };
export default firebase;
