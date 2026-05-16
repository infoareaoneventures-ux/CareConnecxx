import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { consolidateMemoryForUser } from "../memory/memoryFiles";

const db = admin.firestore();

// Runs nightly at 10 PM PT (06:00 UTC next day)
export const consolidateMemoryNightly = functions.pubsub
  .schedule("0 6 * * *")
  .onRun(async () => {
    // Find all active sessions updated in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const snap = await db
      .collection("agent_sessions")
      .where("onboardingStep", "==", "complete")
      .where("optedOut", "==", false)
      .get();

    const userIds: string[] = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      // Only process users who had recent activity
      if (data.lastMessageAt && data.lastMessageAt >= sevenDaysAgo) {
        const userId = data.userId ?? doc.id;
        if (userId) userIds.push(userId);
      }
    }

    console.log(`consolidateMemoryNightly: processing ${userIds.length} users`);

    // Process in batches to avoid timeout
    for (const userId of userIds) {
      await consolidateMemoryForUser(userId).catch((err) =>
        console.error(`memory consolidation error for ${userId}:`, err)
      );
    }
  });
