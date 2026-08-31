import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";
import { answerHumanMidFlow } from "./humanReply";
import { businessTodayStr } from "../utils/scheduledTime";

const db = admin.firestore();

/**
 * Caregiver-initiated proactive cancellation flow.
 *
 * Three-step state machine:
 *   identify_shift → list upcoming shifts numbered 1..N, store JSON in session
 *   confirm_shift  → caregiver picks number; system shows shift + asks YES/NO
 *   ask_reason     → caregiver gives reason and cancels the appointment;
 *                    the appointment trigger owns family alerts and replacement
 *
 * Mirrors the pattern in caregiverSwapHandler.ts.
 */

interface CancelShift {
  index:      number;
  id:         string;
  coll:       "appointments" | "shifts";
  date:       string;
  time:       string;
  clientName: string;
  clientId:   string;
  seniorName: string;
  startTime:  string;
}

// shifts docs (booking_requests/shifts pipeline, 2026-08-30) carry
// careRecipients: [{name}] instead of a top-level seniorName field.
function seniorNameFor(coll: "appointments" | "shifts", data: FirebaseFirestore.DocumentData): string {
  if (coll === "shifts") {
    const recipients = data.careRecipients as Array<{ name?: string }> | undefined;
    return recipients?.[0]?.name || data.clientName || "the client";
  }
  return data.seniorName ?? data.clientName ?? "the client";
}

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The caregiver is in a shift cancellation flow. Current step's question: "${currentQuestion}". ` +
      "Reply YES if their message is a general question or off-topic comment unrelated to that question. " +
      "Reply NO if it is a direct answer. Only reply YES or NO.",
    text,
    5,
  );
  return result.toUpperCase().startsWith("Y");
}

async function answerMidFlow(text: string, reAsk: string): Promise<string> {
  return answerHumanMidFlow({
    audience: "caregiver",
    situation: "caregiver is canceling one of their upcoming shifts",
    text,
    reAsk,
  });
}

