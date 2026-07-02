import * as functions from "firebase-functions/v1";
import { drainOutboundQueue } from "../linq/outboundQueue";

// Every-minute sweep over linq_outbound_queue — messages the guarded send
// paths parked instead of dropping when the Linq circuit breaker was open or
// the per-pair rate limit was hit. Rate-limited messages become due as soon
// as the next 60s window opens, so the sweep cadence matches the shortest
// useful retry delay. See linq/outboundQueue.ts.
export const drainLinqOutboundQueue = functions.pubsub
  .schedule("every 1 minutes")
  .timeZone("America/New_York")
  .onRun(async () => {
    const r = await drainOutboundQueue();
    if (r.sent || r.requeued || r.expired || r.failed) {
      console.log(
        `[drainLinqOutboundQueue] sent=${r.sent} requeued=${r.requeued} expired=${r.expired} failed=${r.failed}`
      );
    }
  });
