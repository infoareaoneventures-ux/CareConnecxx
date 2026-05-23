import { getSharedClient } from "../utils/claudeClient";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "./caraAgent";
import { sendToPhone } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

export type IssueType = "fall" | "medical" | "behavioral" | "environment" | "other";
export type IssueSeverity = "routine" | "urgent" | "critical";

export interface IssueClassification {
  type:     IssueType;
  severity: IssueSeverity;
  is911:    boolean;
  summary:  string;
}

// Fast keyword pre-check before Claude call
const EMERGENCY_KEYWORDS = [
  /\b(fell|fall|fallen|on the floor|found on floor)\b/i,
  /\b(not breathing|unresponsive|unconscious|passed out)\b/i,
  /\b(chest pain|heart attack|stroke|seizure|choking)\b/i,
  /\b(heavy bleeding|won't stop bleeding|deep cut)\b/i,
];

export async function classifyIssue(text: string): Promise<IssueClassification> {
  // Fast path: check emergency keywords
  if (EMERGENCY_KEYWORDS.some(r => r.test(text))) {
    return {
      type:     text.toLowerCase().includes("fell") || text.toLowerCase().includes("floor") ? "fall" : "medical",
      severity: "critical",
      is911:    true,
      summary:  "Potential emergency situation reported",
    };
  }

  try {
    const resp = await getSharedClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        'You are a care coordinator reviewing an issue from a caregiver. Classify it. Reply JSON only:\n' +
        '{"type":"fall|medical|behavioral|environment|other","severity":"routine|urgent|critical","is911":false,"summary":"one sentence for family"}\n' +
        'type: fall=falling/slipping/floor, medical=chest pain/breathing/unresponsive/seizure, behavioral=agitation/confusion/refusal, environment=unsafe/gas/equipment, other=anything else\n' +
        'severity: routine=worth noting, urgent=needs follow-up today, critical=possible emergency\n' +
        'is911: true ONLY for unresponsive/not breathing/chest pain/severe fall with injury/heavy bleeding',
      messages: [{ role: "user", content: text }],
    });
    const raw = (resp.content[0] as { text: string }).text ?? "{}";
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return {
      type:     parsed.type     ?? "other",
      severity: parsed.severity ?? "routine",
      is911:    parsed.is911    ?? false,
      summary:  parsed.summary  ?? text.slice(0, 100),
    };
  } catch {
    return { type: "other", severity: "routine", is911: false, summary: text.slice(0, 100) };
  }
}