export async function handleCaregiverCancelShift(
  caregiverId:    string,
  caregiverName:  string,
  caregiverPhone: string,
  text:           string,
  session:        Record<string, unknown>,
  chatId:         string,
): Promise<void> {
  const step = (session.cancelStep as string) ?? "identify_shift";

  // ── identify_shift — list shifts, store candidates ─────────────────────────
  if (step === "identify_shift") {
    // Business-timezone today — UTC hid tonight's shift after 5pm PT
    const today = businessTodayStr();
    // Query both collections — a shift booked via the newer booking_requests/
    // shifts pipeline (2026-08-30) never appears in `appointments` at all.
    const [apptSnap, shiftsSnap] = await Promise.all([
      db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("status",      "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("date",        ">=", today)
        .orderBy("date", "asc")
        .limit(5)
        .get(),
      db.collection("shifts")
        .where("caregiverId", "==", caregiverId)
        .where("status",      "in", ["scheduled", "in-progress"])
        .where("date",        ">=", today)
        .orderBy("date", "asc")
        .limit(5)
        .get(),
    ]);

    if (apptSnap.empty && shiftsSnap.empty) {
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: (session.preferredLanguage as string) === "es" ? "es" : "en",
        context: "The caregiver asked to cancel a shift, but they don't have any upcoming shifts on the calendar. Gently let them know there's nothing to cancel right now.",
        fallback: "You don't have any upcoming shifts to cancel.",
        maxTokens: 60,
      }));
      await db.collection("agent_sessions").doc(caregiverPhone).update({
        cancelStep: admin.firestore.FieldValue.delete(),
      });
      return;
    }

    const merged = [
      ...apptSnap.docs.map(d => ({ doc: d, coll: "appointments" as const })),
      ...shiftsSnap.docs.map(d => ({ doc: d, coll: "shifts" as const })),
    ].sort((a, b) => String(a.doc.data().date).localeCompare(String(b.doc.data().date)));

    const shifts: CancelShift[] = merged.slice(0, 5).map(({ doc, coll }, i) => ({
      index:      i + 1,
      id:         doc.id,
      coll,
      date:       doc.data().date,
      time:       doc.data().time ?? doc.data().startTime ?? "",
      clientName: doc.data().clientName ?? "client",
      clientId:   doc.data().clientId,
      seniorName: seniorNameFor(coll, doc.data()),
      startTime:  doc.data().startTime ?? doc.data().time ?? "",
    }));

    await db.collection("agent_sessions").doc(caregiverPhone).update({
      cancelStep:       "confirm_shift",
      cancelCandidates: JSON.stringify(shifts),
      stateExpiresAt:   new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const list = shifts.map(s => `${s.index}. ${s.date} at ${s.time} — ${s.clientName}`).join("\n");
    await sendMessage(chatId,
      `Which shift do you need to cancel?\n${list}\n\nReply with the number, or CANCEL to back out.`,
    );
    return;
  }

  // ── confirm_shift — caregiver picks number; ask YES/NO ─────────────────────
  if (step === "confirm_shift") {
    const candidates: CancelShift[] = (() => {
      try { return JSON.parse((session.cancelCandidates as string) ?? "[]"); }
      catch { return []; }
    })();

    if (candidates.length === 0) {
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: (session.preferredLanguage as string) === "es" ? "es" : "en",
        context: "Something got tangled mid-flow while cancelling a shift, so you're starting that step over. Warmly reassure them and ask which shift they need to cancel.",
        fallback: "Something went wrong — let me start over. Which shift do you need to cancel?",
        maxTokens: 70,
      }));
      await db.collection("agent_sessions").doc(caregiverPhone).update({
        cancelStep:       "identify_shift",
        cancelCandidates: admin.firestore.FieldValue.delete(),
      });
      return;
    }

    // CANCEL bail-out (literal)
    if (text.trim().toUpperCase() === "CANCEL") {
      await db.collection("agent_sessions").doc(caregiverPhone).update({
        cancelStep:       admin.firestore.FieldValue.delete(),
        cancelCandidates: admin.firestore.FieldValue.delete(),
        cancelShiftId:    admin.firestore.FieldValue.delete(),
        cancelShiftColl:  admin.firestore.FieldValue.delete(),
        cancelShiftDate:  admin.firestore.FieldValue.delete(),
        cancelShiftClientId: admin.firestore.FieldValue.delete(),
        stateExpiresAt:   admin.firestore.FieldValue.delete(),
      });
      await sendMessage(chatId, "No problem — your shifts are unchanged.");
      return;
    }

    // If we already have a chosen shift, this reply is the YES/NO confirmation
    const chosenId = session.cancelShiftId as string | undefined;
    if (chosenId) {
      const list = candidates.map(s => `${s.index}. ${s.date} at ${s.time} — ${s.clientName}`).join("\n");
      const reAsk = `Cancel this shift? Reply YES to cancel, or NO to keep it.`;
      if (await isQuestionOrOther(text, reAsk)) {
        await sendMessage(chatId, await answerMidFlow(text, reAsk));
        return;
      }
      const decision = await parseWithClaude(
        '"yes", "yeah", "confirm", "do it", "cancel it" → YES. ' +
        '"no", "wait", "never mind", "keep it", "back" → NO. ' +
        'Reply with exactly YES or NO.',
        text,
        5,
      );
      if (decision === "YES") {
        await db.collection("agent_sessions").doc(caregiverPhone).update({
          cancelStep:     "ask_reason",
          stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await sendMessage(chatId,
          "Got it. What's the reason for cancelling? (Illness, schedule conflict, family emergency, etc.) " +
          "This helps us let the family know.",
        );
        return;
      }
      // NO — back out, keep candidates so they can pick a different one
      await db.collection("agent_sessions").doc(caregiverPhone).update({
        cancelShiftId:       admin.firestore.FieldValue.delete(),
        cancelShiftColl:     admin.firestore.FieldValue.delete(),
        cancelShiftDate:     admin.firestore.FieldValue.delete(),
        cancelShiftClientId: admin.firestore.FieldValue.delete(),
      });
      await sendMessage(chatId,
        `Okay — keeping that one. ${list}\n\nReply with another number, or CANCEL to back out entirely.`,
      );
      return;
    }

    // No chosen shift yet — this reply should be a number selection
    const reAskPick = `Reply with the number of the shift to cancel (1–${candidates.length}), or CANCEL to back out.`;
    if (await isQuestionOrOther(text, reAskPick)) {
      await sendMessage(chatId, await answerMidFlow(text, reAskPick));
      return;
    }

    const pick = parseInt(text.trim(), 10);
    const shift = candidates.find(s => s.index === pick);
    if (!shift) {
      await sendMessage(chatId, `Please reply with a number between 1 and ${candidates.length}, or CANCEL to back out.`);
      return;
    }

    await db.collection("agent_sessions").doc(caregiverPhone).update({
      cancelShiftId:       shift.id,
      cancelShiftColl:     shift.coll,
      cancelShiftDate:     shift.date,
      cancelShiftClientId: shift.clientId,
      stateExpiresAt:      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId,
      `You want to cancel: ${shift.date} at ${shift.time} with the ${shift.clientName} family.\n\n` +
      `Cancel this shift? Reply YES to cancel, or NO to keep it.`,
    );
    return;
  }

  // ── ask_reason — capture reason, finalize cancellation ─────────────────────
  if (step === "ask_reason") {
    const reAsk = "What's the reason for cancelling? (illness, conflict, emergency, etc.)";
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk));
      return;
    }

    const reasonRaw = await parseWithClaude(
      'Summarize the caregiver\'s cancellation reason in a short phrase (e.g. "illness", "family emergency", "schedule conflict", "transportation issue"). ' +
        'If unclear or missing, reply: unspecified. Reply with only the short phrase.',
      text,
      30,
    );
    const reason = reasonRaw && reasonRaw !== "__parse_error__" ? reasonRaw : "unspecified";

    const shiftId   = session.cancelShiftId as string;
    const shiftColl = (session.cancelShiftColl as string) === "shifts" ? "shifts" : "appointments";
    const shiftDate = session.cancelShiftDate as string;

    if (!shiftId) {
      await sendMessage(chatId, await generateCaraMessage({
        audience: "caregiver",
        language: (session.preferredLanguage as string) === "es" ? "es" : "en",
        context: "Something went wrong while cancelling, so nothing changed — their shifts are all still as they were. Warmly reassure them and ask them to try again.",
        fallback: "Something went wrong — your shifts are unchanged. Please try again.",
        maxTokens: 70,
      }));
      await db.collection("agent_sessions").doc(caregiverPhone).update({
        cancelStep:          admin.firestore.FieldValue.delete(),
        cancelCandidates:    admin.firestore.FieldValue.delete(),
        cancelShiftId:       admin.firestore.FieldValue.delete(),
        cancelShiftColl:     admin.firestore.FieldValue.delete(),
        cancelShiftDate:     admin.firestore.FieldValue.delete(),
        cancelShiftClientId: admin.firestore.FieldValue.delete(),
        cancelReason:        admin.firestore.FieldValue.delete(),
        stateExpiresAt:      admin.firestore.FieldValue.delete(),
      });
      return;
    }

    // Load the visit for context — shiftColl resolves to whichever
    // collection this candidate was listed from (see identify_shift above).
    const apptSnap = await db.collection(shiftColl).doc(shiftId).get();
    const apptData = apptSnap.data() ?? {};
    const seniorName = seniorNameFor(shiftColl, apptData);

    // Mark the visit cancelled
    await db.collection(shiftColl).doc(shiftId).update({
      status:              "cancelled",
      cancelledBy:         "caregiver",
      cancelledAt:         new Date().toISOString(),
      cancellationReason:  reason,
      cancelledByCaregiverId:   caregiverId,
      cancelledByCaregiverName: caregiverName,
    });

    // Clear flow state
    await db.collection("agent_sessions").doc(caregiverPhone).update({
      cancelStep:          admin.firestore.FieldValue.delete(),
      cancelCandidates:    admin.firestore.FieldValue.delete(),
      cancelShiftId:       admin.firestore.FieldValue.delete(),
      cancelShiftColl:     admin.firestore.FieldValue.delete(),
      cancelShiftDate:     admin.firestore.FieldValue.delete(),
      cancelShiftClientId: admin.firestore.FieldValue.delete(),
      cancelReason:        admin.firestore.FieldValue.delete(),
      stateExpiresAt:      admin.firestore.FieldValue.delete(),
    });

    // Acknowledge caregiver warmly
    const cgFirstName = caregiverName.split(" ")[0] || "you";
    const ackMsg = await generateCaraMessage({
      audience: "caregiver",
      context:
        `${cgFirstName} just cancelled their ${shiftDate} shift with ${seniorName} (reason: ${reason}). ` +
        `Write a brief, understanding acknowledgment — no judgment, let them know the family will be notified ` +
        `and you're already working on coverage. Be warm.`,
      fallback:
        `Got it, ${cgFirstName} — I'll let the ${seniorName} family know and start working on coverage for ${shiftDate}. ` +
        `Thanks for letting me know ahead of time.`,
      maxTokens: 100,
    });
    await sendMessage(chatId, ackMsg);

    return;
  }
}
