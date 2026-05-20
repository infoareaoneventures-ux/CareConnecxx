import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";

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
      await sendMessage("I don't see any recent visits to refund. If you think this is a mistake, I can create a support ticket for you.");
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
    await sendMessage(`Which visit would you like a refund for?\n${list}\n\nJust tell me which one (e.g. "the first one" or "the May 10th visit").`);
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

    await sendMessage(
      `Got it — the ${visitDesc}. Can you tell me briefly why you'd like a refund? ` +
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

    await sendMessage(
      `To confirm — you'd like a refund for ${desc} because: "${reason}".\n\n` +
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
      await sendMessage("No problem — refund request cancelled. Let me know if you need anything else.");
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

    await sendMessage(
      "Your refund request has been submitted. An admin will review it within 24 hours and you'll hear back via text. " +
      "If approved, it typically takes 3–5 business days to appear on your statement."
    );
  }
}
