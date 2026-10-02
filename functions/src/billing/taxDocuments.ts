import * as admin from "firebase-admin";

const db = admin.firestore();

export interface TaxSummary {
  caregiverId: string;
  year: number;
  totalEarnings: number;        // USD
  totalHours: number;
  visitCount: number;
  eligibleFor1099: boolean;     // earnings >= $600
  payoutCount: number;
  quarterlyBreakdown: {
    q1: number; q2: number; q3: number; q4: number;
  };
  generatedAt: string;
}

export async function getCaregiverTaxSummary(
  caregiverId: string,
  year: number
): Promise<TaxSummary> {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  // Query approved/auto_approved/paid shift hours for the caregiver
  // Collection name is "shiftHours" per shiftHours.ts (see shiftRef.set / db.collection('shiftHours'))
  const shiftSnap = await db.collection("shiftHours")
    .where("caregiverId", "==", caregiverId)
    .where("status", "in", ["approved", "auto_approved", "paid"])
    .get();

  let totalEarnings = 0;
  let totalHours    = 0;
  let visitCount    = 0;
  const quarterly   = { q1: 0, q2: 0, q3: 0, q4: 0 };

  for (const doc of shiftSnap.docs) {
    const data = doc.data();
    // submittedAt is the ISO timestamp stored during submitShiftHours
    const date: string = (data.submittedAt as string | undefined)?.split("T")[0] ?? "";
    if (!date || date < startDate || date > endDate) continue;

    // grossPay is set upon approval: Math.round(submittedTotalHours * payRate * 100) / 100
    // submittedTotalHours is the hours field (or finalTotalHours after correction)
    const hours: number =
      (data.finalTotalHours as number | undefined) ??
      (data.submittedTotalHours as number | undefined) ?? 0;
    const earnings: number = (data.grossPay as number | undefined) ?? 0;

    totalHours    += hours;
    totalEarnings += earnings;
    visitCount++;

    const month = parseInt(date.split("-")[1], 10);
    if (month <= 3)       quarterly.q1 += earnings;
    else if (month <= 6)  quarterly.q2 += earnings;
    else if (month <= 9)  quarterly.q3 += earnings;
    else                  quarterly.q4 += earnings;
  }

  // Count paid-out payouts for the year — the caregivers/{id}/payouts ledger the
  // Payouts tab reads (a top-level "payouts" collection was queried before, and
  // nothing has ever written one, so the count was always 0 — 2026-10-01).
  const payoutSnap = await db.collection("caregivers").doc(caregiverId).collection("payouts")
    .where("status", "==", "paid")
    .get();
  const payoutCount = payoutSnap.docs.filter(d => {
    const ts: string = (d.data().createdAt as string | undefined) ?? "";
    return ts >= startDate && ts <= endDate;
  }).length;

  const summary: TaxSummary = {
    caregiverId,
    year,
    totalEarnings: Math.round(totalEarnings * 100) / 100,
    totalHours:    Math.round(totalHours * 10) / 10,
    visitCount,
    eligibleFor1099: totalEarnings >= 600,
    payoutCount,
    quarterlyBreakdown: {
      q1: Math.round(quarterly.q1 * 100) / 100,
      q2: Math.round(quarterly.q2 * 100) / 100,
      q3: Math.round(quarterly.q3 * 100) / 100,
      q4: Math.round(quarterly.q4 * 100) / 100,
    },
    generatedAt: new Date().toISOString(),
  };

  // Cache in Firestore for fast re-retrieval
  await db.collection("tax_summaries").doc(`${caregiverId}_${year}`).set(summary);

  return summary;
}
