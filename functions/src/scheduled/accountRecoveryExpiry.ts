import * as functions from "firebase-functions/v1";
import { sweepExpiredAccountRecoveryRequests } from "../accountRecovery";

// Sweeps expired phone/email-change request tokens (30-min TTL). No side
// effects to roll back on expiry — unlike a shift offer, an unused recovery
// link just gets deleted. Same convention as shiftOfferExpiry.ts.
export const expireAccountRecoveryRequests = functions.pubsub
  .schedule("every 60 minutes")
  .onRun(async () => {
    const { deleted } = await sweepExpiredAccountRecoveryRequests();
    if (deleted > 0) {
      console.log(`[expireAccountRecoveryRequests] deleted ${deleted} expired request(s)`);
    }
  });
