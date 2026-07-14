import { useState, useEffect } from 'react';
import type firebase from 'firebase/compat/app';
import { auth } from '../lib/firebase';

/**
 * The current Firebase Auth user, reactive to auth-state changes.
 *
 * Components that read `auth?.currentUser` directly get a null snapshot on a hard
 * refresh (before the persisted session rehydrates) and then NEVER re-render when
 * it resolves — so their data-loading effects (typically keyed on `user?.uid`)
 * bail once and never run again, leaving the page stuck empty (e.g. a client who
 * can't see/approve timesheets → caregivers never paid). This hook subscribes to
 * onAuthStateChanged so the component re-renders when auth resolves and those
 * effects fire. Falls back to the current snapshot when auth is already resolved.
 */
export function useAuthUser(): firebase.User | null {
  const [user, setUser] = useState<firebase.User | null>(() => auth?.currentUser ?? null);

  useEffect(() => {
    if (!auth) return;
    const unsub = auth.onAuthStateChanged((u) => setUser(u));
    return () => unsub();
  }, []);

  return user;
}
