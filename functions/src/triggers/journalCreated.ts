import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, sendToPhone, AgentSession } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { detectHealthSignals } from "../agents/healthSignalDetector";
import { sendVoiceSummary } from "../agents/voiceSummary";
import { getPermissions } from "../agents/permissionsConversation";
import { sendCareJournalToZep } from "../memory/zepClient";
import { scheduleTrigger } from "./triggerEngine";
import { writeFeedbackSignal } from "../ai/feedback";

async function generateVisitSummary(
  caregiverName: string,
  seniorName: string | null,
  notes: string,
  wellness: Record<string, unknown>
): Promise<string | null> {
  try {
    const resp = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 120,
      system:
        "You write one-to-two sentence visit summaries for families receiving care updates via text.\n" +
        "Tone: warm, specific, direct — like a trusted care coordinator. No bullet points, no headers.\n" +
        "Lead with what the senior did or felt. Include one concrete detail from the notes.\n" +
        "End with one brief observation worth watching if anything stands out (optional).\n" +
        "Never mention the caregiver's name in the observation — only in the lead.\n" +
        "Output the summary only. No preamble.",
      messages: [{
        role: "user",
        content:
          `Caregiver: ${caregiverName}\n` +
          `Senior: ${seniorName ?? "the senior"}\n` +
          `Notes: ${notes.slice(0, 400)}\n` +
          `Wellness: ate_well=${wellness.ateWell}, meds_taken=${wellness.tookMeds}, mood=${wellness.mood ?? "unknown"}`,
      }],
    });
    const text = ((resp.content[0] as { text: string }).text ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
}

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
                `Heads up — I've noticed "${signalType}" has come up ${recentSignals.size} times this week for ${seniorName}.\n\n` +
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

      let baseMessage: string;
      if (severity === "flag" || severity === "watch") {
        // Health signal path: use the detected signal summary
        baseMessage = `${opening} ${summary}`.trim();
      } else if (notes && (notes as string).length > 50) {
        // Rich notes available: ask Claude to generate a warm, specific summary
        const aiSummary = await generateVisitSummary(
          caregiverName,
          seniorName,
          notes as string,
          wellness as Record<string, unknown>
        );
        baseMessage = aiSummary ?? `${opening} ${summary || "Visit went smoothly."}`.trim();
      } else {
        // Fallback: boolean wellness template
        const goods: string[] = [];
        if ((wellness as any)?.ateWell)  goods.push("ate well");
        if ((wellness as any)?.tookMeds) goods.push("took their medication");
        const mood = (wellness as any)?.mood as string | undefined;
        if (mood === "happy" || mood === "positive") goods.push("was in good spirits");
        const observation = goods.length > 0
          ? `They ${goods.join(" and ")} today.`
          : (summary || "Visit went smoothly.");
        baseMessage = `${opening} ${observation}`.trim();
      }

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

      // First-occurrence observations — surface a specific "I noticed X" call-out
      // rather than burying it in the general visit summary. Fires on the first
      // occurrence of a watch/flag signal so the family knows fast, not after
      // a 3-in-7-day pattern. Dedup is handled above (skips if same signalType
      // was alerted in past 24h).
      const seniorDocForObs = await db.collection("users").doc(seniorId).get();
      const seniorNameForObs = (seniorDocForObs.data()?.seniorName ?? seniorDocForObs.data()?.displayName ?? "your loved one") as string;
      const observationSent = await maybeSendObservation({
        phone,
        seniorId,
        seniorName: seniorNameForObs,
        signals,
        severity,
        nowIso,
      });

      // Follow-up for flagged health signals
      if (severity === "flag" && signals.length > 0) {
        // Only send the generic "worth keeping an eye on" if we didn't already
        // send a specific observation above — avoid double-messaging the family.
        if (!observationSent) {
          const signalList = signals.slice(0, 2).join(" and ");
          await sendViaInteractionAgent(phone, {
            content:     `Worth keeping an eye on — if ${signalList} comes up again, it's worth a quick mention to their doctor.`,
            urgency:     "standard",
            sourceAgent: "health_watch",
            canDrop:     true,
          });
        }

        // Schedule 24h escalation to emergency contact if family doesn't acknowledge
        const alertLogRef = await db.collection("health_alerts_pending").add({
          seniorId,
          phone,
          signals,
          severity,
          sentAt:      nowIso,
          escalated:   false,
        });
        // Write directly to proactive_triggers to bypass calibration gating
        await db.collection("proactive_triggers").add({
          userId:      seniorId,
          phone,
          type:        "custom",
          scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          message:     `health_escalation:${seniorId}:${alertLogRef.id}`,
          createdAt:   nowIso,
        });

        // Write mild negative signal — health concern during this visit
        if (caregiverId && seniorId) {
          writeFeedbackSignal({
            clientId:      seniorId,
            caregiverId,
            signal:        -1,
            source:        "health_signal",
            appointmentId: snap.id,
          }).catch((err) => console.error("writeFeedbackSignal health_signal error:", err));
        }
      }

      // Schedule post-visit feedback ask 30 minutes after summary
      if (caregiverId && seniorId) {
        scheduleTrigger({
          userId:      seniorId,
          phone,
          type:        "post_visit_feedback" as any,
          message:
            `How did today's visit go with ${caregiverName}?\n\n` +
            `👍 great — or just tell me if anything felt off.`,
          scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          metadata: {
            caregiverId,
            clientId:      seniorId,
            appointmentId: snap.id,
            visitDate:     new Date().toISOString().slice(0, 10),
          },
          urgency:   "low",
          canDrop:   true,
        } as any).catch((err) => console.error("scheduleTrigger post_visit_feedback error:", err));
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

// Send a concrete "I noticed X today" observation to the family on the first
// occurrence of a watch or flag signal. Returns true if a message was sent so
// the caller can skip the generic flag follow-up.
//
// Dedup is already enforced upstream (skips if same signalType alerted in 24h).
// Skips silently for severity "none" or empty signals.
async function maybeSendObservation(params: {
  phone:      string;
  seniorId:   string;
  seniorName: string;
  signals:    string[];
  severity:   "none" | "watch" | "flag";
  nowIso:     string;
}): Promise<boolean> {
  const { phone, seniorId, seniorName, signals, severity, nowIso } = params;
  if (severity === "none" || signals.length === 0) return false;

  const signalText = signals.slice(0, 2).join(" and ");
  const content = severity === "flag"
    ? `Heads up — ${seniorName}'s caregiver noted ${signalText} today. Wanted to flag it for you so you're not the last to know. Want to talk it through?`
    : `Quick observation — ${seniorName}'s caregiver mentioned ${signalText} today. Not concerning on its own, but I'll keep an eye on it.`;

  await sendViaInteractionAgent(phone, {
    content,
    urgency:     severity === "flag" ? "immediate" : "standard",
    sourceAgent: "health_watch",
    canDrop:     severity === "watch", // family must see flag-level observations
  });

  await db.collection("agent_alerts_log").add({
    type:       "first_occurrence_observation",
    seniorId,
    clientId:   seniorId,
    phone,
    signals,
    severity,
    sentAt:     nowIso,
  }).catch(() => {});

  return true;
}
