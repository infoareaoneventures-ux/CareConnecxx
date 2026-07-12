import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { deriveWeeklyAvailability } from "../agents/caregiverAvailability";
import { canonicalizeCaregiverServices, CANONICAL_SERVICES } from "../agents/caregiverServices";
import { caregiverJobTypesToWebIds } from "../agents/onboardingContract";

const db = admin.firestore();
const CANONICAL_SET = new Set(CANONICAL_SERVICES);

// Order a set of canonical service strings by the canonical enum order.
function orderCanonical(values: Iterable<string>): string[] {
  const set = new Set([...values].filter((v) => CANONICAL_SET.has(v)));
  return CANONICAL_SERVICES.filter((s) => set.has(s));
}

/**
 * One-shot backfill for caregivers onboarded by Evia BEFORE the 2026-07-09
 * care-services + availability parity fix. Three problems it repairs:
 *
 *  1. skills/services held the caregiver's RAW words ("dementia care") which
 *     never matched the webapp's exact checkbox strings ("Dementia / Memory
 *     Care") — so Care Services rendered mostly unchecked and the matching
 *     engine + client cards read non-canonical skills. Re-canonicalize from
 *     specialties (∪ any non-canonical skills), MERGED with any canonical value
 *     already present so a box the caregiver checked in the webapp is never
 *     unchecked.
 *  2. weeklyAvailability was derived with block boundaries that straddled the
 *     webapp grid (evening lit afternoon+evening, overnight lit evening+
 *     overnight) — so the schedule grid showed the wrong/dark blocks and the
 *     matcher dropped cross-midnight slots. Re-derive from the raw `availability`
 *     {days,hours} field at the corrected block boundaries. Gated on the raw
 *     field existing, so webapp-edited availability (no raw field) is untouched.
 *  3. jobTypes (the webapp "Looking for" pills) was never written — only the
 *     underscored jobType. Mirror jobType → jobTypes web ids when absent.
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 * Dry-run with ?dryRun=1 (DEFAULT behavior is a real write — pass dryRun to
 * preview). Reports per-doc before/after for skills so mappings can be eyeballed.
 * Safe to re-run — a doc already canonical + aligned produces an empty patch.
 */
export const backfillCaregiverServiceAvailability = functions
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
      caregiversPatched: 0,
      caregiversSkipped: 0,
      skillsRewritten: 0,
      availabilityRewritten: 0,
      jobTypesFilled: 0,
      // per-doc mapping preview so we can review before a live run
      samples: [] as Array<Record<string, unknown>>,
      errors: [] as string[],
    };

    const cgSnap = await db.collection("caregivers").get();
    for (const doc of cgSnap.docs) {
      try {
        const d = doc.data();
        const patch: Record<string, unknown> = {};
        const sample: Record<string, unknown> = { id: doc.id };

        // ── skills / services canonicalization (merge, never unset) ──────────
        const existingCanonical = orderCanonical([
          ...(Array.isArray(d.skills) ? (d.skills as unknown[]) : []),
          ...(Array.isArray(d.services) ? (d.services as unknown[]) : []),
        ].filter((s): s is string => typeof s === "string"));

        const nonCanonicalSkills = (Array.isArray(d.skills) ? (d.skills as unknown[]) : [])
          .filter((s): s is string => typeof s === "string" && !CANONICAL_SET.has(s));
        const rawForCanon = [
          ...(Array.isArray(d.specialties) ? (d.specialties as unknown[]) : [])
            .filter((s): s is string => typeof s === "string"),
          ...nonCanonicalSkills,
        ];

        let finalSkills = existingCanonical;
        if (rawForCanon.length) {
          const mapped = await canonicalizeCaregiverServices(rawForCanon);
          finalSkills = orderCanonical([...existingCanonical, ...mapped]);
        }
        // Only write when it actually changes the stored value (canonicalizes
        // junk away or adds mappings) — and only when we produced something.
        const currentSkills = Array.isArray(d.skills)
          ? orderCanonical((d.skills as unknown[]).filter((s): s is string => typeof s === "string"))
          : [];
        const skillsChanged =
          finalSkills.length > 0 &&
          (finalSkills.join("|") !== currentSkills.join("|") ||
            !Array.isArray(d.services) ||
            orderCanonical((d.services as unknown[]).filter((s): s is string => typeof s === "string")).join("|") !== finalSkills.join("|"));
        if (skillsChanged) {
          patch.skills = finalSkills;
          patch.services = finalSkills;
          results.skillsRewritten++;
          sample.skills = { from: d.skills ?? null, to: finalSkills };
        }

        // ── weeklyAvailability re-derivation (Evia-sourced only) ─────────────
        // Gated on the raw `availability` {days,hours} — a webapp-edited doc has
        // weeklyAvailability but no raw availability, so it is left alone.
        // STRING-shaped raw availability (deriveWeeklyAvailability parses it
        // since 2026-07-12) only FILLS an empty map — seeded/webapp-authored
        // maps are richer than a free-text re-derivation ("Weekdays and
        // Saturday mornings" would narrow the demo caregivers' 8am–6pm weekday
        // schedule to mornings-only).
        const hasPopulatedDay = Object.values(
          (d.weeklyAvailability ?? {}) as Record<string, unknown>,
        ).some((slots) => Array.isArray(slots) && slots.length > 0);
        if (d.availability && !(typeof d.availability === "string" && hasPopulatedDay)) {
          const rederived = deriveWeeklyAvailability(d.availability);
          if (rederived) {
            const before = JSON.stringify(d.weeklyAvailability ?? null);
            const after = JSON.stringify(rederived);
            if (before !== after) {
              patch.weeklyAvailability = rederived;
              results.availabilityRewritten++;
              sample.availability = { from: d.weeklyAvailability ?? null, to: rederived };
            }
          }
        }

        // ── jobTypes mirror (webapp "Looking for" pills), fill when absent ───
        if (!Array.isArray(d.jobTypes) || d.jobTypes.length === 0) {
          const webIds = caregiverJobTypesToWebIds(d.jobType, d.jobTypes);
          if (webIds.length) {
            patch.jobTypes = webIds;
            results.jobTypesFilled++;
            sample.jobTypes = { from: d.jobType ?? null, to: webIds };
          }
        }

        if (Object.keys(patch).length === 0) {
          results.caregiversSkipped++;
          continue;
        }
        if (results.samples.length < 50) results.samples.push(sample);
        if (!dryRun) await doc.ref.set(patch, { merge: true });
        results.caregiversPatched++;
      } catch (e: any) {
        results.errors.push(`caregivers/${doc.id}: ${e.message}`);
      }
    }

    res.json(results);
  });
