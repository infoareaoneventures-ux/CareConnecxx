import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { deriveWeeklyAvailability } from "../agents/caregiverAvailability";

const db = admin.firestore();

/**
 * One-shot backfill for SMS/iMessage-onboarded users created BEFORE the
 * 2026-07-05 field-parity fix in onboardingConversation.ts. Evia wrote
 * conversational field names (yearsExperience, canDrive, specialties,
 * seniorName, careNeeds) while the webapp reads the contract names
 * (experience, hasTransportation, skills, recipientName, careTypes) — so
 * existing profiles render with blank experience/skills/transportation and
 * blank care-request summaries. This copies each value to the name the web
 * reads, without touching the originals.
 *
 * - caregivers: experience ← yearsExperience, hasTransportation ← canDrive,
 *   skills ← specialties ∪ skills, weeklyAvailability ← derived from
 *   availability {days, hours}. Only fills MISSING targets — never overwrites.
 * - clientIntakes: recipientName ← seniorName, careTypes ← careNeeds,
 *   contactName ← firstName, schedule ← "N days/week, timeOfDay" string.
 * - senior_profiles/{userId}: location ← intake city when absent.
 * - users: uid field ← doc id when absent (services/api.ts getUser gates on it).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 — reports what would change, writes nothing.
 * Safe to re-run — docs already carrying the web-contract fields are skipped.
 */
export const backfillEviaProfileFields = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (req, res) => {
    const adminSecret = req.headers["x-admin-secret"];
    if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    const results = {
      dryRun,
      caregiversPatched:     0,
      caregiversSkipped:     0,
      intakesPatched:        0,
      intakesSkipped:        0,
      seniorProfilesPatched: 0,
      usersUidPatched:       0,
      errors:                [] as string[],
    };

    // ── caregivers ─────────────────────────────────────────────────────────
    const cgSnap = await db.collection("caregivers").get();
    for (const doc of cgSnap.docs) {
      try {
        const d = doc.data();
        const patch: Record<string, unknown> = {};
        if (d.experience === undefined && d.yearsExperience !== undefined) {
          patch.experience = d.yearsExperience;
        }
        if (d.hasTransportation === undefined && d.canDrive !== undefined) {
          patch.hasTransportation = d.canDrive;
        }
        const mergedSkills = Array.from(new Set([
          ...(Array.isArray(d.skills)      ? d.skills      as string[] : []),
          ...(Array.isArray(d.specialties) ? d.specialties as string[] : []),
        ]));
        if ((!Array.isArray(d.skills) || d.skills.length === 0) && mergedSkills.length) {
          patch.skills = mergedSkills;
        }
        if (d.weeklyAvailability === undefined && d.availability) {
          const weekly = deriveWeeklyAvailability(d.availability);
          if (weekly) patch.weeklyAvailability = weekly;
        }
        if (Object.keys(patch).length === 0) {
          results.caregiversSkipped++;
          continue;
        }
        if (!dryRun) await doc.ref.set(patch, { merge: true });
        results.caregiversPatched++;
      } catch (e: any) {
        results.errors.push(`caregivers/${doc.id}: ${e.message}`);
      }
    }

    // ── clientIntakes (+ senior_profiles location join) ─────────────────────
    const intakeSnap = await db.collection("clientIntakes").get();
    for (const doc of intakeSnap.docs) {
      try {
        const d = doc.data();
        const patch: Record<string, unknown> = {};
        if (!d.recipientName && d.seniorName) {
          patch.recipientName      = d.seniorName;
          patch.recipientFirstName = String(d.seniorName).split(" ")[0];
        }
        if ((!Array.isArray(d.careTypes) || d.careTypes.length === 0) && Array.isArray(d.careNeeds)) {
          patch.careTypes = d.careNeeds;
        }
        if (!d.contactName && d.firstName) patch.contactName = d.firstName;
        if (!d.schedule) {
          const scheduleText = [
            d.daysPerWeek ? `${d.daysPerWeek} days/week` : "",
            (d.timeOfDay as string) ?? "",
            d.hoursPerDay ? `${d.hoursPerDay} hrs/day` : "",
          ].filter(Boolean).join(", ");
          if (scheduleText) patch.schedule = scheduleText;
        }
        if (Object.keys(patch).length === 0) {
          results.intakesSkipped++;
        } else {
          if (!dryRun) await doc.ref.set(patch, { merge: true });
          results.intakesPatched++;
        }

        // senior_profiles/{userId}.location from the intake's city
        const userId = d.userId as string | undefined;
        if (userId && d.city) {
          const snRef  = db.collection("senior_profiles").doc(userId);
          const snSnap = await snRef.get();
          if (snSnap.exists && !snSnap.data()?.location) {
            if (!dryRun) await snRef.set({ location: d.city }, { merge: true });
            results.seniorProfilesPatched++;
          }
        }
      } catch (e: any) {
        results.errors.push(`clientIntakes/${doc.id}: ${e.message}`);
      }
    }

    // ── users: uid field must exist IN the doc (getUser gates on data.uid) ──
    const usersSnap = await db.collection("users").get();
    for (const doc of usersSnap.docs) {
      try {
        if (doc.data().uid === undefined) {
          if (!dryRun) await doc.ref.set({ uid: doc.id }, { merge: true });
          results.usersUidPatched++;
        }
      } catch (e: any) {
        results.errors.push(`users/${doc.id}: ${e.message}`);
      }
    }

    res.json(results);
  });
