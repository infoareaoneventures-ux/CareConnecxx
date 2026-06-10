import * as functions from "firebase-functions/v1";
import { expireShiftOffers } from "../agents/shiftOffer";

// Sweeps unanswered shift offers (new bookings, client swaps, time changes)
// past their 2-hour TTL: marks them expired, rolls back / cancels the pending
// appointments, notifies the family with alternatives, and clears the
// caregiver's session flag. See agents/shiftOffer.ts.
export const expirePendingShiftOffers = functions.pubsub
  .schedule("every 15 minutes")
  .timeZone("America/New_York")
  .onRun(async () => {
    const expired = await expireShiftOffers();
    if (expired > 0) {
      console.log(`[expirePendingShiftOffers] expired ${expired} offer(s)`);
    }
  });
