// What an account leaves behind on the OTHER side when it is deleted (2026-11-09, fix plan Wave 2).
//
// deleteAccountForUser used to remove the person's own records and login only. Live (Nov 7): the family's
// inbox still listed the conversation with the deleted care provider and accepted new messages nobody would
// read, their job post still showed "1 applicant", booked visits stayed on the calendar, and a deleted care
// provider's PUBLIC profile stayed listed. This releases those ties, best-effort per step (a failed step is
// logged and never blocks the deletion itself — the person's right to delete comes first), using the paths
// the product already has so the other side is told the normal way:
//   • upcoming visits and open booking requests are CANCELLED — a deleted care provider's as 'system' (the
//     family hears "released, a replacement offered, no reason"), a deleted family's as 'client' (the care
//     provider hears "the family cancelled"); the existing shift/booking triggers send those notices;
//   • a care provider's pending applications are WITHDRAWN (a trigger keeps the job's applicantCount right);
//   • a family's open job posts are CANCELLED so no one applies to a household that is gone;
//   • the care provider's public profile is removed;
//   • every chat room is CLOSED ("closedReason: account_deleted") — the other side sees "no longer on Evia"
//     and firestore.rules refuse new messages.
// Financial and audit records (payments, invoices, consent log) are NOT touched here.
import * as admin from "firebase-admin";

type Db = FirebaseFirestore.Firestore;
export const ACCOUNT_DELETED_REASON = "account_deleted";

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { console.error(`[accountDeletionTies] ${name} failed:`, err instanceof Error ? err.message : err); }
}

async function updateAll(docs: FirebaseFirestore.QueryDocumentSnapshot[], data: Record<string, unknown>): Promise<number> {
  let n = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = admin.firestore().batch();
    docs.slice(i, i + 400).forEach((d) => { batch.update(d.ref, data); n++; });
    await batch.commit();
  }
  return n;
}

export async function releaseAccountTies(db: Db, userId: string, isCaregiver: boolean): Promise<void> {
  const nowIso = new Date().toISOString();
  const serverTs = admin.firestore.FieldValue.serverTimestamp();
  const cancel = (by: "system" | "client") => ({ status: "cancelled", cancelledBy: by, cancelReason: ACCOUNT_DELETED_REASON, cancelledAt: nowIso, updatedAt: serverTs });
  const mine = isCaregiver ? "caregiverId" : "clientId";
  const by = isCaregiver ? "system" : "client";

  // Upcoming visits (single-field query + in-memory filter: no composite index needed).
  await step("visits", async () => {
    const snap = await db.collection("shifts").where(mine, "==", userId).get();
    await updateAll(snap.docs.filter((d) => ["scheduled", "needs_replacement"].includes(String(d.data().status))), cancel(by));
  });

  // Open booking requests / accepted bookings.
  await step("bookings", async () => {
    const snap = await db.collection("booking_requests").where(mine, "==", userId).get();
    await updateAll(snap.docs.filter((d) => ["pending", "accepted"].includes(String(d.data().status))), cancel(by));
  });

  if (isCaregiver) {
    await step("public profile", async () => { await db.collection("publicCaregiverProfiles").doc(userId).delete(); });
    await step("applications", async () => {
      const snap = await db.collection("job_applications").where("caregiverId", "==", userId).get();
      await updateAll(snap.docs.filter((d) => d.data().status === "pending"), { status: "withdrawn", withdrawnReason: ACCOUNT_DELETED_REASON, updatedAt: serverTs });
    });
  } else {
    await step("job posts", async () => {
      const snap = await db.collection("job_posts").where("clientId", "==", userId).get();
      await updateAll(snap.docs.filter((d) => d.data().status === "open"), { status: "cancelled", cancelledReason: ACCOUNT_DELETED_REASON, updatedAt: serverTs });
    });
  }

  // Conversations: closed, never deleted — the other person keeps their side of the history.
  await step("chat rooms", async () => {
    const snap = await db.collection("chatRooms").where("participants", "array-contains", userId).get();
    await updateAll(snap.docs, { closedReason: ACCOUNT_DELETED_REASON, closedAt: serverTs, closedBy: userId });
  });
}
