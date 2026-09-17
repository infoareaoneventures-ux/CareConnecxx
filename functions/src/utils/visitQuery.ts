import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * Query the site's `shifts` collection for visits. Until 2026-09-17 this
 * merged the legacy Evia-only `appointments` collection too (the old parallel
 * booking pipeline, retired 2026-09-03 → removed 2026-09-17). The site's My
 * Bookings / Calendar read `shifts` only, so every reminder and check that
 * calls this now sees exactly the visits the family and caregiver see.
 */
export async function queryVisits(params: {
  dateField?: string;
  /** Omit dateOp/dateValue entirely for a status-only query (e.g. "all in-progress visits"). */
  // NEVER pass dateOp:"in" (or "array-contains-any"/"not-in") here — this
  // function always adds its OWN `status in [...]` filter on top, and
  // Firestore allows only one such filter per query, on any field. Use
  // `dateOp:">="` plus `dateUpperBound` instead — a range covers the same dates.
  dateOp?: FirebaseFirestore.WhereFilterOp;
  dateValue?: unknown;
  /** Optional second bound for a range query, e.g. dateOp: ">=" plus dateUpperBound for "<=". */
  dateUpperBound?: string;
  /** Extra equality/range filters (e.g. clientId, caregiverId). */
  extraWhere?: Array<[string, FirebaseFirestore.WhereFilterOp, unknown]>;
  shiftStatuses: string[];
  limit?: number;
}): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (!params.shiftStatuses.length) return [];
  const dateField = params.dateField ?? "date";
  let query: FirebaseFirestore.Query = db.collection("shifts");
  if (params.dateOp !== undefined) query = query.where(dateField, params.dateOp, params.dateValue as string);
  if (params.dateUpperBound !== undefined) query = query.where(dateField, "<=", params.dateUpperBound);
  for (const [field, op, value] of params.extraWhere ?? []) query = query.where(field, op, value);
  if (params.limit !== undefined) query = query.limit(params.limit);
  const snap = await query.where("status", "in", params.shiftStatuses).get();
  return snap.docs;
}

/** Look up a single visit by id, trying `appointments` first, then `shifts`. */
export async function getVisitDoc(
  visitId: string,
): Promise<FirebaseFirestore.DocumentSnapshot> {
  const apptSnap = await db.collection("appointments").doc(visitId).get();
  if (apptSnap.exists) return apptSnap;
  return db.collection("shifts").doc(visitId).get();
}

/**
 * The care recipient's display name for a visit doc from either collection.
 * `appointments` docs carry a top-level `seniorName`; `shifts` docs
 * (shiftGenerator.ts) carry `careRecipients: [{name}]` instead — check
 * both rather than assuming which collection a doc came from.
 */
export function visitSeniorName(
  data: FirebaseFirestore.DocumentData,
  fallback = "your loved one",
): string {
  const careRecipients = data.careRecipients as Array<{ name?: string }> | undefined;
  return (data.seniorName as string | undefined)
    || careRecipients?.[0]?.name
    || (data.clientName as string | undefined)
    || fallback;
}
