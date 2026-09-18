// Minute sweep: sends whatever a burst of task check-offs / visit notes left
// waiting once its 2-minute window has passed (triggers/familyVisitUpdates.ts).
import * as functions from "firebase-functions/v1";
import { flushQueuedUpdates } from "../triggers/familyVisitUpdates";
import { notifyClientByText } from "../triggers/notificationTriggers";

export const flushFamilyVisitUpdates = functions.pubsub
  .schedule("every 1 minutes")
  .onRun(async () => {
    const sent = await flushQueuedUpdates(notifyClientByText);
    if (sent) console.info(`[flushFamilyVisitUpdates] sent ${sent} grouped visit update(s)`);
    return null;
  });