export async function handleCaregiverIssue(params: {
  caregiverId:    string;
  caregiverPhone: string;
  caregiverName:  string;
  appointmentId:  string;
  clientId:       string;
  clientPhone:    string;
  seniorId:       string;
  seniorName:     string;
  description:    string;
}): Promise<void> {
  const { caregiverId, caregiverPhone, caregiverName, appointmentId, clientId, clientPhone, seniorId, seniorName, description } = params;
  const now = new Date().toISOString();

  const classification = await classifyIssue(description);

  if (classification.is911) {
    // Emergency path — bypass DND, send immediately
    await sendViaInteractionAgent(caregiverPhone, {
      content:     "If the situation is life-threatening, call 911 immediately. I'm notifying the family now.",
      urgency:     "immediate",
      sourceAgent: "issue_escalator",
      canDrop:     false,
    });

    if (clientPhone) {
      await sendViaInteractionAgent(clientPhone, {
        content:     `${caregiverName} reported an emergency with ${seniorName}. If this is life-threatening, call 911 immediately. I'm reaching out to you now.`,
        urgency:     "immediate",
        sourceAgent: "issue_escalator",
        canDrop:     false,
      });
    }

    await db.collection("admin_alerts").add({
      type:          "caregiver_issue_911",
      caregiverId,
      clientId,
      appointmentId,
      description,
      issueType:     classification.type,
      priority:      "critical",
      createdAt:     now,
      resolved:      false,
    });
    return; // No escalation schedule for 911 — direct path
  }

  // Non-911 path
  const familyMsg = await generateCaraMessage({
    audience: "family",
    context: classification.severity === "urgent"
      ? `Caregiver ${caregiverName} flagged an urgent concern during today's visit with ${seniorName}: ${classification.summary}. Let the family know the team is aware and invite them to reply with questions.`
      : `Caregiver ${caregiverName} noted a routine update during today's visit with ${seniorName}: ${classification.summary}. Keep the family informed in a calm, reassuring tone — nothing urgent.`,
    fallback: classification.severity === "urgent"
      ? `${caregiverName} flagged a concern during today's visit with ${seniorName}: ${classification.summary}. Our team is aware. Reply with any questions.`
      : `Quick note from ${caregiverName} — ${classification.summary}. Nothing urgent, wanted to keep you informed.`,
  });

  if (clientPhone) {
    await sendViaInteractionAgent(clientPhone, {
      content:     familyMsg,
      urgency:     classification.severity === "urgent" ? "immediate" : "standard",
      sourceAgent: "issue_escalator",
      canDrop:     false,
    });
  }

  // Write issue_log
  const issueLogRef = await db.collection("issue_log").add({
    appointmentId,
    caregiverId,
    caregiverName,
    clientId,
    clientPhone,
    seniorId,
    seniorName,
    description,
    type:             classification.type,
    severity:         classification.severity,
    is911:            false,
    familyNotifiedAt: now,
    escalationLevel:  0,
    resolvedAt:       null,
    followUpSentAt:   null,
    createdAt:        now,
  });

  // Write admin_alerts
  await db.collection("admin_alerts").add({
    type:          "caregiver_issue",
    caregiverId,
    clientId,
    appointmentId,
    issueLogId:    issueLogRef.id,
    description,
    issueType:     classification.type,
    severity:      classification.severity,
    createdAt:     now,
    resolved:      false,
    priority:      classification.severity === "urgent" ? "high" : "medium",
  });

  // Schedule 30-min escalation trigger if urgent
  if (classification.severity === "urgent" || classification.severity === "critical") {
    await db.collection("proactive_triggers").add({
      userId:      clientId,
      phone:       clientPhone,
      type:        "custom",
      scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      message:     `issue_escalation:${issueLogRef.id}`,
      createdAt:   now,
      firedAt:     null,
      cancelledAt: null,
    });
  }

  // Always schedule 20h follow-up
  await db.collection("proactive_triggers").add({
    userId:      clientId,
    phone:       clientPhone,
    type:        "custom",
    scheduledAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    message:     `issue_followup:${issueLogRef.id}`,
    createdAt:   now,
    firedAt:     null,
    cancelledAt: null,
  });
}

export async function escalateIssue(issueLogId: string): Promise<void> {
  const snap = await db.collection("issue_log").doc(issueLogId).get();
  if (!snap.exists) return;

  const issue = snap.data()!;
  if (issue.resolvedAt) return;
  if (issue.escalationLevel >= 2) return;

  // Check if family replied after familyNotifiedAt
  const replied = await db.collection("agent_conversations")
    .doc(issue.clientPhone ?? "")
    .collection("messages")
    .where("role",      "==", "user")
    .where("timestamp", ">=", new Date(issue.familyNotifiedAt).getTime())
    .limit(1)
    .get();

  if (!replied.empty) {
    // Family responded — no escalation needed
    await snap.ref.update({ escalationLevel: 1, familyReplied: true });
    return;
  }

  // Family hasn't responded — contact emergency contact
  const seniorSnap = await db.collection("senior_profiles").doc(issue.seniorId ?? "").get();
  const ecPhone    = seniorSnap.data()?.emergencyContact?.phone as string | undefined;
  const seniorName = issue.seniorName ?? "your loved one";

  if (ecPhone && ecPhone !== issue.clientPhone) {
    await sendToPhone(ecPhone,
      `Hi — I'm Cara, the AI care assistant for ${seniorName}. ` +
      `${issue.caregiverName ?? "A caregiver"} flagged a concern during today's visit. ` +
      `The primary contact hasn't responded in 30 minutes. ` +
      `Please reach out to them or contact the care team directly.`
    );
  } else if (!ecPhone) {
    // No emergency contact on file — log admin alert and ask family to provide one
    await db.collection("admin_alerts").add({
      type:      "missing_emergency_contact",
      issueLogId,
      clientId:  issue.clientId,
      seniorId:  issue.seniorId,
      priority:  "high",
      resolved:  false,
      createdAt: new Date().toISOString(),
    });

    if (issue.clientPhone) {
      await sendToPhone(issue.clientPhone,
        `I tried to reach your emergency contact but don't have their info on file. ` +
        `Please reply with their name and phone number so I can add them.`
      );

      // Set session flag so the next reply from the family is captured
      const sessionSnap = await db.collection("agent_sessions")
        .where("phone", "==", issue.clientPhone)
        .limit(1)
        .get();
      if (!sessionSnap.empty) {
        await sessionSnap.docs[0].ref.update({
          awaitingEmergencyContactUpdate: true,
        }).catch(() => {});
      } else {
        // Fallback: session doc keyed directly by phone
        await db.collection("agent_sessions").doc(issue.clientPhone).set(
          { awaitingEmergencyContactUpdate: true },
          { merge: true }
        );
      }
    }
  }

  await snap.ref.update({ escalationLevel: 2 });

  // Schedule final escalation at +90min
  await db.collection("proactive_triggers").add({
    userId:      issue.clientId,
    phone:       issue.clientPhone,
    type:        "custom",
    scheduledAt: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    message:     `issue_escalation_final:${issueLogId}`,
    createdAt:   new Date().toISOString(),
    firedAt:     null,
    cancelledAt: null,
  });
}

