import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * Query both `appointments` and `shifts` for visits matching a date filter,
 * merged into one docs[] array of real QueryDocumentSnapshots (so `.id`,
 * `.data()`, and `.ref` all behave exactly as a single-collection query would
 * — a caller can drop this in as a direct replacement for a
 * `db.collection("appointments").where(...).get()` call without touching the
 * rest of its loop body).
 *
 * The booking_requests/shifts pipeline (2026-08-30) means a visit booked via
 * Evia's newer flow never appears in `appointments` at all — every scheduled
 * job that reads "what visits are happening" needs both collections to see
 * it. The two collections use different status vocabularies: a `shifts` doc
 * is never created until the caregiver has already accepted (see
 * bookingExecutor.ts's writeConfirmedShifts), so there is no
 * "pending_caregiver_confirmation" equivalent for shifts — pass
 * apptStatuses/shiftStatuses separately rather than one shared list.
 */
export async function queryVisitsMerged(params: {
  dateField?: string;
  /** Omit dateOp/dateValue entirely for a status-only query (e.g. "all in-progress visits"). */
  // NEVER pass dateOp:"in" (or "array-contains-any"/"not-in") here — this
  // function always adds its OWN `status in [...]` filter on top, and
  // Firestore allows only one such filter per query, on any field. A caller
  // that did this (2026-08-31, upcomingVisitReminder.ts wanting "today or
  // tomorrow") threw INVALID_ARGUMENT on every single run. Use `dateOp:">="`
  // plus `dateUpperBound` instead — a range covers the same dates.
  dateOp?: FirebaseFirestore.WhereFilterOp;
  dateValue?: unknown;
  /** Optional second bound for a range query, e.g. dateOp: ">=" plus dateUpperBound for "<=". */
  dateUpperBound?: string;
  /** Extra equality/range filters applied to BOTH collections (e.g. clientId, caregiverId). */
  extraWhere?: Array<[string, FirebaseFirestore.WhereFilterOp, unknown]>;
  apptStatuses: string[];
  shiftStatuses: string[];
  limit?: number;
}): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const dateField = params.dateField ?? "date";
  const applyFilters = (q: FirebaseFirestore.Query) => {
    let query = q;
    if (params.dateOp !== undefined) query = query.where(dateField, params.dateOp, params.dateValue as string);
    if (params.dateUpperBound !== undefined) query = query.where(dateField, "<=", params.dateUpperBound);
    for (const [field, op, value] of params.extraWhere ?? []) query = query.where(field, op, value);
    if (params.limit !== undefined) query = query.limit(params.limit);
    return query;
  };
  const [apptSnap, shiftSnap] = await Promise.all([
    params.apptStatuses.length
      ? applyFilters(db.collection("appointments")).where("status", "in", params.apptStatuses).get()
      : null,
    params.shiftStatuses.length
      ? applyFilters(db.collection("shifts")).where("status", "in", params.shiftStatuses).get()
      : null,
  ]);
  return [...(apptSnap?.docs ?? []), ...(shiftSnap?.docs ?? [])];
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
 * (writeConfirmedShifts) carry `careRecipients: [{name}]` instead — check
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
