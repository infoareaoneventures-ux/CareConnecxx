import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * One-time migration: fixes shiftHours docs where a client accepted a caregiver
 * counter-proposal but grossPay was stored as base pay only (missing line items).
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>
 *
 * Safe to re-run — docs that already have the correct grossPay are skipped.
 */
export const fixAcceptedCounterPay = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const results = { fixed: 0, skipped: 0, errors: [] as string[] };

  // Only docs accepted by the client after a counter
  const snap = await db.collection("shiftHours")
    .where("status", "==", "approved")
    .where("resolvedBy", "==", "client")
    .get();

  for (const doc of snap.docs) {
    const s = doc.data();

    // Only applies when a counter was on file
    if (!s.counterTotalHours) {
      results.skipped++;
      continue;
    }

    const counterBasePay       = Math.round(s.counterTotalHours * s.payRate * 100) / 100;
    const safeLineItems: any[] = Array.isArray(s.counterLineItems) ? s.counterLineItems : [];
    const lineItemsTotal       = Math.round(safeLineItems.reduce((sum: number, li: any) => sum + (Number(li.amount) || 0), 0) * 100) / 100;
    const correctGross         = s.counterGrossPay ?? Math.round((counterBasePay + lineItemsTotal) * 100) / 100;

    // Skip if grossPay is already correct (within 1 cent rounding)
    if (Math.abs((s.grossPay ?? 0) - correctGross) < 0.02 && safeLineItems.length === 0) {
      results.skipped++;
      continue;
    }

    // Fix the history array: update the 'accepted' entry to include financials
    const history: any[] = Array.isArray(s.correctionHistory) ? [...s.correctionHistory] : [];
    const fixedHistory = history.map((entry: any) => {
      if (entry.action !== "accepted") return entry;
      return {
        ...entry,
        lineItems:       safeLineItems,
        lineItemsTotal,
        basePay:         counterBasePay,
        grossPay:        correctGross,
      };
    });

    try {
      await doc.ref.update({
        lineItems:       safeLineItems,
        lineItemsTotal,
        basePay:         counterBasePay,
        grossPay:        correctGross,
        correctionHistory: fixedHistory,
        updatedAt:       new Date().toISOString(),
      });
      results.fixed++;
    } catch (e: any) {
      results.errors.push(`${doc.id}: ${e.message}`);
    }
  }

  res.json(results);
});