export async function escalateIssueFinal(issueLogId: string): Promise<void> {
  const snap = await db.collection("issue_log").doc(issueLogId).get();
  if (!snap.exists) return;
  const issue = snap.data()!;
  if (issue.resolvedAt) return;

  await db.collection("admin_alerts").add({
    type:        "issue_unacknowledged",
    issueLogId,
    clientId:    issue.clientId,
    caregiverId: issue.caregiverId,
    seniorId:    issue.seniorId,
    severity:    "critical",
    priority:    "critical",
    createdAt:   new Date().toISOString(),
    resolved:    false,
  });

  await snap.ref.update({ escalationLevel: 3 });
}

// ── Resolve an issue — cancels pending escalation triggers ───────────────────
// Call this when caregiver replies YES to the closure check, or admin marks resolved.

export async function resolveIssue(
  issueLogId: string,
  resolvedBy:  "caregiver" | "family" | "admin",
  note?:       string
): Promise<void> {
  const ref  = db.collection("issue_log").doc(issueLogId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.resolvedAt) return; // Already resolved

  await ref.update({
    resolvedAt:     new Date().toISOString(),
    resolvedBy,
    resolutionNote: note ?? null,
  });
  // Pending escalation triggers gate on resolvedAt — no separate cancellation needed.
  console.info(`[resolveIssue] ${issueLogId} resolved by ${resolvedBy}`);
}

export async function sendIssueFollowUp(issueLogId: string): Promise<void> {
  const snap = await db.collection("issue_log").doc(issueLogId).get();
  if (!snap.exists) return;

  const issue = snap.data()!;
  if (issue.resolvedAt || issue.followUpSentAt) return;

  const seniorName = issue.seniorName ?? "your loved one";

  // Message to family
  if (issue.clientPhone) {
    const familyFollowUpMsg = await generateCaraMessage({
      audience: "family",
      context: `Cara is following up the day after a care concern was reported involving ${seniorName}. Gently check in to see how ${seniorName} is doing today and whether everything is okay.`,
      fallback: `Just checking in — how is ${seniorName} doing today after yesterday's concern?\n\nEverything okay?`,
    });
    await sendViaInteractionAgent(issue.clientPhone, {
      content:     familyFollowUpMsg,
      urgency:     "standard",
      sourceAgent: "issue_followup",
      canDrop:     false,
    });
  }

  // Closure check to caregiver
  if (issue.caregiverPhone) {
    const caregiverFollowUpMsg = await generateCaraMessage({
      audience: "caregiver",
      context: "Cara is sending a follow-up closure check to the caregiver the day after they reported a concern during a visit. Ask if the concern was resolved and remind them to reply YES if everything's okay or give an update if not.",
      fallback: "Quick check-in: was the concern from yesterday's visit resolved? Reply YES if everything's okay, or give me an update if not.",
    });
    await sendViaInteractionAgent(issue.caregiverPhone, {
      content:     caregiverFollowUpMsg,
      urgency:     "standard",
      sourceAgent: "issue_followup",
      canDrop:     false,
    });
    // Set closure check flag
    await db.collection("agent_sessions").doc(issue.caregiverPhone).update({
      awaitingIssueClosureCheck: issueLogId,
    }).catch(() => {});
  }

  await snap.ref.update({ followUpSentAt: new Date().toISOString() });
}
