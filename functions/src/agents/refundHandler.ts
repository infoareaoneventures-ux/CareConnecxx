import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanQuestionOnly } from "./humanReply";

const db = admin.firestore();

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    const raw = await quickComplete(prompt, userText, { maxTokens: 200 });
    return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
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
  return answerHumanQuestionOnly({
    audience: "family",
    situation: "client is in the middle of requesting a refund",
    text,
    maxTokens: 120,
  });
}

// State flow: identify_visit → select_visit → confirm → submitted

export async function handleRefundRequest(
  clientId: string,
  // agent_sessions is keyed by PHONE, not by clientId/userId. Refund flow state
  // (refundStep, refundCandidates, …) MUST be written to doc(phone) so the router
  // — which loads the session by phone — sees it on the next turn. clientId
  // (= userId for registered clients) is used only for the appointments query and
  // the refundRequests record, never for the session doc. See bug-audit §1.1.
  phone: string,
  text: string,
  session: Record<string, unknown>,
  sendMessage: (msg: string) => Promise<unknown>
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
        context: "A family member asked Evia for a refund, but Evia doesn't see any recent completed visits to refund. Let them know gently, and mention that if they think it's a mistake, Evia can create a support ticket for them.",
        fallback: "I don't see any recent visits to refund. If you think this is a mistake, I can create a support ticket for you.",
        maxTokens: 80,
      });
      await sendMessage(msgR1);
      await db.collection("agent_sessions").doc(phone).update({ refundStep: admin.firestore.FieldValue.delete() });
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

    await db.collection("agent_sessions").doc(phone).update({
      refundStep:       "select_visit",
      refundCandidates: JSON.stringify(visits),
    });

    const list = visits
      .map(v => `${v.index}. ${v.date} with ${v.caregiverName} — $${v.cost ?? "?"}`)
      .join("\n");
    const msgR2opener = await generateCaraMessage({
      audience: "family",
      context: "A family member wants a refund and Evia found recent visits. Ask them which visit they'd like a refund for.",
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
    await db.collection("agent_sessions").doc(phone).update({
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

    await db.collection("agent_sessions").doc(phone).update({
      refundStep:   "submitted",
      refundReason: reason,
    });

    const msgR4opener = await generateCaraMessage({
      audience: "family",
      context: `Evia is about to ask a family member to confirm their refund request for the visit "${desc}" with reason: "${reason}". Write a warm one-line intro asking them to confirm the details below.`,
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
    if (await isQuestionOrOther(text)) {
      const answer = await answerQuestionMidFlow(text);
      await sendMessage(answer);
      const desc   = (session.refundVisitDescription as string) ?? "that visit";
      const reason = (session.refundReason          as string) ?? "the reason you mentioned";
      await sendMessage(
        `To confirm — refund for ${desc} because: "${reason}".\n\n` +
        `Reply YES to submit, or NO to cancel.`
      );
      return;
    }

    const norm = await parseWithClaude(
      '"yes", "yeah", "yep", "correct", "submit it", "go ahead", "please", "do it", "sure" = YES. ' +
      '"no", "never mind", "cancel", "forget it", "nope", "don\'t" = NO. ' +
      'Reply with exactly YES or NO.',
      text
    );

    if (norm.toUpperCase() !== "YES") {
      const msgR5 = await generateCaraMessage({
        audience: "family",
        context: "A family member decided to cancel their refund request. Acknowledge the cancellation warmly and let them know Evia is there if they need anything else.",
        fallback: "No problem - refund request cancelled.",
        maxTokens: 80,
      });
      await sendMessage(msgR5);
      await db.collection("agent_sessions").doc(phone).update({
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

    const refundRef = db.collection("refundRequests").doc(`${appointmentId}:${clientId}`);
    try {
      await refundRef.create({
        clientId,
        appointmentId,
        reason:      refundReason,
        status:      "requested",
        requestedAt: new Date().toISOString(),
        source:      "cara_self_service",
      });
    } catch (error: any) {
      if (error?.code !== 6 && !/already exists/i.test(String(error?.message ?? ""))) throw error;
    }

    await db.collection("agent_sessions").doc(phone).update({
      refundStep:             admin.firestore.FieldValue.delete(),
      refundAppointmentId:    admin.firestore.FieldValue.delete(),
      refundCandidates:       admin.firestore.FieldValue.delete(),
      refundReason:           admin.firestore.FieldValue.delete(),
      refundVisitDescription: admin.firestore.FieldValue.delete(),
    });

    const msgR6opener = await generateCaraMessage({
      audience: "family",
      context: "A family member just submitted a refund request through Evia. Acknowledge the submission warmly and let them know what happens next.",
      fallback: "Your refund request has been submitted.",
      maxTokens: 80,
    });
    await sendMessage(
      `${msgR6opener} An admin will review it within 24 hours and you'll hear back via text. ` +
      "If approved, it typically takes 3–5 business days to appear on your statement."
    );
  }
}
