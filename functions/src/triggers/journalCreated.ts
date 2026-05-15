import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendMessage, sendToPhone, AgentSession } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { detectHealthSignals } from "../agents/healthSignalDetector";
import { sendVoiceSummary } from "../agents/voiceSummary";
import { getPermissions } from "../agents/permissionsConversation";
import { sendCareJournalToZep } from "../memory/zepClient";

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

      // Check permission before sending health alerts
      const perms = await getPermissions(session.userId ?? seniorId).catch(() => null);
      if (perms !== null && perms.canSendHealthAlerts === false) return;

      // Run health signal detection
      const { signals, severity, summary } = await detectHealthSignals(
        notes ?? "",
        wellness ?? {},
        activities ?? []
      );

      const nowIso       = new Date().toISOString();
      const oneDayAgo    = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();

      // Save signals and check for duplicates + trends
      if (signals.length > 0) {
        for (const signalType of signals) {
          // De-dup: skip if same signal was already sent in past 24h
          const recentAlert = await db.collection("agent_alerts_log")
            .where("seniorId", "==", seniorId)
            .where("signalType", "==", signalType)
            .where("sentAt", ">=", oneDayAgo)
            .limit(1)
            .get();
          if (!recentAlert.empty) continue;

          // Log this signal
          const sigRef = await db.collection("health_signals").add({
            seniorId,
            signalType,
            severity,
            journalEntryId: snap.id,
            detectedAt:     nowIso,
            trendAlertSent: false,
          });

          // Trend check: 3+ of same signal in the past 7 days → escalate
          const recentSignals = await db.collection("health_signals")
            .where("seniorId", "==", seniorId)
            .where("signalType", "==", signalType)
            .where("detectedAt", ">=", sevenDaysAgo)
            .orderBy("detectedAt", "desc")
            .get();

          if (recentSignals.size >= 3 && !recentSignals.docs[0].data().trendAlertSent) {
            const seniorDoc  = await db.collection("users").doc(seniorId).get();
            const seniorName = (seniorDoc.data()?.seniorName ?? seniorDoc.data()?.displayName ?? "your loved one") as string;
            await sendViaInteractionAgent(phone, {
              content:
                `📊 Heads up — I've noticed "${signalType}" has come up ${recentSignals.size} times this week for ${seniorName}.\n\n` +
                `This might be worth a conversation with their doctor or care team. 💙`,
              urgency:     "standard",
              sourceAgent: "health_watch",
              canDrop:     true,
            });
            await sigRef.update({ trendAlertSent: true });
            await db.collection("agent_alerts_log").add({
              type:       "health_trend",
              seniorId,
              clientId:   seniorId,
              phone,
              signalType,
              count:      recentSignals.size,
              sentAt:     nowIso,
            });
          }
        }

        await db.collection("health_signals").add({
          seniorId,
          signals,
          severity,
          journalEntryId: snap.id,
          detectedAt:     nowIso,
        });
      }

      // Lookup caregiver name
      const caregiverDoc = await db.collection("caregivers").doc(caregiverId).get();
      const caregiverName: string = caregiverDoc.data()?.name ?? "Your caregiver";

      const visitDate  = (timestamp as string)?.slice(0, 10) ?? "today";
      const seniorName = (clientDoc.data()?.seniorName ?? clientDoc.data()?.displayName ?? null) as string | null;
      const opening    = seniorName
        ? `${caregiverName} just finished up with ${seniorName}.`
        : `${caregiverName} just finished up.`;

      let observation = "";
      if (severity === "flag" || severity === "watch") {
        observation = summary;
      } else {
        const goods: string[] = [];
        if ((wellness as any)?.ateWell)  goods.push("ate well");
        if ((wellness as any)?.tookMeds) goods.push("took their medication");
        const mood = (wellness as any)?.mood as string | undefined;
        if (mood === "happy" || mood === "positive") goods.push("was in good spirits");
        observation = goods.length > 0
          ? `They ${goods.join(" and ")} today.`
          : (summary || "Visit went smoothly.");
      }

      const baseMessage = `${opening} ${observation}`.trim();

      // Send photo inline if available (renders natively in iMessage)
      if (photos?.length > 0) {
        // Structured message — send directly (supervisor handles text part separately)
        await sendMessage(session.chatId, {
          parts: [
            { type: "text",  value: baseMessage },
            { type: "media", url: photos[0] },
          ],
        });
      } else {
        await sendViaInteractionAgent(phone, {
          content:     baseMessage,
          urgency:     "standard",
          sourceAgent: "visit_summary",
          canDrop:     true,
        });
      }

      // Follow-up for flagged health signals
      if (severity === "flag" && signals.length > 0) {
        await sendViaInteractionAgent(phone, {
          content:     `Worth keeping an eye on. If you notice the same thing at the next visit, it might be worth mentioning to their doctor.`,
          urgency:     "standard",
          sourceAgent: "health_watch",
          canDrop:     true,
        });
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
        seniorId,
        phone,
        severity,
        sentAt:   nowIso,
      });

      // Send care journal to Zep so health facts are extracted and dated
      const seniorNameForZep = seniorName ?? "Senior";
      sendCareJournalToZep({
        phone,
        seniorName:         seniorNameForZep,
        caregiverName,
        date:               visitDate,
        mood:               wellness?.mood as string | undefined,
        ateWell:            wellness?.ateWell as boolean | undefined,
        medicationsTaken:   wellness?.tookMeds as boolean | undefined,
        healthObservations: signals.length > 0 ? signals : undefined,
        notes:              notes as string | undefined,
      }).catch((err) => console.error("sendCareJournalToZep error:", err));
    } catch (err) {
      console.error("onJournalCreated error:", err);
    }
  });
