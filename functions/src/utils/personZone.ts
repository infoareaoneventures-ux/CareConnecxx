// The time zone a PERSON is in, for showing them one-off events (an interview) in their own clock.
// Derived from where they live: a stamped `timeZone`, else their ZIP (care provider: home ZIP; family: home or care
// ZIP), else Pacific. Never throws — a missing record is just the default. (2026-11-09, all U.S. zones.)
import * as admin from "firebase-admin";
import { careZoneOf, DEFAULT_CARE_TZ } from "./careTime";

export async function zoneForUser(uid: unknown): Promise<string> {
  if (typeof uid !== "string" || !uid) return DEFAULT_CARE_TZ;
  try {
    const db = admin.firestore();
    const [u, c] = await Promise.all([db.collection("users").doc(uid).get(), db.collection("caregivers").doc(uid).get()]);
    for (const d of [u.exists ? u.data() : undefined, c.exists ? c.data() : undefined] as Array<Record<string, unknown> | undefined>) {
      if (!d) continue;
      const z = careZoneOf({ timeZone: d.timeZone, zipCode: d.zipCode ?? d.homeZipCode ?? d.zip, address: d.address ?? d.homeStreet });
      if (d.timeZone || d.zipCode || d.homeZipCode || d.zip) return z;
    }
  } catch { /* fall through */ }
  return DEFAULT_CARE_TZ;
}
