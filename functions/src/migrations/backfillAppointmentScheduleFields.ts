import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import {
  normalizeAppointmentDate,
  normalizeAppointmentDuration,
  normalizeAppointmentTime,
} from "../utils/appointmentDoc";

const db = admin.firestore();

export const backfillAppointmentScheduleFields = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const apply = req.query.apply === "true";
  const result = {
    mode: apply ? "APPLY" : "DRY_RUN",
    scanned: 0,
    convertible: 0,
    changed: 0,
    unchanged: 0,
    unconvertible: [] as Array<{ appointmentId: string; missing: string[] }>,
    errors: [] as string[],
  };

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  do {
    let query = db.collection("appointments").orderBy(admin.firestore.FieldPath.documentId()).limit(500);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;

    const batch = db.batch();
    let writes = 0;
    for (const doc of page.docs) {
      result.scanned++;
      try {
        const data = doc.data();
        const date = normalizeAppointmentDate(data.date ?? data.isoDate ?? data.scheduledDate);
        const time = normalizeAppointmentTime(data.time ?? data.startTime);
        const duration = normalizeAppointmentDuration(data.duration, data.durationHours, data.startTime ?? data.time, data.endTime);
        const missing = [!date && "date", !time && "time", !duration && "duration"].filter(Boolean) as string[];
        if (missing.length) {
          result.unconvertible.push({ appointmentId: doc.id, missing });
          continue;
        }
        result.convertible++;
        const patch: Record<string, unknown> = {};
        if (data.date !== date) patch.date = date;
        if (data.time !== time) patch.time = time;
        if (data.duration !== duration) patch.duration = duration;
        if (Object.keys(patch).length === 0) {
          result.unchanged++;
          continue;
        }
        result.changed++;
        if (apply) {
          batch.set(doc.ref, {
            ...patch,
            scheduleFieldsBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
            scheduleFieldsBackfillVersion: "2026-07-12-v1",
          }, { merge: true });
          writes++;
        }
      } catch (error) {
        result.errors.push(`${doc.id}: ${String(error)}`);
      }
    }
    if (apply && writes > 0) await batch.commit();
    cursor = page.docs.at(-1);
    if (page.size < 500) break;
  } while (cursor);

  res.json(result);
});
