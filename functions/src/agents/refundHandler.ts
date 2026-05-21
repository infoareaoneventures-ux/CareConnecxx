import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const response = await getClaude().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:     prompt,
      messages:   [{ role: "user", content: userText }],
    });
    return ((response.content[0] as { text: string }).text ?? "").trim();
  } catch {
    return "__parse_error__";
  }
}

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "Reply YES if this is a general question or off-topic comment unrelated to answering the current question. Reply NO if it is a direct answer. Only reply YES or NO.",
    text
  );
  return result.toUpperCase().startsWith("Y");
}

async function answerQuestionMidFlow(text: string): Promise<string> {
  const response = await getClaude().messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system:
      "You are Cara, an AI care assistant. A client is in the middle of requesting a refund. " +
      "Answer their question briefly (1–2 sentences). Be helpful and warm.",
    messages: [{ role: "user", content: text }],
  });
  return ((response.content[0] as { text: string }).text ?? "").trim();
}

// State flow: identify_visit → select_visit → confirm → submitted

export async function handleRefundRequest(
  clientId: string,
  text: string,
  session: Record<string, unknown>,
  sendMessage: (msg: string) => Promise<void>
): Promise<void> {
  const step = (session.refundStep as string) ?? "identify_visit";

  // ── identify_visit — load recent visits and ask which one ────────────────
  if (step === "identify_visit") {
    const apptSnap = await db.collection("appointments")
      .where("clientId", "==", clientId)
      .where("status", "in", ["completed", "confirmed"])
      .orderBy("isoDate", "desc")
      .limit(5)
      .get();

    if (apptSnap.empty) {
      const msgR1 = await generateCaraMessage({
        audience: "family",
        context: "A family member asked Cara for a refund, but Cara doesn't see any recent completed visits to refund. Let them know gently, and mention that if they think it's a mistake, Cara can create a support ticket for them.",
        fallback: "I don't see any recent visits to refund. If you think this is a mistake, I can create a support ticket for you.",
        maxTokens: 80,
      });
      await sendMessage(msgR1);
      await db.collection("agent_sessions").doc(clientId).update({ refundStep: admin.firestore.FieldValue.delete() });
      return;
    }

    const visits = apptSnap.docs.map((d, i) => {
      const data = d.data();
      return {
        index:         i + 1,
        id:            d.id,
        date:          data.date as string,
        caregiverName: data.caregiverName as string,
        cost:          data.cost as number | undefined,
      };
    });

    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:       "select_visit",
      refundCandidates: JSON.stringify(visits),
    });

    const list = visits
      .map(v => `${v.index}. ${v.date} with ${v.caregiverName} — $${v.cost ?? "?"}`)
      .join("\n");
    const msgR2opener = await generateCaraMessage({
      audience: "family",
      context: "A family member wants a refund and Cara found recent visits. Ask them which visit they'd like a refund for.",
      fallback: "Which visit would you like a refund for?",
      maxTokens: 80,
    });
    await sendMessage(`${msgR2opener}\n${list}\n\nJust tell me which one (e.g. "the first one" or "the May 10th visit").`);
    return;
  }

  // ── select_visit — parse which visit they chose ───────────────────────────
  if (step === "select_visit") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerQuestionMidFlow(text);
      await sendMessage(answer);
      const candidates = JSON.parse((session.refundCandidates as string) ?? "[]") as Array<{
        index: number; id: string; date: string; caregiverName: string; cost?: number;
      }>;
      const list = candidates.map(v => `${v.index}. ${v.date} with ${v.caregiverName} — $${v.cost ?? "?"}`).join("\n");
      await sendMessage(`Which visit would you like a refund for?\n${list}`);
      return;
    }

    const candidates = JSON.parse((session.refundCandidates as string) ?? "[]") as Array<{
      index: number; id: string; date: string; caregiverName: string; cost?: number;
    }>;

    const raw = await parseWithClaude(
      `The user is selecting one of ${candidates.length} visits. ` +
      `Visits: ${candidates.map(v => `${v.index}. ${v.date} with ${v.caregiverName}`).join("; ")}. ` +
      `Reply with only the number (1 to ${candidates.length}) of the visit they are referring to, or 0 if unclear.`,
      text
    );
    const pick = parseInt(raw, 10);
    const visit = candidates.find(v => v.index === pick);

    if (!visit) {
      await sendMessage(`I didn't catch which visit — please tell me the number (1 to ${candidates.length}) or the date of the visit.`);
      return;
    }

    const visitDesc = `${visit.date} with ${visit.caregiverName}${visit.cost ? ` ($${visit.cost})` : ""}`;
    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:             "confirm",
      refundAppointmentId:    visit.id,
      refundVisitDescription: visitDesc,
    });

    const msgR3opener = await generateCaraMessage({
      audience: "family",
      context: `A family member selected the visit on ${visitDesc} for their refund request. Acknowledge the visit warmly and ask them to briefly explain why they'd like a refund.`,
      fallback: `Got it — the ${visitDesc}. Can you tell me briefly why you'd like a refund?`,
      maxTokens: 80,
    });
    await sendMessage(
      `${msgR3opener} ` +
      `(e.g. caregiver no-show, unsatisfactory service, billing error)`
    );
    return;
  }

  // ── confirm — capture reason and ask for final confirmation ──────────────
  if (step === "confirm") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerQuestionMidFlow(text);
      await sendMessage(answer);
      const desc = (session.refundVisitDescription as string) ?? "that visit";
      await sendMessage(`Why would you like a refund for ${desc}? (e.g. caregiver no-show, unsatisfactory service, billing error)`);
      return;
    }

    const reason  = text.trim().slice(0, 300);
    const desc    = (session.refundVisitDescription as string) ?? "that visit";

    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:   "submitted",
      refundReason: reason,
    });

    const msgR4opener = await generateCaraMessage({
      audience: "family",
      context: `Cara is about to ask a family member to confirm their refund request for the visit "${desc}" with reason: "${reason}". Write a warm one-line intro asking them to confirm the details below.`,
      fallback: `To confirm — you'd like a refund for ${desc} because: "${reason}".`,
      maxTokens: 80,
    });
    await sendMessage(
      `${msgR4opener}\n\nVisit: ${desc}\nReason: "${reason}"\n\n` +
      `Reply YES to submit the request, or NO to cancel.`
    );
    return;
  }

  // ── submitted — final YES/NO confirmation ─────────────────────────────────
  if (step === "submitted") {
    const norm = await parseWithClaude(
      '"yes", "yeah", "yep", "correct", "submit it", "go ahead", "please", "do it", "sure" = YES. ' +
      '"no", "never mind", "cancel", "forget it", "nope", "don\'t" = NO. ' +
      'Reply with exactly YES or NO.',
      text
    );

    if (norm.toUpperCase() !== "YES") {
      const msgR5 = await generateCaraMessage({
        audience: "family",
        context: "A family member decided to cancel their refund request. Acknowledge the cancellation warmly and let them know Cara is there if they need anything else.",
        fallback: "No problem — refund request cancelled. Let me know if you need anything else.",
        maxTokens: 80,
      });
      await sendMessage(msgR5);
      await db.collection("agent_sessions").doc(clientId).update({
        refundStep:             admin.firestore.FieldValue.delete(),
        refundAppointmentId:    admin.firestore.FieldValue.delete(),
        refundCandidates:       admin.firestore.FieldValue.delete(),
        refundReason:           admin.firestore.FieldValue.delete(),
        refundVisitDescription: admin.firestore.FieldValue.delete(),
      });
      return;
    }

    const appointmentId = session.refundAppointmentId as string;
    const refundReason  = (session.refundReason as string) ?? "";

    await db.collection("refundRequests").add({
      clientId,
      appointmentId,
      reason:      refundReason,
      status:      "pending_review",
      requestedAt: new Date().toISOString(),
      source:      "cara_self_service",
    });

    await db.collection("agent_sessions").doc(clientId).update({
      refundStep:             admin.firestore.FieldValue.delete(),
      refundAppointmentId:    admin.firestore.FieldValue.delete(),
      refundCandidates:       admin.firestore.FieldValue.delete(),
      refundReason:           admin.firestore.FieldValue.delete(),
      refundVisitDescription: admin.firestore.FieldValue.delete(),
    });

    const msgR6opener = await generateCaraMessage({
      audience: "family",
      context: "A family member just submitted a refund request through Cara. Acknowledge the submission warmly and let them know what happens next.",
      fallback: "Your refund request has been submitted.",
      maxTokens: 80,
    });
    await sendMessage(
      `${msgR6opener} An admin will review it within 24 hours and you'll hear back via text. ` +
      "If approved, it typically takes 3–5 business days to appear on your statement."
    );
  }
}
