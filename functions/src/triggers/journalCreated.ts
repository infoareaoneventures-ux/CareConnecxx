import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendMessage, sendToPhone, AgentSession } from "../linq/client";
import { detectHealthSignals } from "../agents/healthSignalDetector";
import { sendVoiceSummary } from "../agents/voiceSummary";

const db = admin.firestore();

export const onJournalCreated = functions.firestore
  .document("care_journal/{journalId}")
  .onCreate(async (snap) => {
    try {
      const journal = snap.data();
      const { seniorId, caregiverId, notes, photos, wellness, activities, timestamp } = journal;

      if (!seniorId) return;

      // seniorId === clientId for single-senior households
      const clientDoc = await db.collection("users").doc(seniorId).get();
      const phone: string | undefined = clientDoc.data()?.phone;
      if (!phone) return;

      const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
      if (!sessionSnap.exists) {
        // No session yet — send transactional message via get-or-create
        const { summary } = await detectHealthSignals(notes ?? "", wellness ?? {}, activities ?? []);
        await sendToPhone(phone, summary);
        return;
      }

      const session = sessionSnap.data() as AgentSession;
      if (session.optedOut || session.optedIn === false) return;

      // Run health signal detection
      const { signals, severity, summary } = await detectHealthSignals(
        notes ?? "",
        wellness ?? {},
        activities ?? []
      );

      // Save signals for trend tracking
      if (signals.length > 0) {
        await db.collection("health_signals").add({
          seniorId,
          signals,
          severity,
          journalEntryId: snap.id,
          detectedAt:     new Date().toISOString(),
        });
      }

      // Lookup caregiver name
      const caregiverDoc = await db.collection("caregivers").doc(caregiverId).get();
      const caregiverName: string = caregiverDoc.data()?.name ?? "Your caregiver";

      const visitDate = (timestamp as string)?.slice(0, 10) ?? "today";
      const baseMessage = `${caregiverName} finished today's visit (${visitDate}).\n${summary}`;

      // Send photo inline if available (renders natively in iMessage)
      if (photos?.length > 0) {
        await sendMessage(session.chatId, {
          parts: [
            { type: "text",  value: baseMessage },
            { type: "media", url: photos[0] },
          ],
        });
      } else {
        await sendMessage(session.chatId, baseMessage);
      }

      // Follow-up for flagged health signals
      if (severity === "flag" && signals.length > 0) {
        await sendMessage(
          session.chatId,
          `⚠️ Worth noting: ${signals.join(", ")}. Might be worth mentioning to the doctor at the next visit.`
        );
      }

      // Send voice memo on iMessage — family taps play to hear the update
      if (session.service === "iMessage") {
        await sendVoiceSummary(session.chatId, summary, seniorId).catch((err) =>
          console.error("voiceSummary error (non-critical):", err)
        );
      }

      // Log alert for admin audit trail
      await db.collection("agent_alerts_log").add({
        type:     "journal_summary",
        clientId: seniorId,
        phone,
        severity,
        sentAt:   new Date().toISOString(),
      });
    } catch (err) {
      console.error("onJournalCreated error:", err);
    }
  });
