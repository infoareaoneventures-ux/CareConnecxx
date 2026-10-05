// Evia's texting number, from the server (config/public, published from the
// functions env — functions/src/publicConfig.ts). The build-time VITE value is only
// the fallback until the doc is read, so a stale .env on a build machine can no
// longer send "Text Evia" links to an old line (founder, 2026-10-04).
import { useEffect, useState } from 'react';
import { db } from './firebase';

let cached: string = ((import.meta.env.VITE_LINQ_PHONE_NUMBER as string | undefined) || '').trim();
let inflight: Promise<string> | null = null;

export function loadEviaPhone(): Promise<string> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (db) {
        const snap = await db.collection('config').doc('public').get();
        const v = snap.exists ? (snap.data() as { eviaPhone?: unknown } | undefined)?.eviaPhone : null;
        if (typeof v === 'string' && v.trim()) cached = v.trim();
      }
    } catch { /* keep the fallback */ }
    return cached;
  })();
  return inflight;
}

/** The last known number, synchronously — for screens rendered after a component already called useEviaPhone(). */
export function eviaPhoneNow(): string { return cached; }

export function useEviaPhone(): string {
  const [phone, setPhone] = useState(cached);
  useEffect(() => {
    let on = true;
    loadEviaPhone().then((p) => { if (on) setPhone(p); });
    return () => { on = false; };
  }, []);
  return phone;
}
